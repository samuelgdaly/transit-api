import { getAgency, loadAgencies } from "../src/config/sheet.js";
import { inspectStaticFeed, getStaticIndex, ensureRouteShapes } from "../src/gtfs/static.js";
import { getVehicleFeed } from "../src/gtfs/realtime.js";
import { getAdapter } from "../src/agencies/index.js";
import { getAgencyApiKey } from "../src/config/secrets.js";

const args = process.argv.slice(2);
const allowLow = args.includes("--allow-low");
const skipShapes = args.includes("--skip-shapes");
const slug = args.find((a) => !a.startsWith("--"));

if (!slug) {
  console.error("Usage: npm run check -- <agency-slug> [--allow-low] [--skip-shapes]");
  process.exit(2);
}

const MATCH_THRESHOLD = 0.8;

/** Soft warn / hard fail sized for Cloud Run 1Gi + 768MB heap. */
const LIMITS = {
  zipWarnBytes: 12 * 1024 * 1024,
  zipFailBytes: 45 * 1024 * 1024,
  shapesWarnBytes: 15 * 1024 * 1024,
  shapesFailBytes: 80 * 1024 * 1024,
  coreParseWarnMs: 15_000,
  coreParseFailMs: 60_000,
  shapesParseWarnMs: 45_000,
  shapesParseFailMs: 120_000,
};

