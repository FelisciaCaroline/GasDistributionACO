# Bernardo's CNG · ACO Route Command Center

Your notebook (multi-heuristic, multi-vehicle, multi-day Ant Colony Optimisation for CNG bulk distribution
Surabaya → Pandaan → Malang → Batu) turned into a full application:

* **Flask + SQLite** backend: stops, trucks, settings, route overrides, run history and activity log live in a database
* **Upgraded ACO engine** (`aco_engine.py`) running as a background job with live progress
* **Dark "smart-city" dashboard** (Leaflet map): animated optimal routes, cost / time / distance analytics, itinerary with ETAs

## Run it (VS Code)

```bash
cd cng-aco-dashboard
python -m venv .venv                # optional
.venv\Scripts\activate              # Windows (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
python server.py
```
Open **http://127.0.0.1:5000**. Map tiles and fonts load from CDNs, so internet is needed.
The first run creates `data/cng.db` with demo data.

## Features

| Area | Feature |
|---|---|
| Map | Animated glowing routes per truck, direction arrows, numbered stops, pulsing red stock-out callouts, route isolation by click, day filter, legend toggles, *Road-snap* (real roads via OSRM) |
| Add stops | ⊕ tool (click the map), address search (OpenStreetMap), typed coordinates; inline demand/stock edit; activate/deactivate; delete; drag markers (✥ tool). All stored in SQLite. |
| ACO Optimizer | Ants / iterations / seed, Optimize / Stop, live convergence chart, optional auto re-run on change |
| Itinerary | Per-truck schedule: arrive / service / depart times, leg km / time / cost, toll vs non-toll, load, urgency γ, stock-out flags |
| Leg Analyzer | Any two stops + truck: toll vs non-toll distance, time, fuel, toll fee, total, recommendation |
| Cost Analytics | Total cost, cost per m³, fuel/toll/labor split, cost per day, litres, CO₂, penalty, risks |
| Fleet Sizing | Re-solves with 1..6 trucks and finds the cheapest fleet meeting the SLA |
| Fleet / Settings | Heterogeneous trucks; fuel price, route policy (cheapest/fastest/balanced), driver cost, penalty, speeds, toll table, shift, filling time, SLA, all ACO parameters |
| Reports | Run history (reload, CSV export), distance/time/cost heat-map matrix |
| Menu | Import notebook CSVs, export JSON/CSV, clear overrides, reset demo data |

## Using your real data

Menu → **Import CSV data**: `data_rute.csv` (`Rute, Biaya_BBM_NonTol, Jarak_NonTol, Total_Biaya_Jalur_Tol, Jarak_Tol`)
and/or `data_stok.csv` (`Nama_Pelanggan, Sisa_Stok, Stok_Max, Stok_Min`). Route rows become overrides of the
estimated road model for those pairs. Names must match the database (the 21 notebook names are the seed data).

## Algorithm vs the notebook

* Same transition rule `τ^α·(1/C)^β₁·(1/D)^β₂·(1/T)^ε·γ^δ·(demand/remaining)^θ`, same urgency formula, filling and shift rules
* Added: customer time windows, heterogeneous trucks, elitist pheromone, 2-opt + or-opt + inter-route relocate,
  urgency-weighted delay penalty, stock-out detection (`days_cover = (stock-min)/daily_use`), SLA check

## Layout

```
server.py      Flask API, background jobs, CSV import/export
aco_engine.py  ACO solver, local search, plan builder, fleet sizing
geo.py         road model, toll zones, per-vehicle matrices, OSRM
database.py    SQLite schema, seed data, settings
static/        index.html, style.css, app.js
```

## Assumptions to review

Seed coordinates are approximate, toll fees are estimates, and stock / daily_use values are synthetic. Replace them with
real data. Without CSV overrides, distance = haversine × road factor; enable *Use OSRM* in Settings for real road distances.

## Real road routing (new)

* **Distances and driving times** between every pair of stops come from the OSRM routing service (OpenStreetMap road network), including **toll vs non-toll** alternatives (`exclude=toll`). Times are multiplied by *Truck time factor* (default 1.3) because OSRM models cars.
* Results are **cached in the database** (`road_cache`), so only new or moved stops trigger a new lookup.
* The map draws every leg **along the real road**, using the toll or non-toll road the optimizer chose (*Road-snap* is on by default; geometry is cached in your browser).
* The Cost Analytics panel shows **Road data: Real roads (OSRM)** or **Estimated** if you are offline. Turn it off in Settings -> Road model.
* Uses the free public OSRM demo server, which is fine for personal use but rate limited. For production, host your own OSRM and change the URL in `geo.py` and `static/app.js`.

## Expandable analysis windows (new)

Every dashboard panel has a **⤢** button that opens it as a full-screen window:

| Panel | Full-screen content |
|---|---|
| Cost Analytics | Overview with KPIs and decision insights, **by truck**, **by customer** (cost to serve, Rp/m3), **toll vs non-toll** legs, by day |
| Fleet Sizing | **Fleet size** chart (cost and days vs number of trucks, SLA check, recommendation) and **What-if scenarios**: road policy, shift length, fuel price, urgency penalty, each re-solved with the same seed and compared against current settings |
| ACO Optimizer | Convergence analysis (converged at iteration N, improvement), parameters used, **compare runs** |
| Fleet Status | **Shift timeline (Gantt)** of driving / filling / waiting per truck and day, trip table with slack, insights (time-limited vs capacity-limited) |
| Stock Urgency | All customers with stock bars, cover days, planned delivery day and stock-out flags |
| Activity Log | Full event history |
