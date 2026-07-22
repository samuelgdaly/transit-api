#!/usr/bin/env node
/**
 * Look up Mobility Database catalog → print one Sheet CSV row.
 *
 *   npm run mdb -- --static mdb-205 --slug minneapolis --fare https://…
 *   npm run mdb -- "Metro Transit" Minnesota
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "data", "feeds_v2.csv");
const CATALOG_URL = "https://files.mobilitydatabase.org/feeds_v2.csv";
const HEADER =
  "slug,name,location,latitude,longitude,span_delta,fare_link,mdb_static_id,gtfs_static_url,gtfs_vehicle_positions_url,gtfs_trip_updates_url,gtfs_alerts_url,rt_agency_code,enabled";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const staticId = flag("--static");
const slugArg = flag("--slug");
const latArg = flag("--lat");
const lonArg = flag("--lon");
const spanArg = flag("--span");
const fareArg = flag("--fare");
const queryTerms = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function loadCatalog() {
  mkdirSync(dirname(CACHE), { recursive: true });
  const stale = !existsSync(CACHE) || Date.now() - statSync(CACHE).mtimeMs > 86400000;
  if (stale) {
    console.error("Downloading Mobility Database catalog…");
    const res = await fetch(CATALOG_URL, { headers: { "User-Agent": "transit-api/1.0" } });
    if (!res.ok) throw new Error(`Catalog HTTP ${res.status}`);
    writeFileSync(CACHE, Buffer.from(await res.arrayBuffer()));
  }
  return parse(readFileSync(CACHE, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });
}

function score(r, terms) {
  const blob = [r.id, r.provider, r.name, r["location.municipality"], r["location.subdivision_name"]]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (r["location.country_code"] !== "US") return -1;
  let s = r.status === "active" ? 0.5 : 0;
  for (const t of terms) if (blob.includes(t.toLowerCase())) s += 1;
  return s;
}

function center(r) {
  const a = Number(r["location.bounding_box.minimum_latitude"]);
  const b = Number(r["location.bounding_box.maximum_latitude"]);
  const c = Number(r["location.bounding_box.minimum_longitude"]);
  const d = Number(r["location.bounding_box.maximum_longitude"]);
  if (![a, b, c, d].every(Number.isFinite)) return null;
  return {
    lat: ((a + b) / 2).toFixed(4),
    lon: ((c + d) / 2).toFixed(4),
    span: String(Math.min(0.4, Math.max(0.1, Number(((Math.max(b - a, d - c) / 2) || 0.15).toFixed(2))))),
  };
}

async function main() {
  if (!staticId && !queryTerms.length) {
    console.error("Usage: npm run mdb -- --static mdb-205 [--slug name] [--fare url]");
    process.exit(2);
  }

  const rows = await loadCatalog();
  let staticFeed;
  if (staticId) {
    staticFeed = rows.find((r) => r.id === staticId && r.data_type === "gtfs");
    if (!staticFeed) throw new Error(`No gtfs feed ${staticId}`);
  } else {
    const ranked = rows
      .filter((r) => r.data_type === "gtfs")
      .map((r) => ({ r, s: score(r, queryTerms) }))
      .filter((x) => x.s >= queryTerms.length)
      .sort((a, b) => b.s - a.s);
    if (!ranked.length) throw new Error(`No match for: ${queryTerms.join(" ")}`);
    staticFeed = ranked[0].r;
  }

  const linked = rows.filter(
    (r) => r.data_type === "gtfs_rt" && r.status === "active" && r.static_reference === staticFeed.id,
  );
  const by = (ent) => linked.find((r) => (r.entity_type || "").split("|").includes(ent));
  const vp = by("vp");
  const tu = by("tu");
  const sa = by("sa");
  const box = center(staticFeed);
  const name = (staticFeed.provider || staticFeed.name || "Agency").split(",")[0].trim();
  const slug = slugArg || slugify(name);
  const loc = [staticFeed["location.municipality"], staticFeed["location.subdivision_name"]]
    .filter(Boolean)
    .join(", ");
  const staticUrl = staticFeed["urls.latest"] || staticFeed["urls.direct_download"] || "";
  const vpUrl = vp?.["urls.direct_download"] || "";
  const needsAuth = vp && vp["urls.authentication_type"] && vp["urls.authentication_type"] !== "0";

  console.error(`\n${staticFeed.id}  ${staticFeed.provider}  (${staticFeed.status})`);
  console.error(`  static:   ${staticUrl ? "yes" : "NO"}`);
  console.error(`  vehicles: ${vp ? "yes — GTFS-RT VP" : "NO — routes/shapes only"}`);
  if (needsAuth) {
    console.error(`  auth:     ${vp["urls.api_key_parameter_name"]} — ${vp["urls.authentication_info"] || ""}`);
  }
  console.error(
    `  scheme:   ${vp ? "likely OK (run npm run check -- " + slug + ")" : "partial (no live buses in catalog)"}`,
  );

  const line = [
    slug,
    name,
    loc,
    latArg || box?.lat || "0",
    lonArg || box?.lon || "0",
    spanArg || box?.span || "0.15",
    fareArg || "",
    staticFeed.id,
    staticUrl,
    vpUrl,
    tu?.["urls.direct_download"] || "",
    sa?.["urls.direct_download"] || "",
    "",
    "TRUE",
  ]
    .map(csvEscape)
    .join(",");

  console.log(HEADER);
  console.log(line);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
