import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { getAdapter } from "../agencies/index.js";
import { getAgencyApiKey } from "../config/secrets.js";
import { cached } from "./cache.js";

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

const VEHICLE_STATUS = {
  0: "INCOMING_AT",
  1: "STOPPED_AT",
  2: "IN_TRANSIT_TO",
};

const OCCUPANCY = {
  0: "EMPTY",
  1: "MANY_SEATS_AVAILABLE",
  2: "FEW_SEATS_AVAILABLE",
  3: "STANDING_ROOM_ONLY",
  4: "CRUSHED_STANDING_ROOM_ONLY",
  5: "FULL",
  6: "NOT_ACCEPTING_PASSENGERS",
  7: "NO_DATA_AVAILABLE",
  8: "NOT_BOARDABLE",
};

const CONGESTION = {
  0: "UNKNOWN_CONGESTION_LEVEL",
  1: "RUNNING_SMOOTHLY",
  2: "STOP_AND_GO",
  3: "CONGESTION",
  4: "SEVERE_CONGESTION",
};

/**
 * Fetch + decode vehicle positions for an agency (cached ~30s).
 */
export async function getVehicleFeed(agency) {
  return cached(`vehicles:${agency.slug}`, 30_000, async () => {
    const adapter = getAdapter(agency.slug);
    const apiKey = await getAgencyApiKey(agency);
    const url = adapter.buildVehicleFeedUrl(agency, apiKey);
    const headers = {
      "User-Agent": "transit-api/1.0",
      Accept: "application/x-protobuf, application/octet-stream, */*",
      ...(typeof adapter.buildVehicleFeedHeaders === "function"
        ? adapter.buildVehicleFeedHeaders(agency, apiKey)
        : {}),
    };
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`RT feed ${res.status} for ${agency.slug}: ${body.slice(0, 200)}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const feed = FeedMessage.decode(buffer);
    return { feed, fetchedAt: new Date().toISOString(), url: redactFeedUrl(url) };
  });
}

/**
 * Fetch + decode trip updates (cached ~30s). Returns null if no URL configured.
 */
export async function getTripUpdateFeed(agency) {
  if (!agency.tripUpdatesUrl) return null;
  return cached(`tripupdates:${agency.slug}`, 30_000, async () => {
    const adapter = getAdapter(agency.slug);
    const apiKey = await getAgencyApiKey(agency);
    const buildUrl =
      typeof adapter.buildTripUpdateFeedUrl === "function"
        ? adapter.buildTripUpdateFeedUrl.bind(adapter)
        : defaultAdapterBuildTripUpdate;
    const url = buildUrl(agency, apiKey);
    const headers = {
      "User-Agent": "transit-api/1.0",
      Accept: "application/x-protobuf, application/octet-stream, */*",
      ...(typeof adapter.buildVehicleFeedHeaders === "function"
        ? adapter.buildVehicleFeedHeaders(agency, apiKey)
        : {}),
    };
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`TripUpdates ${res.status} for ${agency.slug}: ${body.slice(0, 200)}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const feed = FeedMessage.decode(buffer);
    return { feed, fetchedAt: new Date().toISOString(), url: redactFeedUrl(url) };
  });
}

function defaultAdapterBuildTripUpdate(agency, apiKey) {
  const url = new URL(agency.tripUpdatesUrl);
  if (apiKey && !url.searchParams.has("api_key") && !url.searchParams.has("apiKey")) {
    url.searchParams.set("api_key", apiKey);
  }
  if (agency.rtAgencyCode) url.searchParams.set("agency", agency.rtAgencyCode);
  return url.toString();
}

function toUnixSeconds(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value?.toNumber === "function") {
    const n = value.toNumber();
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function redactFeedUrl(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/key|token|secret|password|auth/i.test(key)) u.searchParams.set(key, "REDACTED");
    }
    return u.toString();
  } catch {
    return String(url || "").replace(/([?&][^=]*?(?:key|token|secret|password|auth)[^=]*?=)[^&]*/gi, "$1REDACTED");
  }
}

function enumLabel(value, map) {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const s = value.trim();
    return s || null;
  }
  if (typeof value === "number" && map[value] != null) return map[value];
  if (typeof value?.toNumber === "function") {
    const n = value.toNumber();
    if (map[n] != null) return map[n];
  }
  return String(value);
}

/**
 * Exact trip_id, then CapMetro-style prefix match on the same route/direction.
 */
