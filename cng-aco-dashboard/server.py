"""Flask API + static dashboard server.   Run:  python server.py   ->  http://127.0.0.1:5000"""
import csv
import io
import json
import threading
import traceback
import uuid

import numpy as np
from flask import Flask, Response, jsonify, request, send_from_directory

import database as D
from aco_engine import ACOSolver, Problem, run_sizing
from geo import Network, guess_region, osrm_table

app = Flask(__name__, static_folder="static", static_url_path="")
D.init_db()  # creates data/cng.db + demo data on first run
JOBS, JOBS_LOCK = {}, threading.Lock()
NODE_FIELDS = ["name", "kind", "region", "lat", "lng", "demand", "stock", "stock_max", "stock_min",
               "daily_use", "tw_open", "tw_close", "active"]


class ApiError(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg); self.code = code


@app.errorhandler(ApiError)
def _api_err(e):
    return jsonify(error=str(e)), e.code


@app.errorhandler(Exception)
def _err(e):
    traceback.print_exc()
    return jsonify(error=f"{type(e).__name__}: {e}"), 500


@app.route("/")
def index():
    return send_from_directory("static", "index.html")



def road_data(conn, nodes):
    """Real road distances/durations (OSRM), cached per coordinate pair in the DB. Raises if the first fetch fails."""
    n = len(nodes)
    co = [(x["lat"], x["lng"]) for x in nodes]
    lab = [f"{a:.5f},{b:.5f}" for a, b in co]
    pk = lambda i, j: "|".join(sorted([lab[i], lab[j]]))
    cache = {(r["pair"], r["mode"]): (r["dist"], r["dur"]) for r in conn.execute("SELECT * FROM road_cache")}
    pairs = [(i, j) for i in range(n) for j in range(i + 1, n)]

    def fetch(mode, exclude):
        if all((pk(i, j), mode) in cache for i, j in pairs):
            return
        try:
            dm, tm = osrm_table(co, exclude)
            for i, j in pairs:
                d, t = np.nanmean([dm[i][j], dm[j][i]]), np.nanmean([tm[i][j], tm[j][i]])
                v = (None, None) if np.isnan(d) else (float(d), float(t))
                cache[(pk(i, j), mode)] = v
                conn.execute("INSERT OR REPLACE INTO road_cache(pair,mode,dist,dur) VALUES(?,?,?,?)", (pk(i, j), mode, v[0], v[1]))
            D.log_event(conn, "info", f"Road network fetched from OSRM ({mode}, {n} points)")
        except Exception as e:
            if mode == "fast":
                raise
            for i, j in pairs:   # exclude=toll unsupported -> remember so we don't retry every run
                cache[(pk(i, j), mode)] = (None, None)
                conn.execute("INSERT OR REPLACE INTO road_cache(pair,mode,dist,dur) VALUES(?,?,NULL,NULL)", (pk(i, j), mode))
            D.log_event(conn, "warn", "OSRM non-toll routing unavailable - non-toll legs estimated from the fastest road route")

    fetch("fast", None)
    fetch("notoll", "toll")

    def mats(mode):
        dm, tm = np.full((n, n), np.nan), np.full((n, n), np.nan)
        for i, j in pairs:
            d, t = cache.get((pk(i, j), mode), (None, None))
            if d is not None:
                dm[i][j] = dm[j][i] = d; tm[i][j] = tm[j][i] = t
        return dm, tm
    nt = mats("notoll")
    return {"fast": mats("fast"), "notoll": nt if np.isfinite(nt[0]).any() else None}

