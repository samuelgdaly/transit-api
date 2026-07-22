import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const BASE = "https://api.mobilitydatabase.org/v1";
const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || "deft-effect-416921";
const secretClient = new SecretManagerServiceClient();

let accessCache = { token: null, expiresAt: 0 };
let refreshTokenMemory = null;

/** Long-lived refresh token from mobilitydatabase.org → short-lived access token. */
export async function getMobilityDbRefreshToken() {
  if (process.env.MOBILITYDB_REFRESH_TOKEN) return process.env.MOBILITYDB_REFRESH_TOKEN.trim();
  if (refreshTokenMemory) return refreshTokenMemory;
  try {
    const name = `projects/${projectId}/secrets/transit-mobilitydb-refresh-token/versions/latest`;
    const [version] = await secretClient.accessSecretVersion({ name });
    const token = version.payload?.data?.toString("utf8")?.trim() || null;
    if (token) refreshTokenMemory = token;
    return token;
  } catch (err) {
    console.warn(`[mobilitydb] No refresh token: ${err.message}`);
    return null;
  }
}

async function getAccessToken() {
  const now = Date.now();
  if (accessCache.token && now < accessCache.expiresAt - 60_000) return accessCache.token;
  const refresh = await getMobilityDbRefreshToken();
  if (!refresh) return null;

  const res = await fetch(`${BASE}/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refresh_token: refresh }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw new Error(`Mobility DB token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  const token = data.access_token || data.id_token || data.token;
  if (!token) throw new Error("Mobility DB token response missing access_token");
  accessCache = { token, expiresAt: now + (Number(data.expires_in) || 3600) * 1000 };
  return token;
}

async function mdbGet(path) {
  const token = await getAccessToken();
  if (!token) return null;
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "transit-api/1.0",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new Error(`Mobility DB ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

function feedUrl(feed) {
  if (!feed) return "";
  return (
    feed.latest_dataset?.hosted_url ||
    feed.source_info?.producer_url ||
    feed.urls?.latest ||
    feed.urls?.direct_download ||
    ""
  );
}

function entities(feed) {
  const raw = feed?.entity_types || feed?.entity_type || [];
  if (Array.isArray(raw)) return raw.map(String);
  return String(raw || "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Resolve static + linked RT URLs from an id like mdb-205. */
export async function resolveFromStaticId(staticId) {
  const id = String(staticId || "").trim();
  if (!id) return null;
  const feed = await mdbGet(`/gtfs_feeds/${encodeURIComponent(id)}`);
  if (!feed) return null;

  let rtList = [];
  try {
    const linked = await mdbGet(`/gtfs_feeds/${encodeURIComponent(id)}/gtfs_rt_feeds`);
    rtList = Array.isArray(linked) ? linked : linked?.feeds || linked?.results || [];
  } catch (err) {
    console.warn(`[mobilitydb] RT links for ${id}: ${err.message}`);
  }

  const pick = (code) =>
    rtList.find((f) => entities(f).some((e) => e.toLowerCase() === code));

  return {
    staticUrl: feedUrl(feed),
    vehiclePositionsUrl: feedUrl(pick("vp")),
    tripUpdatesUrl: feedUrl(pick("tu")),
    alertsUrl: feedUrl(pick("sa")),
    provider: feed.provider || feed.feed_name || id,
  };
}

/** Fill blank Sheet URLs from mdb_static_id (no-op without token / id). */
export async function enrichAgencyFromMobilityDb(agency) {
  if (!agency?.mdbStaticId) return agency;
  const needs =
    !agency.gtfsStaticUrl ||
    !agency.vehiclePositionsUrl ||
    !agency.tripUpdatesUrl ||
    !agency.alertsUrl;
  if (!needs) return agency;

  try {
    const resolved = await resolveFromStaticId(agency.mdbStaticId);
    if (!resolved) return agency;
    return {
      ...agency,
      gtfsStaticUrl: agency.gtfsStaticUrl || resolved.staticUrl,
      vehiclePositionsUrl: agency.vehiclePositionsUrl || resolved.vehiclePositionsUrl,
      tripUpdatesUrl: agency.tripUpdatesUrl || resolved.tripUpdatesUrl,
      alertsUrl: agency.alertsUrl || resolved.alertsUrl,
    };
  } catch (err) {
    console.warn(`[mobilitydb] enrich ${agency.slug}: ${err.message}`);
    return agency;
  }
}