function lookupTripDetails(tripId, trip, staticIndex) {
  const tripDetails = staticIndex.tripDetails || new Map();
  if (tripId && tripDetails.has(tripId)) return tripDetails.get(tripId);
  if (!tripId) return null;

  const base = tripId.includes("_") ? tripId.split("_")[0] : null;
  if (!base) return null;

  const routeId = trip.routeId != null && trip.routeId !== "" ? String(trip.routeId) : null;
  const dirId =
    trip.directionId !== undefined && trip.directionId !== null && trip.directionId !== ""
      ? String(trip.directionId)
      : null;

  let loose = null;
  for (const [id, details] of tripDetails) {
    if (!id.startsWith(`${base}_`) && id !== base) continue;
    if (routeId && staticIndex.tripToRoute.get(id) !== routeId) continue;
    if (dirId != null && details.directionId != null && details.directionId !== dirId) {
      if (!loose) loose = details;
      continue;
    }
    return details;
  }
  return loose;
}

/**
 * Map feed entities to public vehicle objects for selected routes.
 * Includes whatever the agency RT feed provides; nulls omitted only where unused.
 */
export function filterVehicles(agency, feedBundle, staticIndex, routeFilter) {
  const adapter = getAdapter(agency.slug);
  const wanted = routeFilter?.size ? routeFilter : null;
  const vehicles = [];
  const stopNames = staticIndex.stopNames || new Map();

  for (const entity of feedBundle.feed.entity || []) {
    const v = entity.vehicle;
    if (!v?.position) continue;
    const lat = v.position.latitude;
    const lon = v.position.longitude;
    // Skip missing / Null Island placeholders (common in schedule-based RT entities).
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01) continue;

    const { routeId } = adapter.extractRouteId(entity, staticIndex);
    if (!routeId) continue;
    const normalized = adapter.normalizeRouteId(routeId);
    if (wanted && !wanted.has(normalized)) continue;

    const trip = v.trip || {};
    const tripId = trip.tripId ? String(trip.tripId) : null;
    const details = lookupTripDetails(tripId, trip, staticIndex);
    const vehicleId = v.vehicle?.id ? String(v.vehicle.id) : null;
    const label = v.vehicle?.label ? String(v.vehicle.label) : null;
    const licensePlate = v.vehicle?.licensePlate ? String(v.vehicle.licensePlate) : null;
    const ts = toUnixSeconds(v.timestamp);
    const stopId = v.stopId ? String(v.stopId) : null;
    const currentStatus = enumLabel(v.currentStatus, VEHICLE_STATUS);
    const occupancyStatus = enumLabel(v.occupancyStatus, OCCUPANCY);
    const congestionLevel = enumLabel(v.congestionLevel, CONGESTION);
    const occupancyPercentage =
      v.occupancyPercentage != null && Number.isFinite(Number(v.occupancyPercentage))
        ? Number(v.occupancyPercentage)
        : null;
    const currentStopSequence =
      v.currentStopSequence != null && Number.isFinite(Number(v.currentStopSequence))
        ? Number(v.currentStopSequence)
        : null;
    const odometer =
      v.position.odometer != null && Number.isFinite(Number(v.position.odometer))
        ? Math.round(Number(v.position.odometer))
        : null;
    const tripDirectionId =
      trip.directionId !== undefined && trip.directionId !== null && trip.directionId !== ""
        ? String(trip.directionId)
        : null;

    vehicles.push({
      id: String(vehicleId || entity.id || label || `${normalized}-${vehicles.length}`),
      vehicleId,
      label,
      licensePlate,
      routeId: normalized,
      tripId,
      startDate: trip.startDate ? String(trip.startDate) : null,
      startTime: trip.startTime ? String(trip.startTime) : null,
      lat,
      lon,
      /** Degrees clockwise from true north (GTFS-RT). Null if feed omits it. */
      bearing: Number.isFinite(v.position.bearing) ? Math.round(v.position.bearing) : null,
      /** Meters per second (GTFS-RT). Null if feed omits it. */
      speed: Number.isFinite(v.position.speed) ? Math.round(v.position.speed * 10) / 10 : null,
      odometer,
      timestamp: ts,
      updatedAt: ts ? new Date(ts * 1000).toISOString() : null,
      currentStatus,
      stopId,
      stopName: stopId ? stopNames.get(stopId) || null : null,
      currentStopSequence,
      occupancyStatus,
      occupancyPercentage,
      congestionLevel,
      headsign: details?.headsign || null,
      directionName: details?.directionName || null,
      directionId: details?.directionId ?? tripDirectionId,
      blockId: details?.blockId || null,
      shapeId: details?.shapeId || null,
      wheelchairAccessible: details?.wheelchairAccessible ?? null,
      bikesAllowed: details?.bikesAllowed ?? null,
    });
  }

  return {
    vehicles,
    fetchedAt: feedBundle.fetchedAt,
    vehicleCount: vehicles.length,
  };
}