# ------------------------------------------------------------------ problem loading
def load_problem(conn, over=None, n_trucks=None, patch=None):
    S = D.get_settings(conn)
    if patch:
        S.update(patch)
    if over:
        S["aco"].update({k: v for k, v in over.items() if k in S["aco"]})
    nodes = [dict(r) for r in conn.execute(
        "SELECT * FROM nodes WHERE active=1 ORDER BY CASE kind WHEN 'depot' THEN 0 ELSE 1 END, id")]
    if not nodes or nodes[0]["kind"] != "depot":
        raise ApiError("An active depot is required. Add or activate a node of kind 'depot'.")
    nodes = [nodes[0]] + [n for n in nodes[1:] if n["kind"] == "customer" and (n["demand"] or 0) > 0]
    if len(nodes) < 2:
        raise ApiError("Add at least one active customer with demand > 0.")
    vehicles = [dict(r) for r in conn.execute("SELECT * FROM vehicles WHERE active=1 ORDER BY id")]
    if not vehicles:
        raise ApiError("Add at least one active vehicle.")
    if n_trucks:
        vehicles = [dict(vehicles[i % len(vehicles)], id=-(i + 1), name=f"TRUCK-{i + 1}") for i in range(n_trucks)]
    edges = [dict(r) for r in conn.execute("SELECT * FROM edges")]
    road, source = None, "estimate"
    if S["use_osrm"]:
        try:
            road = road_data(conn, nodes)
            source = "osrm"
        except Exception as e:
            D.log_event(conn, "warn", f"OSRM unreachable ({type(e).__name__}) - using estimated distances")
    prob = Problem(nodes, vehicles, S, Network(nodes, S, edges, road))
    prob.road_source = source
    return prob, S


# ------------------------------------------------------------------ jobs
def spawn(kind, target):
    jid = uuid.uuid4().hex[:10]
    job = dict(id=jid, kind=kind, status="running", progress=0.0, iter=0, total=0, best=None, mean=None,
               history=[], mean_hist=[], result=None, error=None, cancel=False)
    with JOBS_LOCK:
        JOBS[jid] = job

    def wrap():
        try:
            target(job)
            job["status"] = "cancelled" if job["cancel"] else "done"
        except Exception as e:  # noqa
            traceback.print_exc()
            job["status"], job["error"] = "error", f"{type(e).__name__}: {e}"
        job["progress"] = 1.0 if job["status"] == "done" else job["progress"]

    threading.Thread(target=wrap, daemon=True).start()
    return job


def optimize_job(over):
    def target(job):
        with D.db() as conn:
            prob, S = load_problem(conn, over)
            version = D.data_version(conn)
        def prog(x):
            job.update(iter=x["iter"], total=x["total"], progress=x["iter"] / x["total"], best=x["best"], mean=x["mean"])
            job["history"].append(round(x["best"], 2)); job["mean_hist"].append(round(x["mean"], 2))
        solver = ACOSolver(prob, S["aco"], progress=prog, cancel=lambda: job["cancel"])
        res = solver.run()
        if not res["days"]:
            raise ApiError("Stopped before any solution was built")
        plan = solver.build_plan(res["days"])
        plan["summary"]["runtime"] = round(res["runtime"], 2)
        plan["summary"]["iterations"] = len(res["convergence"])
        with D.db() as conn:
            cur = conn.execute(
                "INSERT INTO runs(created_at,data_version,summary,plan,params,convergence) VALUES(?,?,?,?,?,?)",
                (D.now(), version, json.dumps(plan["summary"]), json.dumps(plan), json.dumps(S["aco"]),
                 json.dumps({"best": res["convergence"], "mean": res["mean"]})))
            sm = plan["summary"]
            D.log_event(conn, "success" if sm["sla_ok"] else "warn",
                        f"Run #{cur.lastrowid}: Rp {sm['total_cost']:,.0f} | {sm['days']} day(s) | {sm['distance']:.0f} km"
                        + ("" if sm["sla_ok"] else f" | exceeds SLA of {sm['sla_days']} days"))
            job["result"] = dict(run_id=cur.lastrowid, plan=plan, data_version=version,
                                 convergence={"best": res["convergence"], "mean": res["mean"]})
    return target


