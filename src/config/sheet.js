import { parse } from "csv-parse/sync";
import { enrichAgencyFromMobilityDb } from "./mobilitydb.js";

/** Sole inventory: Google Sheet. Optional MDB fill for blank URL cells. */
const SHEET_CSV_URL =
  process.env.TRANSIT_SHEET_CSV_URL ||
  "https://docs.google.com/spreadsheets/d/1oFifhH8dB3Sf25txOd55lDewR2nLCyo9hajmKlAOQQw/export?format=csv&gid=0";

const SHEET_TTL_MS = 60 * 1000;
let cache = { at: 0, agencies: null };

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cell(row, ...keys) {
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim() !== "") return String(row[key]).trim();
  }
  return "";
}

function isEnabled(value) {
  if (value == null || String(value).trim() === "") return true;
  return !["0", "false", "no", "off", "disabled"].includes(String(value).trim().toLowerCase());
}

function rowToAgency(row) {
  const name = cell(row, "name");
  if (!name || !isEnabled(cell(row, "enabled"))) return null;

  const mdbStaticId = cell(row, "mdb_static_id");
  const staticUrl = cell(row, "gtfs_static_url");
  if (!mdbStaticId && !staticUrl) return null;

  const slug = (cell(row, "slug") || slugify(name)).toLowerCase();
  const tripUpdatesUrl = cell(row, "gtfs_trip_updates_url");

  return {
    slug,
    name,
    location: cell(row, "location"),
    lat: num(cell(row, "latitude"), 0),
    lon: num(cell(row, "longitude"), 0),
    spanDelta: num(cell(row, "span_delta"), 0.1),
    fareLink: cell(row, "fare_link") || undefined,
    mdbStaticId: mdbStaticId || undefined,
    gtfsStaticUrl: staticUrl,
    vehiclePositionsUrl: cell(row, "gtfs_vehicle_positions_url"),
    tripUpdatesUrl: /^https?:\/\//i.test(tripUpdatesUrl) ? tripUpdatesUrl : "",
    alertsUrl: cell(row, "gtfs_alerts_url"),
    rtAgencyCode: cell(row, "rt_agency_code"),
    apiKeySecret: `transit-${slug}-api-key`,
    apiKeyEnv: `TRANSIT_${slug.toUpperCase().replace(/-/g, "_")}_API_KEY`,
    enabled: true,
  };
}

export async function loadAgencies({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.agencies && now - cache.at < SHEET_TTL_MS) return cache.agencies;

  const res = await fetch(SHEET_CSV_URL, {
    headers: { "User-Agent": "transit-api/1.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Sheet HTTP ${res.status}`);

  const rows = parse(await res.text(), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  let agencies = rows.map(rowToAgency).filter(Boolean);
  agencies = await Promise.all(agencies.map((a) => enrichAgencyFromMobilityDb(a)));
  agencies = agencies.filter((a) => a.gtfsStaticUrl);
  // 511 TripUpdates URL if Sheet cell is blank (same key/agency as vehicles).
  agencies = agencies.map((a) => {
    if (a.slug === "muni" && !a.tripUpdatesUrl) {
      return { ...a, tripUpdatesUrl: "https://api.511.org/transit/tripupdates" };
    }
    return a;
  });
  if (!agencies.length) throw new Error("Sheet has no valid agency rows");

  cache = { at: now, agencies };
  return agencies;
}

export function publicAgency(agency) {
  return {
    slug: agency.slug,
    name: agency.name,
    location: agency.location,
    lat: agency.lat,
    lon: agency.lon,
    spanDelta: agency.spanDelta,
    fareLink: agency.fareLink,
    hasTripUpdates: Boolean(agency.tripUpdatesUrl && /^https?:\/\//i.test(agency.tripUpdatesUrl)),
  };
}

export async function getAgency(slug) {
  const agencies = await loadAgencies();
  return agencies.find((a) => a.slug === String(slug).toLowerCase()) || null;
}