/**
 * IDs that match a clicked stop in TripUpdates.
 * Keep this minimal: the stop_id, its stop_code (511 uses codes in RT),
 * and GTFS parent/child links when present. Opposite directions are separate
 * stops — click the other dot for the other way.
 */
function expandStopIds(stopId, staticIndex) {
  const ids = new Set();
  const add = (raw) => {
    if (raw == null || raw === "") return;
    const id = String(raw);
    ids.add(id);
    const stop = staticIndex.stops?.get(id);
    if (stop?.code) ids.add(String(stop.code));
    const viaCode = staticIndex.stopCodeToId?.get(id);
    if (viaCode) {
      ids.add(viaCode);
      const mapped = staticIndex.stops?.get(viaCode);
      if (mapped?.code) ids.add(String(mapped.code));
    }
  };

  add(stopId);
  const children = staticIndex.childrenByParent?.get(stopId);
  if (children) for (const c of children) add(c);
  const stop =
    staticIndex.stops?.get(stopId) ||
    staticIndex.stops?.get(staticIndex.stopCodeToId?.get(String(stopId)));
  if (stop?.parentStation) {
    add(stop.parentStation);
    const siblings = staticIndex.childrenByParent?.get(stop.parentStation);
    if (siblings) for (const c of siblings) add(c);
  }
  return ids;
}

/**
 * Real-time arrivals at a stop from GTFS-RT TripUpdates.
 */
export function filterArrivals(agency, feedBundle, staticIndex, stopId, routeFilter) {
  const adapter = getAdapter(agency.slug);
  const wantedStops = expandStopIds(stopId, staticIndex);
  const wantedRoutes = routeFilter?.size ? routeFilter : null;
  const now = Math.floor(Date.now() / 1000);
  const arrivals = [];

  for (const entity of feedBundle.feed.entity || []) {
    const tu = entity.tripUpdate;
    if (!tu) continue;
    const trip = tu.trip || {};
    const tripId = trip.tripId ? String(trip.tripId) : null;
    const { routeId } = adapter.extractRouteId(entity, staticIndex);
    if (!routeId) continue;
    const normalized = adapter.normalizeRouteId(routeId);
    if (wantedRoutes && !wantedRoutes.has(normalized)) continue;

    const details = lookupTripDetails(tripId, trip, staticIndex);

    for (const stu of tu.stopTimeUpdate || []) {
      const sid = stu.stopId ? String(stu.stopId) : null;
      if (!sid || !wantedStops.has(sid)) continue;

      const arrivalTime = toUnixSeconds(stu.arrival?.time);
      const departureTime = toUnixSeconds(stu.departure?.time);
      const when = arrivalTime ?? departureTime;
      // Drop predictions more than ~1 minute in the past.
      if (when != null && when < now - 60) continue;

      let delay = null;
      if (stu.arrival?.delay != null && Number.isFinite(Number(stu.arrival.delay))) {
        delay = Number(stu.arrival.delay);
      } else if (stu.departure?.delay != null && Number.isFinite(Number(stu.departure.delay))) {
        delay = Number(stu.departure.delay);
      }

      arrivals.push({
        routeId: normalized,
        tripId,
        headsign: details?.headsign || null,
        stopId: sid,
        arrivalTime,
        departureTime,
        delay,
        scheduleRelationship: enumLabel(stu.scheduleRelationship, {
          0: "SCHEDULED",
          1: "SKIPPED",
          2: "NO_DATA",
          3: "UNSCHEDULED",
        }),
      });
    }
  }

  arrivals.sort((a, b) => {
    const ta = a.arrivalTime ?? a.departureTime ?? Number.POSITIVE_INFINITY;
    const tb = b.arrivalTime ?? b.departureTime ?? Number.POSITIVE_INFINITY;
    return ta - tb;
  });

  const stop = staticIndex.stops?.get(stopId);
  const stopName =
    stop?.name || staticIndex.stopNames?.get(stopId) || null;

  return {
    agency: agency.slug,
    stopId: String(stopId),
    stopName,
    fetchedAt: feedBundle.fetchedAt,
    realtime: true,
    arrivals,
  };
}