def sizing_job(max_trucks):
    def target(job):
        with D.db() as conn:
            _, S = load_problem(conn)
        def mk(k):
            with D.db() as c:
                return load_problem(c, n_trucks=k)[0]
        def prog(x):
            job.update(iter=x["iter"], total=x["total"], progress=x["iter"] / x["total"])
        rows = run_sizing(mk, S["aco"], max_trucks, prog, lambda: job["cancel"])
        with D.db() as conn:
            D.log_event(conn, "info", f"Fleet sizing analysed for 1-{max_trucks} trucks")
        job["result"] = {"rows": rows}
    return target


@app.post("/api/optimize")
def api_optimize():
    over = (request.get_json(silent=True) or {})
    with D.db() as conn:
        load_problem(conn, over)  # validate early -> 400 with a useful message
    return jsonify(job_id=spawn("optimize", optimize_job(over))["id"])


@app.post("/api/sizing")
def api_sizing():
    mx = int((request.get_json(silent=True) or {}).get("max_trucks", 6))
    with D.db() as conn:
        load_problem(conn)
    return jsonify(job_id=spawn("sizing", sizing_job(max(1, min(mx, 10))))["id"])



# what-if scenario presets: group -> [(label, lambda settings: settings_patch)]
SCENARIOS = {
    "policy": [("Cheapest road", lambda S: {"route_policy": "cheapest"}), ("Fastest road", lambda S: {"route_policy": "fastest"}),
               ("Balanced (cost + time)", lambda S: {"route_policy": "balanced"})],
    "shift": [("8 h shift", lambda S: {"max_shift": 8.0}), ("10 h shift", lambda S: {"max_shift": 10.0}),
              ("12 h shift", lambda S: {"max_shift": 12.0})],
    "fuel": [("Fuel -20%", lambda S: {"fuel_price": S["fuel_price"] * 0.8}), ("Fuel today", lambda S: {"fuel_price": S["fuel_price"]}),
             ("Fuel +20%", lambda S: {"fuel_price": S["fuel_price"] * 1.2}), ("Fuel +40%", lambda S: {"fuel_price": S["fuel_price"] * 1.4})],
    "penalty": [("No urgency penalty", lambda S: {"urgency_penalty": 0}), ("Current penalty", lambda S: {"urgency_penalty": S["urgency_penalty"]}),
                ("Strong penalty (x4)", lambda S: {"urgency_penalty": max(S["urgency_penalty"], 1) * 4})],
}