function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtMs(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  await loadAgencies({ force: true });
  const agency = await getAgency(slug);
  if (!agency) {
    console.error(`Unknown agency: ${slug}`);
    process.exit(1);
  }

  const adapter = getAdapter(agency.slug);
  console.log(`\nChecking ${agency.name} (${agency.slug})`);
  console.log(`Adapter: ${adapter.notes}`);
  console.log(`Static URL: ${agency.gtfsStaticUrl || "(missing)"}`);
  console.log(`RT URL: ${agency.vehiclePositionsUrl || "(missing)"}`);

  if (!agency.gtfsStaticUrl) {
    console.error("\nFAIL — no gtfsStaticUrl on sheet row");
    process.exit(1);
  }

  const key = await getAgencyApiKey(agency);
  console.log(`API key: ${key ? "present" : "MISSING (may fail for 511)"}`);

  let failed = false;
  const warn = (msg) => console.warn(`WARN — ${msg}`);
  const fail = (msg) => {
    console.error(`FAIL — ${msg}`);
    failed = true;
  };

  // --- Feed size gate (before heavy parse) ---
  console.log("\nFeed size:");
  const tInspect = Date.now();
  let feed;
  try {
    feed = await inspectStaticFeed(agency);
  } catch (err) {
    fail(`static GTFS unreachable: ${err.message}`);
    process.exit(1);
  }
  console.log(`  download/inspect: ${fmtMs(Date.now() - tInspect)}`);
  console.log(`  zip: ${fmtBytes(feed.zipBytes)}`);
  for (const [name, info] of Object.entries(feed.entries)) {
    if (!info) {
      console.log(`  ${name}: missing`);
      continue;
    }
    console.log(`  ${name}: ${fmtBytes(info.uncompressed)} uncompressed`);
  }

  if (feed.zipBytes > LIMITS.zipFailBytes) {
    fail(`zip ${fmtBytes(feed.zipBytes)} exceeds hard limit ${fmtBytes(LIMITS.zipFailBytes)}`);
  } else if (feed.zipBytes > LIMITS.zipWarnBytes) {
    warn(`zip ${fmtBytes(feed.zipBytes)} is large (sidebar cold start downloads this)`);
  }

  const shapesUncompressed = feed.entries["shapes.txt"]?.uncompressed;
  if (shapesUncompressed != null) {
    if (shapesUncompressed > LIMITS.shapesFailBytes) {
      fail(
        `shapes.txt ${fmtBytes(shapesUncompressed)} exceeds hard limit ${fmtBytes(LIMITS.shapesFailBytes)}`,
      );
    } else if (shapesUncompressed > LIMITS.shapesWarnBytes) {
      warn(
        `shapes.txt ${fmtBytes(shapesUncompressed)} is large — first map draw will be slow / memory-heavy`,
      );
    }
  }

  // --- Core parse (routes + trips) ---
  console.log("\nStatic parse:");
  const tCore = Date.now();
  const staticIndex = await getStaticIndex(agency);
  const coreMs = Date.now() - tCore;
  console.log(
    `  core (routes+trips): ${fmtMs(coreMs)} — ${staticIndex.stats.routeCount} routes, ${staticIndex.stats.tripCount} trips`,
  );
  if (coreMs > LIMITS.coreParseFailMs) {
    fail(`core parse ${fmtMs(coreMs)} exceeds ${fmtMs(LIMITS.coreParseFailMs)}`);
  } else if (coreMs > LIMITS.coreParseWarnMs) {
    warn(`core parse ${fmtMs(coreMs)} is slow`);
  }

  if (!skipShapes) {
    const tShapes = Date.now();
    await ensureRouteShapes(staticIndex);
    const shapesMs = Date.now() - tShapes;
    console.log(
      `  shapes: ${fmtMs(shapesMs)} — ${staticIndex.stats.shapeRouteCount} shaped routes, ${staticIndex.stats.shapeFeatureCount} features`,
    );
    if (shapesMs > LIMITS.shapesParseFailMs) {
      fail(`shapes parse ${fmtMs(shapesMs)} exceeds ${fmtMs(LIMITS.shapesParseFailMs)}`);
    } else if (shapesMs > LIMITS.shapesParseWarnMs) {
      warn(`shapes parse ${fmtMs(shapesMs)} is slow`);
    }
  } else {
    console.log("  shapes: skipped (--skip-shapes)");
  }

  if (!agency.vehiclePositionsUrl) {
    warn("no realtime vehicle URL — routes/shapes only");
    if (failed) process.exit(1);
    console.log("\nOK — static feed usable (no RT to match)");
    return;
  }

  // --- RT match gate ---
  const feedBundle = await getVehicleFeed(agency);
  const entities = (feedBundle.feed.entity || []).filter((e) => {
    const p = e.vehicle?.position;
    if (!p) return false;
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return false;
    if (Math.abs(p.latitude) < 0.01 && Math.abs(p.longitude) < 0.01) return false;
    return true;
  });
  console.log(`\nRT vehicles with real position: ${entities.length}`);

  const methods = {};
  let matchedKnown = 0;
  const unmatchedSamples = [];

  for (const entity of entities) {
    const { routeId, method } = adapter.extractRouteId(entity, staticIndex);
    methods[method] = (methods[method] || 0) + 1;
    const norm = adapter.normalizeRouteId(routeId);
    if (norm && staticIndex.routeIds.has(norm)) {
      matchedKnown += 1;
    } else if (unmatchedSamples.length < 8) {
      const trip = entity.vehicle?.trip || {};
      unmatchedSamples.push({
        method,
        routeId: trip.routeId || null,
        tripId: trip.tripId || null,
      });
    }
  }

  const rate = entities.length ? matchedKnown / entities.length : 0;
  console.log("\nMatch methods:");
  for (const [k, v] of Object.entries(methods).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
  console.log(`\nMatched to known route_id: ${(rate * 100).toFixed(1)}% (${matchedKnown}/${entities.length})`);
  if (unmatchedSamples.length) {
    console.log("Unmatched samples:", JSON.stringify(unmatchedSamples, null, 2));
  }

  if (entities.length === 0) {
    warn("no vehicles with real positions right now — re-run later");
  } else if (rate < MATCH_THRESHOLD && !allowLow) {
    fail(
      `match rate below ${(MATCH_THRESHOLD * 100).toFixed(0)}%. Add/tune src/agencies/${slug}.js or pass --allow-low.`,
    );
  }

  if (failed) process.exit(1);
  console.log("\nOK — adapter ready");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
