import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  createReadStream,
  rmSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import { cached, cacheDelete } from "./cache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.TRANSIT_DATA_DIR || join(__dirname, "../../data");
/** In-memory TTL for parsed routes/static indexes. */
const STATIC_TTL_MS = 6 * 60 * 60 * 1000;
/** How often to re-check zip age on disk (download still gated by ZIP_MAX_AGE_MS). */
const ZIP_CHECK_TTL_MS = 15 * 60 * 1000;
const ZIP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function parseCsv(text) {
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    bom: true,
  });
}

async function downloadZip(url, destPath) {
  mkdirSync(dirname(destPath), { recursive: true });
  const res = await fetch(url, {
    headers: { "User-Agent": "transit-api/1.0" },
    signal: AbortSignal.timeout(120000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`GTFS download failed ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
  return destPath;
}

function readZipText(zip, name) {
  const entry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith(name.toLowerCase()));
  if (!entry) return null;
  return entry.getData().toString("utf8");
}

function findZipEntry(zip, name) {
  return zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith(name.toLowerCase())) || null;
}

/**
 * Ensure the agency zip is on disk (refresh if older than 24h).
 * Shared by routes-only and full static index loaders.
 */
export async function ensureZip(agency) {
  return cached(`zip:${agency.slug}`, ZIP_CHECK_TTL_MS, async () => {
    const dir = join(DATA_DIR, agency.slug);
    mkdirSync(dir, { recursive: true });
    const zipPath = join(dir, "gtfs.zip");
    const metaPath = join(dir, "meta.json");

    const needsDownload =
      !existsSync(zipPath) ||
      !existsSync(metaPath) ||
      Date.now() - Number(JSON.parse(readFileSync(metaPath, "utf8")).downloadedAt || 0) > ZIP_MAX_AGE_MS;

    if (needsDownload) {
      console.log(`[gtfs] Downloading static GTFS for ${agency.slug}`);
      await downloadZip(agency.gtfsStaticUrl, zipPath);
      writeFileSync(metaPath, JSON.stringify({ downloadedAt: Date.now(), url: agency.gtfsStaticUrl }));
      // Invalidate per-route shape caches when the zip refreshes.
      for (const name of ["route-shapes", "route-shapes-v2", "route-stops-v1"]) {
        const cacheDir = join(dir, name);
        if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true, force: true });
      }
      for (const name of ["shapes.txt", "stop_times.txt"]) {
        const extract = join(dir, name);
        if (existsSync(extract)) rmSync(extract, { force: true });
      }
      // Drop in-memory indexes built from the previous zip.
      cacheDelete(`routes:${agency.slug}`);
      cacheDelete(`static:${agency.slug}`);
    }

    return zipPath;
  });
}

/** Zip + entry sizes without fully parsing CSVs. */
export async function inspectStaticFeed(agency) {
  const zipPath = await ensureZip(agency);
  const zip = new AdmZip(zipPath);
  const zipBytes = statSync(zipPath).size;
  const entries = {};
  for (const name of ["routes.txt", "trips.txt", "shapes.txt"]) {
    const entry = findZipEntry(zip, name);
    entries[name] = entry
      ? { compressed: entry.header?.compressedSize ?? null, uncompressed: entry.header?.size ?? null }
      : null;
  }
  return { zipPath, zipBytes, entries };
}

function parseRoutes(routesText) {
  if (!routesText) throw new Error("routes.txt missing from GTFS");
  return parseCsv(routesText).map((r) => ({
    id: String(r.route_id),
    shortName: r.route_short_name || "",
    longName: r.route_long_name || "",
    color: (r.route_color || "3388ff").replace(/^#/, ""),
    textColor: (r.route_text_color || "ffffff").replace(/^#/, ""),
  }));
}

/**
 * Lightweight routes list for the sidebar — only routes.txt.
 * Avoids parsing trips/shapes so agency switch stays fast.
 */
export async function getRoutesList(agency) {
  await ensureZip(agency); // re-check zip age; may invalidate routes/static caches
  return cached(`routes:${agency.slug}`, STATIC_TTL_MS, async () => {
    const zipPath = join(DATA_DIR, agency.slug, "gtfs.zip");
    const zip = new AdmZip(zipPath);
    const routes = parseRoutes(readZipText(zip, "routes.txt"));
    return {
      agencySlug: agency.slug,
      builtAt: new Date().toISOString(),
      routes,
      stats: { routeCount: routes.length },
    };
  });
}

function buildCoreIndex(agency, zipPath) {
  const zip = new AdmZip(zipPath);
  const routes = parseRoutes(readZipText(zip, "routes.txt"));
  const routeIds = new Set(routes.map((r) => r.id));
  const tripsText = readZipText(zip, "trips.txt");

  const tripToRoute = new Map();
  /** @type {Map<string, object>} */
  const tripDetails = new Map();
  /** @type {Map<string, Set<string>>} */
  const routeToShapeIds = new Map();
  const neededShapeIds = new Set();
  /** @type {Map<string, string>} */
  const stopNames = new Map();
  /** @type {Map<string, { id: string, name: string, lat: number, lon: number, parentStation: string|null, locationType: string, code: string|null }>} */
  const stops = new Map();
  /** stop_code → stop_id (511 RT often puts stop_code in GTFS-RT stopId). */
  /** @type {Map<string, string>} */
  const stopCodeToId = new Map();
  /** parent_station → child stop_ids (for arrivals matching). */
  /** @type {Map<string, string[]>} */
  const childrenByParent = new Map();

  const stopsText = readZipText(zip, "stops.txt");
  if (stopsText) {
    for (const s of parseCsv(stopsText)) {
      const id = String(s.stop_id || "").trim();
      if (!id) continue;
      const name = String(s.stop_name || "").trim();
      if (name) stopNames.set(id, name);
      const code = String(s.stop_code || "").trim() || null;
      if (code) {
        stopCodeToId.set(code, id);
        if (name) stopNames.set(code, name);
      }
      const lat = Number(s.stop_lat);
      const lon = Number(s.stop_lon);
      const locationType = String(s.location_type ?? "").trim();
      const parentStation = String(s.parent_station || "").trim() || null;
      // Boarding stops/platforms (0/blank) and boarding areas (4); skip entrances/nodes.
      const boardable = locationType === "" || locationType === "0" || locationType === "4";
      if (boardable && Number.isFinite(lat) && Number.isFinite(lon)) {
        stops.set(id, {
          id,
          name: name || id,
          lat,
          lon,
          parentStation,
          locationType: locationType || "0",
          code,
        });
      }
      if (parentStation) {
        if (!childrenByParent.has(parentStation)) childrenByParent.set(parentStation, []);
        childrenByParent.get(parentStation).push(id);
      }
    }
  }

  if (tripsText) {
    for (const t of parseCsv(tripsText)) {
      const tripId = String(t.trip_id || "");
      const routeId = String(t.route_id || "");
      const shapeId = t.shape_id ? String(t.shape_id) : "";
      if (!tripId || !routeId) continue;
      tripToRoute.set(tripId, routeId);
      tripDetails.set(tripId, {
        headsign: String(t.trip_headsign || "").trim() || null,
        directionName: String(t.trip_direction_name || "").trim() || null,
        directionId: t.direction_id !== undefined && t.direction_id !== "" ? String(t.direction_id) : null,
        blockId: String(t.block_id || "").trim() || null,
        shapeId: shapeId || null,
        wheelchairAccessible:
          t.wheelchair_accessible !== undefined && t.wheelchair_accessible !== ""
            ? String(t.wheelchair_accessible)
            : null,
        bikesAllowed:
          t.bikes_allowed !== undefined && t.bikes_allowed !== "" ? String(t.bikes_allowed) : null,
      });
      if (shapeId) {
        neededShapeIds.add(shapeId);
        if (!routeToShapeIds.has(routeId)) routeToShapeIds.set(routeId, new Set());
        routeToShapeIds.get(routeId).add(shapeId);
      }
    }
  }

  return {
    agencySlug: agency.slug,
    builtAt: new Date().toISOString(),
    routes,
    routeIds,
    tripToRoute,
    tripDetails,
    stopNames,
    stops,
    stopCodeToId,
    childrenByParent,
    routeShapes: {},
    routeStops: {},
    shapesReady: false,
    _zipPath: zipPath,
    _routeToShapeIds: routeToShapeIds,
    _neededShapeIds: neededShapeIds,
    stats: {
      routeCount: routes.length,
      tripCount: tripToRoute.size,
      stopCount: stopNames.size,
      boardableStopCount: stops.size,
      shapeRouteCount: 0,
      shapeFeatureCount: 0,
    },
  };
}

/**
 * Core static index (routes + trips) for vehicle matching.
 * Shapes are loaded per-route on demand.
 */
export async function getStaticIndex(agency) {
  await ensureZip(agency);
  return cached(`static:${agency.slug}`, STATIC_TTL_MS, async () => {
    const zipPath = join(DATA_DIR, agency.slug, "gtfs.zip");
    return buildCoreIndex(agency, zipPath);
  });
}

function agencyDataDir(staticIndex) {
  return join(DATA_DIR, staticIndex.agencySlug);
}

/** Extract shapes.txt from the zip once (streamable on later reads). */
function ensureShapesTxt(staticIndex) {
  const outPath = join(agencyDataDir(staticIndex), "shapes.txt");
  if (existsSync(outPath) && statSync(outPath).size > 0) return outPath;
  const zip = new AdmZip(staticIndex._zipPath);
  const entry = findZipEntry(zip, "shapes.txt");
  if (!entry) return null;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, entry.getData());
  return outPath;
}

/**
 * Stream shapes.txt and collect points only for the given shape_ids.
 * Keeps memory proportional to the requested routes, not the whole feed.
 */
async function collectShapePoints(shapesPath, wantedShapeIds) {
  /** @type {Map<string, [number, number, number][]>} */
  const shapePoints = new Map();
  for (const id of wantedShapeIds) shapePoints.set(id, []);
  if (!wantedShapeIds.size || !shapesPath) return shapePoints;

  const rl = createInterface({
    input: createReadStream(shapesPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let iShape = -1;
  let iLat = -1;
  let iLon = -1;
  let iSeq = -1;
  let headerDone = false;

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(",");
    if (!headerDone) {
      const header = cols.map((c) => c.trim().replace(/^\uFEFF/, "").toLowerCase());
      iShape = header.indexOf("shape_id");
      iLat = header.indexOf("shape_pt_lat");
      iLon = header.indexOf("shape_pt_lon");
      iSeq = header.indexOf("shape_pt_sequence");
      headerDone = true;
      if (iShape < 0 || iLat < 0 || iLon < 0) break;
      continue;
    }
    const shapeId = cols[iShape];
    if (!wantedShapeIds.has(shapeId)) continue;
    const lat = Number(cols[iLat]);
    const lon = Number(cols[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    shapePoints.get(shapeId).push([iSeq >= 0 ? Number(cols[iSeq]) || 0 : 0, lon, lat]);
  }

  return shapePoints;
}

function featuresForRoute(routeId, shapeIds, shapePoints) {
  const features = [];
  for (const sid of shapeIds) {
    const pts = shapePoints.get(sid);
    if (!pts || pts.length < 2) continue;
    pts.sort((a, b) => a[0] - b[0]);
    features.push({
      type: "Feature",
      properties: { routeId, shapeId: sid },
      geometry: {
        type: "LineString",
        coordinates: pts.map((p) => [p[1], p[2]]),
      },
    });
  }
  // All patterns for the route (inbound/outbound/branches) — same for every agency.
  features.sort((a, b) => b.geometry.coordinates.length - a.geometry.coordinates.length);
  return features;
}

function readDiskRouteShapes(staticIndex, routeId) {
  const path = routeShapeCachePath(staticIndex, routeId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeDiskRouteShapes(staticIndex, routeId, features) {
  const path = routeShapeCachePath(staticIndex, routeId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(features));
}

function routeShapeCachePath(staticIndex, routeId) {
  // v2 = full multi-shape geometries (v1 cached only the longest LineString).
  return join(agencyDataDir(staticIndex), "route-shapes-v2", `${encodeURIComponent(routeId)}.json`);
}

/**
 * Load shapes for specific route IDs only (memory + disk cache).
 * Scans shapes.txt once per batch of still-missing routes; concurrent callers share the scan.
 */
export async function loadShapesForRouteIds(staticIndex, routeIds) {
  const ids = [...new Set(routeIds.map(String))];

  const hydrate = () => {
    const missing = [];
    for (const routeId of ids) {
      if (staticIndex.routeShapes[routeId]) continue;
      const fromDisk = readDiskRouteShapes(staticIndex, routeId);
      if (fromDisk) {
        staticIndex.routeShapes[routeId] = fromDisk;
        continue;
      }
      missing.push(routeId);
    }
    return missing;
  };

  let missing = hydrate();
  while (missing.length) {
    if (staticIndex._shapeScan) {
      await staticIndex._shapeScan;
      missing = hydrate();
      continue;
    }

    const batch = missing;
    staticIndex._shapeScan = (async () => {
      const shapesPath = ensureShapesTxt(staticIndex);
      const wanted = new Set();
      for (const routeId of batch) {
        const set = staticIndex._routeToShapeIds.get(routeId);
        if (set) for (const sid of set) wanted.add(sid);
      }
      const shapePoints = await collectShapePoints(shapesPath, wanted);
      for (const routeId of batch) {
        const shapeIds = staticIndex._routeToShapeIds.get(routeId) || new Set();
        const features = featuresForRoute(routeId, shapeIds, shapePoints);
        staticIndex.routeShapes[routeId] = features;
        writeDiskRouteShapes(staticIndex, routeId, features);
      }
      staticIndex.stats.shapeRouteCount = Object.keys(staticIndex.routeShapes).length;
      staticIndex.stats.shapeFeatureCount = Object.values(staticIndex.routeShapes).reduce(
        (n, f) => n + (f?.length || 0),
        0,
      );
    })().finally(() => {
      staticIndex._shapeScan = null;
    });

    await staticIndex._shapeScan;
    missing = hydrate();
  }

  const features = [];
  for (const routeId of ids) {
    const routeFeatures = staticIndex.routeShapes[routeId];
    if (Array.isArray(routeFeatures)) features.push(...routeFeatures);
  }
  return { type: "FeatureCollection", features };
}

/** Used by check script — load every route's primary shape (still one scan). */
export async function ensureRouteShapes(staticIndex) {
  const allIds = [...(staticIndex._routeToShapeIds?.keys() || [])];
  await loadShapesForRouteIds(staticIndex, allIds);
  staticIndex.shapesReady = true;
  return staticIndex;
}

/** Extract stop_times.txt once for streaming. */
function ensureStopTimesTxt(staticIndex) {
  const outPath = join(agencyDataDir(staticIndex), "stop_times.txt");
  if (existsSync(outPath) && statSync(outPath).size > 0) return outPath;
  const zip = new AdmZip(staticIndex._zipPath);
  const entry = findZipEntry(zip, "stop_times.txt");
  if (!entry) return null;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, entry.getData());
  return outPath;
}

function routeStopsCachePath(staticIndex, routeId) {
  return join(agencyDataDir(staticIndex), "route-stops-v1", `${encodeURIComponent(routeId)}.json`);
}

function readDiskRouteStops(staticIndex, routeId) {
  const path = routeStopsCachePath(staticIndex, routeId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeDiskRouteStops(staticIndex, routeId, stopIds) {
  const path = routeStopsCachePath(staticIndex, routeId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(stopIds));
}

/**
 * Stream stop_times.txt and collect stop_ids only for the given route IDs.
 */
async function collectStopIdsByRoute(stopTimesPath, tripToRoute, wantedRouteIds) {
  /** @type {Map<string, Set<string>>} */
  const byRoute = new Map();
  for (const id of wantedRouteIds) byRoute.set(id, new Set());
  if (!wantedRouteIds.size || !stopTimesPath) return byRoute;

  const rl = createInterface({
    input: createReadStream(stopTimesPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let iTrip = -1;
  let iStop = -1;
  let headerDone = false;

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(",");
    if (!headerDone) {
      const header = cols.map((c) => c.trim().replace(/^\uFEFF/, "").toLowerCase());
      iTrip = header.indexOf("trip_id");
      iStop = header.indexOf("stop_id");
      headerDone = true;
      if (iTrip < 0 || iStop < 0) break;
      continue;
    }
    const tripId = cols[iTrip];
    const routeId = tripToRoute.get(tripId);
    if (!routeId || !wantedRouteIds.has(routeId)) continue;
    const stopId = cols[iStop];
    if (!stopId) continue;
    byRoute.get(routeId).add(stopId);
  }

  return byRoute;
}

/**
 * Load boardable stops for specific route IDs (memory + disk cache).
 * Returns merged list with routeIds on each stop.
 */
export async function loadStopsForRouteIds(staticIndex, routeIds) {
  const ids = [...new Set(routeIds.map(String))];
  if (!staticIndex.routeStops) staticIndex.routeStops = {};

  const hydrate = () => {
    const missing = [];
    for (const routeId of ids) {
      if (staticIndex.routeStops[routeId]) continue;
      const fromDisk = readDiskRouteStops(staticIndex, routeId);
      if (fromDisk) {
        staticIndex.routeStops[routeId] = fromDisk;
        continue;
      }
      missing.push(routeId);
    }
    return missing;
  };

  let missing = hydrate();
  while (missing.length) {
    if (staticIndex._stopScan) {
      await staticIndex._stopScan;
      missing = hydrate();
      continue;
    }

    const batch = missing;
    staticIndex._stopScan = (async () => {
      const stopTimesPath = ensureStopTimesTxt(staticIndex);
      const wanted = new Set(batch);
      const byRoute = await collectStopIdsByRoute(stopTimesPath, staticIndex.tripToRoute, wanted);
      for (const routeId of batch) {
        const stopIds = [...(byRoute.get(routeId) || [])];
        staticIndex.routeStops[routeId] = stopIds;
        writeDiskRouteStops(staticIndex, routeId, stopIds);
      }
    })().finally(() => {
      staticIndex._stopScan = null;
    });

    await staticIndex._stopScan;
    missing = hydrate();
  }

  /** @type {Map<string, { id: string, name: string, lat: number, lon: number, routeIds: string[] }>} */
  const merged = new Map();
  const stops = staticIndex.stops || new Map();

  for (const routeId of ids) {
    const stopIds = staticIndex.routeStops[routeId] || [];
    for (const stopId of stopIds) {
      const s = stops.get(stopId);
      if (!s) continue;
      let row = merged.get(stopId);
      if (!row) {
        row = { id: s.id, name: s.name, lat: s.lat, lon: s.lon, routeIds: [] };
        merged.set(stopId, row);
      }
      if (!row.routeIds.includes(routeId)) row.routeIds.push(routeId);
    }
  }

  return {
    agency: staticIndex.agencySlug,
    stops: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
  };
}
