import express from "express";
import cors from "cors";
import { loadAgencies, publicAgency, getAgency } from "./config/sheet.js";
import { getRoutesList, getStaticIndex, loadShapesForRouteIds } from "./gtfs/static.js";
import { getVehicleFeed, filterVehicles } from "./gtfs/realtime.js";

const app = express();
const PORT = Number(process.env.PORT || 8080);

const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ORIGINS ||
    "http://127.0.0.1:8765,http://localhost:8765,https://samueldaly.com,https://www.samueldaly.com,https://samuelgdaly.github.io")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  next();
});

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || ALLOWED_ORIGINS.has(origin)) return cb(null, true);
      return cb(null, false);
    },
  }),
);

app.get("/", (_req, res) => {
  res.json({
    service: "transit-api",
    endpoints: {
      health: "GET /health",
      agencies: "GET /agencies",
      routes: "GET /routes/:agency",
      shapes: "GET /shapes/:agency?routes=a,b",
      vehicles: "GET /vehicles/:agency?routes=a,b",
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/agencies", async (req, res) => {
  try {
    const force = ["1", "true", "yes"].includes(String(req.query.refresh || "").toLowerCase());
    const agencies = await loadAgencies({ force });
    res.json({ agencies: agencies.map(publicAgency), refreshed: force });
  } catch (err) {
    console.error("[agencies]", err);
    res.status(500).json({ error: "Failed to load agencies" });
  }
});

app.get("/routes/:agency", async (req, res) => {
  try {
    const agency = await getAgency(req.params.agency);
    if (!agency) return res.status(404).json({ error: "Unknown agency" });
    const index = await getRoutesList(agency);
    res.json({
      agency: agency.slug,
      routes: index.routes,
      stats: index.stats,
    });
  } catch (err) {
    console.error(`[routes/${req.params.agency}]`, err);
    res.status(500).json({ error: "Failed to load routes" });
  }
});

app.get("/shapes/:agency", async (req, res) => {
  try {
    const agency = await getAgency(req.params.agency);
    if (!agency) return res.status(404).json({ error: "Unknown agency" });
    const routes = String(req.query.routes || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!routes.length) return res.json({ type: "FeatureCollection", features: [] });
    const index = await getStaticIndex(agency);
    res.json(await loadShapesForRouteIds(index, routes));
  } catch (err) {
    console.error(`[shapes/${req.params.agency}]`, err);
    res.status(500).json({ error: "Failed to load shapes" });
  }
});

app.get("/vehicles/:agency", async (req, res) => {
  try {
    const agency = await getAgency(req.params.agency);
    if (!agency) return res.status(404).json({ error: "Unknown agency" });
    const routes = String(req.query.routes || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const routeFilter = routes.length ? new Set(routes) : null;
    const index = await getStaticIndex(agency);
    const feed = await getVehicleFeed(agency);
    const result = filterVehicles(agency, feed, index, routeFilter);
    res.json({
      agency: agency.slug,
      fetchedAt: result.fetchedAt,
      vehicles: result.vehicles,
    });
  } catch (err) {
    console.error(`[vehicles/${req.params.agency}]`, err);
    res.status(500).json({ error: "Failed to load vehicles" });
  }
});

app.listen(PORT, () => {
  console.log(`transit-api listening on :${PORT}`);
});