def scenario_job(group):
    def target(job):
        with D.db() as conn:
            _, S0 = load_problem(conn)
        quick = dict(S0["aco"], seed=42, iterations=max(30, int(S0["aco"]["iterations"]) // 2), ants=max(12, int(S0["aco"]["ants"]) * 2 // 3))
        jobs = [(g, lab, fn(S0)) for g, items in SCENARIOS.items() if group in ("all", g) for lab, fn in items]
        rows = []
        for k, (g, lab, patch) in enumerate(jobs):
            if job["cancel"]:
                break
            with D.db() as conn:
                prob, _ = load_problem(conn, patch=patch)
            sol = ACOSolver(prob, quick, cancel=lambda: job["cancel"])
            res = sol.run()
            if not res["days"]:
                continue
            sm = sol.build_plan(res["days"])["summary"]
            rows.append(dict(group=g, label=lab, current=all(abs(float(S0.get(a, 0)) - float(b)) < 1e-6 if not isinstance(b, str) else S0.get(a) == b for a, b in patch.items()),
                             days=sm["days"], total_cost=sm["total_cost"], grand_total=sm["grand_total"], distance=sm["distance"],
                             shift_hours=sm["shift_hours"], utilization=sm["avg_utilization"], risks=sm["stockout_risks"],
                             sla_ok=sm["sla_ok"], liters=sm["liters"], co2=sm["co2_kg"], objective=sm["objective"]))
            job.update(iter=k + 1, total=len(jobs), progress=(k + 1) / len(jobs))
        job["result"] = {"rows": rows}
    return target


@app.post("/api/scenarios")
def api_scenarios():
    g = (request.get_json(silent=True) or {}).get("group", "all")
    if g != "all" and g not in SCENARIOS:
        raise ApiError("Unknown scenario group")
    with D.db() as conn:
        load_problem(conn)
    return jsonify(job_id=spawn("scenarios", scenario_job(g))["id"])


@app.get("/api/jobs/<jid>")
def api_job(jid):
    j = JOBS.get(jid)
    if not j:
        raise ApiError("Unknown job", 404)
    return jsonify({k: v for k, v in j.items() if k != "cancel"})


@app.post("/api/jobs/<jid>/cancel")
def api_cancel(jid):
    if jid in JOBS:
        JOBS[jid]["cancel"] = True
    return jsonify(ok=True)


# ------------------------------------------------------------------ state
def run_row(r, full=False):
    d = dict(id=r["id"], created_at=r["created_at"], data_version=r["data_version"], summary=json.loads(r["summary"]))
    if full:
        d.update(plan=json.loads(r["plan"]), params=json.loads(r["params"]), convergence=json.loads(r["convergence"]))
    return d


@app.get("/api/state")
def api_state():
    with D.db() as conn:
        nodes = [D.decorate(r) for r in conn.execute("SELECT * FROM nodes ORDER BY kind DESC, id")]
        vehicles = [dict(r, active=bool(r["active"])) for r in conn.execute("SELECT * FROM vehicles ORDER BY id")]
        last = conn.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone()
        runs = [run_row(r) for r in conn.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 50")]
        events = [dict(r) for r in conn.execute("SELECT * FROM events ORDER BY id DESC LIMIT 40")]
        n_edges = conn.execute("SELECT COUNT(*) c FROM edges").fetchone()["c"]
        return jsonify(nodes=nodes, vehicles=vehicles, settings=D.get_settings(conn), run=run_row(last, True) if last else None,
                       runs=runs, events=events, data_version=D.data_version(conn), edge_overrides=n_edges)


# ------------------------------------------------------------------ nodes
def clean_node(data, partial=False):
    out = {}
    for k in NODE_FIELDS:
        if k in data and data[k] is not None and data[k] != "":
            out[k] = data[k]
    for k in ("lat", "lng", "demand", "stock", "stock_max", "stock_min", "daily_use", "tw_open", "tw_close"):
        if k in out:
            try:
                out[k] = float(out[k])
            except ValueError:
                raise ApiError(f"'{k}' must be a number")
    if "name" in out:
        out["name"] = str(out["name"]).strip()
    if "kind" in out and out["kind"] not in ("depot", "customer"):
        raise ApiError("kind must be depot or customer")
    if "active" in out:
        out["active"] = 1 if out["active"] in (True, 1, "1", "true") else 0
    if not partial:
        for k in ("name", "lat", "lng"):
            if k not in out:
                raise ApiError(f"'{k}' is required")
    if "lat" in out and not -90 <= out["lat"] <= 90 or "lng" in out and not -180 <= out["lng"] <= 180:
        raise ApiError("Coordinates out of range")
    for k in ("demand", "stock", "stock_max", "stock_min", "daily_use"):
        if k in out and out[k] < 0:
            raise ApiError(f"'{k}' cannot be negative")
    if "stock_max" in out and "stock_min" in out and out["stock_max"] < out["stock_min"]:
        raise ApiError("stock_max must be >= stock_min")
    return out


@app.post("/api/nodes")
def node_create():
    d = clean_node(request.get_json(force=True))
    d.setdefault("region", guess_region(d["lat"], d["lng"]) if not request.get_json().get("region") else d.get("region"))
    d["created_at"] = D.now()
    if d.get("kind") == "customer" or "kind" not in d:
        d.setdefault("stock_max", d.get("demand", 0) * 3); d.setdefault("stock_min", d.get("demand", 0) * 0.3)
        d.setdefault("stock", d["stock_max"] * 0.5); d.setdefault("daily_use", round(d.get("demand", 0) / 4, 1))
    with D.db() as conn:
        if conn.execute("SELECT 1 FROM nodes WHERE name=?", (d["name"],)).fetchone():
            raise ApiError("A node with this name already exists", 409)
        cols = ",".join(d); q = ",".join("?" * len(d))
        cur = conn.execute(f"INSERT INTO nodes({cols}) VALUES({q})", list(d.values()))
        D.bump_version(conn)
        D.log_event(conn, "info", f"Stop added: {d['name']} ({d.get('region')})")
        return jsonify(D.decorate(conn.execute("SELECT * FROM nodes WHERE id=?", (cur.lastrowid,)).fetchone())), 201


@app.put("/api/nodes/<int:nid>")
def node_update(nid):
    d = clean_node(request.get_json(force=True), partial=True)
    if not d:
        raise ApiError("Nothing to update")
    with D.db() as conn:
        if not conn.execute("SELECT 1 FROM nodes WHERE id=?", (nid,)).fetchone():
            raise ApiError("Node not found", 404)
        if "name" in d and conn.execute("SELECT 1 FROM nodes WHERE name=? AND id<>?", (d["name"], nid)).fetchone():
            raise ApiError("A node with this name already exists", 409)
        if ("lat" in d or "lng" in d) and "region" not in d:
            cur = conn.execute("SELECT lat,lng FROM nodes WHERE id=?", (nid,)).fetchone()
            if (request.get_json() or {}).get("auto_region"):
                d["region"] = guess_region(d.get("lat", cur["lat"]), d.get("lng", cur["lng"]))
        conn.execute(f"UPDATE nodes SET {','.join(k + '=?' for k in d)} WHERE id=?", list(d.values()) + [nid])
        D.bump_version(conn)
        return jsonify(D.decorate(conn.execute("SELECT * FROM nodes WHERE id=?", (nid,)).fetchone()))


@app.delete("/api/nodes/<int:nid>")
def node_delete(nid):
    with D.db() as conn:
        r = conn.execute("SELECT * FROM nodes WHERE id=?", (nid,)).fetchone()
        if not r:
            raise ApiError("Node not found", 404)
        if r["kind"] == "depot" and conn.execute("SELECT COUNT(*) c FROM nodes WHERE kind='depot'").fetchone()["c"] <= 1:
            raise ApiError("Cannot delete the only depot")
        conn.execute("DELETE FROM nodes WHERE id=?", (nid,))
        D.bump_version(conn)
        D.log_event(conn, "warn", f"Stop removed: {r['name']}")
    return jsonify(ok=True)


# ------------------------------------------------------------------ vehicles
@app.post("/api/vehicles")
def veh_create():
    d = request.get_json(force=True)
    try:
        name, cap, kmpl = str(d["name"]).strip(), float(d.get("capacity", 5000)), float(d.get("km_per_l", 3.5))
    except (KeyError, ValueError):
        raise ApiError("name, capacity and km_per_l are required")
    if not name or cap <= 0 or kmpl <= 0:
        raise ApiError("Invalid vehicle values")
    with D.db() as conn:
        if conn.execute("SELECT 1 FROM vehicles WHERE name=?", (name,)).fetchone():
            raise ApiError("Vehicle name already exists", 409)
        conn.execute("INSERT INTO vehicles(name,capacity,km_per_l,active) VALUES(?,?,?,?)", (name, cap, kmpl, 1))
        D.bump_version(conn); D.log_event(conn, "info", f"Vehicle added: {name}")
    return jsonify(ok=True), 201


@app.put("/api/vehicles/<int:vid>")
def veh_update(vid):
    d = request.get_json(force=True)
    sets, vals = [], []
    for k in ("name", "capacity", "km_per_l", "active"):
        if k in d:
            v = d[k]
            if k in ("capacity", "km_per_l"):
                v = float(v)
                if v <= 0:
                    raise ApiError(f"{k} must be positive")
            if k == "active":
                v = 1 if v in (True, 1, "1", "true") else 0
            sets.append(f"{k}=?"); vals.append(v)
    if not sets:
        raise ApiError("Nothing to update")
    with D.db() as conn:
        conn.execute(f"UPDATE vehicles SET {','.join(sets)} WHERE id=?", vals + [vid]); D.bump_version(conn)
    return jsonify(ok=True)


@app.delete("/api/vehicles/<int:vid>")
def veh_delete(vid):
    with D.db() as conn:
        conn.execute("DELETE FROM vehicles WHERE id=?", (vid,)); D.bump_version(conn)
    return jsonify(ok=True)


# ------------------------------------------------------------------ settings, reset
@app.put("/api/settings")
def settings_put():
    with D.db() as conn:
        D.save_settings(conn, request.get_json(force=True))
        D.log_event(conn, "info", "Settings updated")
        return jsonify(D.get_settings(conn))


@app.post("/api/reset")
def reset():
    D.reset_db()
    return jsonify(ok=True)


# ------------------------------------------------------------------ runs
@app.get("/api/runs/<int:rid>")
def run_get(rid):
    with D.db() as conn:
        r = conn.execute("SELECT * FROM runs WHERE id=?", (rid,)).fetchone()
        if not r:
            raise ApiError("Run not found", 404)
        return jsonify(run_row(r, True))


@app.delete("/api/runs/<int:rid>")
def run_delete(rid):
    with D.db() as conn:
        conn.execute("DELETE FROM runs WHERE id=?", (rid,))
    return jsonify(ok=True)


@app.get("/api/runs/<int:rid>/export.csv")
def run_csv(rid):
    with D.db() as conn:
        r = conn.execute("SELECT plan FROM runs WHERE id=?", (rid,)).fetchone()
    if not r:
        raise ApiError("Run not found", 404)
    plan = json.loads(r["plan"])
    buf = io.StringIO(); w = csv.writer(buf)
    w.writerow(["day", "truck", "seq", "stop", "arrive", "start_service", "depart", "leg_km", "leg_hours",
                "leg_cost_rp", "leg_toll_rp", "mode", "delivered_m3", "load_after_m3", "urgency_gamma", "stockout_risk"])
    clock = lambda h: f"{int(h) % 24:02d}:{int(round((h % 1) * 60)) % 60:02d}"
    for d in plan["days"]:
        for rt in d["routes"]:
            for i, s in enumerate(rt["stops"]):
                lg = s["leg"] or {}
                w.writerow([d["day"], rt["vehicle_name"], i, s["name"], clock(s["arrive"]), clock(s["start"]),
                            clock(s["finish"]), round(lg.get("km", 0), 2), round(lg.get("hours", 0), 2),
                            round(lg.get("cost", 0)), round(lg.get("toll", 0)), lg.get("mode", ""), s["demand"],
                            s["load_after"], round(s["gamma"], 2), "YES" if s["risk"] else ""])
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f"attachment; filename=route_plan_run_{rid}.csv"})


# ------------------------------------------------------------------ matrices & legs
@app.get("/api/matrix")
def api_matrix():
    with D.db() as conn:
        prob, _ = load_problem(conn)
    v = prob.veh[0]
    return jsonify(names=[n["name"] for n in prob.nodes], dist=np.round(v["D"], 1).tolist(),
                   time=np.round(v["T"], 2).tolist(), cost=np.round(v["C"]).tolist(), mode=v["MODE"].tolist(),
                   vehicle=v["name"])


@app.get("/api/leg")
def api_leg():
    a, b, vid = request.args.get("a", type=int), request.args.get("b", type=int), request.args.get("vehicle", type=int)
    with D.db() as conn:
        prob, S = load_problem(conn)
    ids = [n["id"] for n in prob.nodes]
    if a not in ids or b not in ids or a == b:
        raise ApiError("Pick two different active stops")
    i, j = ids.index(a), ids.index(b)
    v = next((x for x in prob.veh if x["id"] == vid), prob.veh[0])
    (dnt, tnt, fnt, _), (dt, tt, ft, tolt) = v["alt"]["nt"], v["alt"]["t"]
    opts = [dict(mode="nontoll", km=float(dnt[i, j]), hours=float(tnt[i, j]), fuel=float(fnt[i, j]), toll=0.0,
                 cost=float(fnt[i, j]), available=True)]
    if v["alt"]["valid_t"][i, j]:
        opts.append(dict(mode="toll", km=float(dt[i, j]), hours=float(tt[i, j]), fuel=float(ft[i, j]),
                         toll=float(tolt[i, j]), cost=float(ft[i, j] + tolt[i, j]), available=True))
    n = prob.nodes
    return jsonify(options=opts, chosen="toll" if v["MODE"][i, j] else "nontoll", policy=S["route_policy"],
                   a=dict(id=n[i]["id"], name=n[i]["name"], lat=n[i]["lat"], lng=n[i]["lng"]),
                   b=dict(id=n[j]["id"], name=n[j]["name"], lat=n[j]["lat"], lng=n[j]["lng"]))


# ------------------------------------------------------------------ CSV import (notebook's data_rute.csv / data_stok.csv)
def _num(x):
    x = str(x).strip().replace(",", "")
    return None if x in ("", "-", "nan", "None") else float(x)


@app.post("/api/import/csv")
def import_csv():
    n_edges = n_stock = 0
    with D.db() as conn:
        ids = {r["name"]: r["id"] for r in conn.execute("SELECT id,name FROM nodes")}
        f = request.files.get("routes")
        if f and f.filename:
            for row in csv.DictReader(io.StringIO(f.read().decode("utf-8-sig"))):
                parts = str(row.get("Rute", "")).split(" - ")
                if len(parts) != 2 or parts[0].strip() not in ids or parts[1].strip() not in ids:
                    continue
                a, b = sorted([ids[parts[0].strip()], ids[parts[1].strip()]])
                conn.execute("INSERT INTO edges(a_id,b_id,dist_nt,cost_nt,dist_t,cost_t) VALUES(?,?,?,?,?,?) "
                             "ON CONFLICT(a_id,b_id) DO UPDATE SET dist_nt=excluded.dist_nt,cost_nt=excluded.cost_nt,"
                             "dist_t=excluded.dist_t,cost_t=excluded.cost_t",
                             (a, b, _num(row.get("Jarak_NonTol")), _num(row.get("Biaya_BBM_NonTol")),
                              _num(row.get("Jarak_Tol")), _num(row.get("Total_Biaya_Jalur_Tol"))))
                n_edges += 1
        f = request.files.get("stock")
        if f and f.filename:
            for row in csv.DictReader(io.StringIO(f.read().decode("utf-8-sig"))):
                nm = str(row.get("Nama_Pelanggan", "")).strip()
                if nm in ids:
                    conn.execute("UPDATE nodes SET stock=?,stock_max=?,stock_min=? WHERE id=?",
                                 (_num(row["Sisa_Stok"]) or 0, _num(row["Stok_Max"]) or 0, _num(row["Stok_Min"]) or 0, ids[nm]))
                    n_stock += 1
        D.bump_version(conn)
        D.log_event(conn, "success", f"CSV import: {n_edges} route legs, {n_stock} stock rows")
    return jsonify(edges=n_edges, stock=n_stock)


@app.delete("/api/edges")
def clear_edges():
    with D.db() as conn:
        conn.execute("DELETE FROM edges"); D.bump_version(conn)
        D.log_event(conn, "info", "Route overrides cleared - using estimated road model")
    return jsonify(ok=True)


if __name__ == "__main__":
    print("\n  CNG ACO Command Center  ->  http://127.0.0.1:5000\n")
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
