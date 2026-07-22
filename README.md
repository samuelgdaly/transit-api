# Transit API

Cloud Run JSON API for the `/transit` map (and future iOS).

**Inventory = [Google Sheet](https://docs.google.com/spreadsheets/d/1oFifhH8dB3Sf25txOd55lDewR2nLCyo9hajmKlAOQQw/edit) only.**  
**Feeds = URLs on the Sheet** (optional Mobility Database fill if `mdb_static_id` is set and URL cells are blank).  
**Adapters = rare URL/auth quirks** (today: `muni` for 511 `api_key` + `agency=`). Matching is default GTFS-RT for everyone else.

## Endpoints

| Path | Purpose |
|------|---------|
| `GET /agencies` | Cities from the Sheet (`?refresh=1` re-reads the Sheet now) |
| `GET /routes/:agency` | Sidebar routes (routes.txt only — fast) |
| `GET /shapes/:agency?routes=` | GeoJSON — all shape patterns for each requested route (lazy) |
| `GET /stops/:agency?routes=` | Boardable stops for selected routes (lazy via stop_times stream) |
| `GET /vehicles/:agency?routes=` | Live vehicles (~30s cache); includes status/stop/occupancy when the feed sends them |
| `GET /arrivals/:agency/:stopId` | Real-time arrivals from TripUpdates (`realtime: false` if no TU URL) |
| `GET /health` | Liveness |

## Add a city

1. `npm run mdb -- --static mdb-XXX --slug cityname --fare https://…`  
   → tells you if GTFS-RT vehicles exist; prints a CSV row  
2. Paste the row into the Sheet (`enabled=TRUE`)  
3. If auth required → Secret Manager `transit-{slug}-api-key` (+ Swiftly needs an Authorization-header adapter)  
4. `npm run check -- {slug}` — fails on oversized GTFS, slow parse, or &lt;80% RT match  
   (`--allow-low` for match only; `--skip-shapes` to skip shape timing)  
5. `npm run deploy` only if a new secret/adapter/memory change is needed

`docs/agencies-sheet.csv` is an example snapshot, not the live inventory.

## Secrets

```bash
# Agency feed key (e.g. 511)
printf '%s' 'KEY' | gcloud secrets create transit-muni-api-key --data-file=- --project=deft-effect-416921

# Optional: Mobility Database refresh token (auto-fill blank URLs)
printf '%s' 'REFRESH' | gcloud secrets create transit-mobilitydb-refresh-token --data-file=- --project=deft-effect-416921
```

Grant the Cloud Run runtime SA `secretAccessor` on each secret, then `npm run deploy` (binds all `transit-*` secrets automatically).

**Never put API keys in the Google Sheet** (the CSV export URL is readable by the API and anyone who knows it). Keys belong only in Secret Manager / local `.env`.

## Security (publish)

- Secrets: Secret Manager only; redacted in logs/URLs
- CORS allowlist (no `*`); `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`
- Public JSON strips feed URLs and internal match debug fields
- Docker/gcloud uploads exclude `data/`, `.env`, and research CSVs
- Frontend has no keys; XSS: escaped text + hex-only colors

## Local

```bash
npm install
export TRANSIT_MUNI_API_KEY='…'   # if testing Muni
npm start
npm run check -- madison
```

Frontend: serve `samuelgdaly.github.io/transit` on port 8765 (CORS allowlist includes that origin, plus `samueldaly.com` and GitHub Pages). Override API with `localStorage.TRANSIT_API_BASE`.

## Layout

```
src/
  index.js          # HTTP routes
  config/           # sheet + secrets + mobilitydb
  gtfs/             # static + realtime + cache
  agencies/         # default matcher + rare overrides (muni)
scripts/
  mdb-propose.mjs   # Sheet row from Mobility Database catalog
  check-agency.mjs  # feed size + parse time + RT match gate
  deploy.sh
```
