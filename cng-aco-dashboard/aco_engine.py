"""Multi-heuristic, multi-vehicle, multi-day Ant Colony Optimisation (MT-IRPTW) for CNG bulk distribution.

Heuristics per transition i -> j (same as the notebook, extended):
  tau^alpha * (1/(C+1))^beta1 * (1/(D+1))^beta2 * (1/(T+wait+service+0.1))^eps * gamma_j^delta * (demand_j/remaining_cap)^theta
Extras: customer time windows, heterogeneous fleet, elitist pheromone, 2-opt + relocate local search,
urgency-weighted delay penalty and stock-out risk detection.
"""
import time

import numpy as np

from database import days_cover, urgency


class Problem:
    def __init__(self, nodes, vehicles, S, network):
        self.nodes, self.S, self.n = nodes, S, len(nodes)
        self.max_shift, self.shift_start = float(S["max_shift"]), float(S["shift_start"])
        self.dem = np.array([float(x["demand"] or 0) for x in nodes]); self.dem[0] = 0
        self.gamma = np.array([urgency(x) for x in nodes]); self.gamma[0] = 1.0
        self.open = np.array([max(0.0, float(x["tw_open"]) - self.shift_start) for x in nodes])
        self.close = np.array([min(self.max_shift, float(x["tw_close"]) - self.shift_start) for x in nodes])
        self.open[0], self.close[0] = 0.0, self.max_shift
        self.svc = self.dem / float(S["filling_unit"]) * float(S["filling_minutes"]) / 60.0
        self.veh = []
        for k, v in enumerate(vehicles):
            m = network.for_vehicle(float(v["km_per_l"]))
            m.update(id=v["id"], name=v["name"], cap=float(v["capacity"]), kmpl=float(v["km_per_l"]), idx=k)
            m["Cl"], m["Tl"] = m["C"].tolist(), m["T"].tolist()
            self.veh.append(m)
        self.open_l, self.close_l = self.open.tolist(), self.close.tolist()
        self.svc_l, self.dem_l = self.svc.tolist(), self.dem.tolist()
        self.servable, self.unserved = [], []
        maxcap = max(v["cap"] for v in self.veh)
        for j in range(1, self.n):
            reason = None
            if self.dem[j] > maxcap:
                reason = f"Demand {self.dem[j]:.0f} m3 exceeds the largest truck ({maxcap:.0f} m3)"
            elif self.close[j] <= self.open[j]:
                reason = "Time window is outside the working shift"
            else:
                ok = False
                for v in self.veh:
                    if v["cap"] < self.dem[j]:
                        continue
                    fin = max(v["T"][0, j], self.open[j]) + self.svc[j]
                    if fin <= self.close[j] and fin + v["T"][j, 0] <= self.max_shift:
                        ok = True
                        break
                if not ok:
                    reason = "Cannot be served within the shift / time window (too far or too long to fill)"
            if reason:
                self.unserved.append({"node_id": nodes[j]["id"], "name": nodes[j]["name"], "reason": reason})
            else:
                self.servable.append(j)


class ACOSolver:
    def __init__(self, prob, p, progress=None, cancel=None):
        self.P, self.p, self.progress, self.cancel = prob, p, progress, cancel
        seed = p.get("seed")
        self.rng = np.random.default_rng(int(seed) if seed not in (None, "") else None)
        self.tau = np.ones((prob.n, prob.n))
        for v in prob.veh:
            v["eta"] = (1.0 / (v["C"] + 1.0)) ** p["beta_cost"] * (1.0 / (v["D"] + 1.0)) ** p["beta_dist"]
        self.gpow = prob.gamma ** p["delta_urgency"]
        self.drv = float(prob.S["driver_cost_per_hour"])
        self.pen = float(prob.S["urgency_penalty"])

    # ------------------------------------------------------------ route evaluation
    def _check(self, vi, seq):
        P, v = self.P, self.P.veh[vi]
        T, C = v["Tl"], v["Cl"]
        t, cur, load, cost = 0.0, 0, 0.0, 0.0
        for j in seq:
            arr = t + T[cur][j]
            o = P.open_l[j]
            fin = (arr if arr > o else o) + P.svc_l[j]
            load += P.dem_l[j]
            if fin > P.close_l[j] + 1e-9 or load > v["cap"] + 1e-9:
                return False, 0.0, 0.0
            cost += C[cur][j]; t = fin; cur = j
        t += T[cur][0]; cost += C[cur][0]
        if t > P.max_shift + 1e-9:
            return False, 0.0, 0.0
        return True, t, cost

    def _robj(self, vi, seq):
        if not seq:
            return 0.0
        ok, h, c = self._check(vi, seq)
        return c + self.drv * h if ok else float("inf")

    def objective(self, days):
        total = 0.0
        for d, day in enumerate(days):
            for vi, seq in day:
                total += self._robj(vi, seq) + self.pen * d * sum(self.P.gamma[j] - 1.0 for j in seq)
        return total

    # ------------------------------------------------------------ solution construction
    def _pick(self, vi, cur, t, load, remaining):
        P, v, p = self.P, self.P.veh[vi], self.p
        T = v["T"]
        arr_raw = t + T[cur, remaining]
        arr = np.maximum(arr_raw, P.open[remaining])
        fin = arr + P.svc[remaining]
        ok = (load + P.dem[remaining] <= v["cap"] + 1e-9) & (fin <= P.close[remaining] + 1e-9) & \
             (fin + T[remaining, 0] <= P.max_shift + 1e-9)
        if not ok.any():
            return None
        c = remaining[ok]
        wait = arr[ok] - arr_raw[ok]
        eta_t = (1.0 / (T[cur, c] + wait + P.svc[c] + 0.1)) ** p["eps_time"]
        util = (P.dem[c] / max(v["cap"] - load, 1e-9)) ** p["theta_load"]
        w = (self.tau[cur, c] ** p["alpha"]) * v["eta"][cur, c] * eta_t * self.gpow[c] * util
        m = w.max() if len(w) else 0
        if not np.isfinite(m) or m <= 0:
            pr = np.full(len(c), 1.0 / len(c))
        else:
            w = w / m
            pr = w / w.sum()
        k = int(self.rng.choice(len(c), p=pr))
        return int(c[k]), float(fin[ok][k])

    def _construct(self):
        P = self.P
        remaining = np.array(P.servable, dtype=int)
        days = []
        while remaining.size and len(days) < int(P.S["max_days"]):
            day = []
            for vi in self.rng.permutation(len(P.veh)):
                vi = int(vi)
                if not remaining.size:
                    break
                seq, t, load, cur = [], 0.0, 0.0, 0
                while remaining.size:
                    pick = self._pick(vi, cur, t, load, remaining)
                    if pick is None:
                        break
                    j, t = pick
                    seq.append(j); load += P.dem_l[j]; cur = j
                    remaining = remaining[remaining != j]
                if seq:
                    day.append((vi, seq))
            if not day:
                break
            days.append(day)
        return days

    # ------------------------------------------------------------ local search
    def _two_opt_or(self, vi, seq):
        best = self._robj(vi, seq)
        improved = True
        while improved:
            improved = False
            n = len(seq)
            for i in range(n - 1):
                for k in range(i + 1, n):
                    new = seq[:i] + seq[i:k + 1][::-1] + seq[k + 1:]
                    o = self._robj(vi, new)
                    if o < best - 1e-6:
                        seq, best, improved = new, o, True
            for i in range(n):
                node = seq[i]; rest = seq[:i] + seq[i + 1:]
                for pos in range(len(rest) + 1):
                    if pos == i:
                        continue
                    new = rest[:pos] + [node] + rest[pos:]
                    o = self._robj(vi, new)
                    if o < best - 1e-6:
                        seq, best, improved = new, o, True
                        break
                if improved:
                    break
        return seq

    def _relocate_once(self, day):
        for a in range(len(day)):
            for b in range(len(day)):
                if a == b:
                    continue
                va, sa = day[a]; vb, sb = day[b]
                base = self._robj(va, sa) + self._robj(vb, sb)
                for idx, node in enumerate(sa):
                    na = sa[:idx] + sa[idx + 1:]
                    oa = self._robj(va, na)
                    if oa == float("inf"):
                        continue
                    for pos in range(len(sb) + 1):
                        nb = sb[:pos] + [node] + sb[pos:]
                        ob = self._robj(vb, nb)
                        if oa + ob < base - 1e-6:
                            day[a] = (va, na); day[b] = (vb, nb)
                            return True
        return False

    def local_search(self, days):
        days = [[(vi, list(seq)) for vi, seq in day] for day in days]
        for day in days:
            for k, (vi, seq) in enumerate(day):
                day[k] = (vi, self._two_opt_or(vi, seq))
            guard = 0
            while guard < 40 and self._relocate_once(day):
                guard += 1
            day[:] = [(vi, self._two_opt_or(vi, s)) for vi, s in day if s]
        return [d for d in days if d]

    # ------------------------------------------------------------ main loop
    def _deposit(self, days, amount):
        for day in days:
            for _, seq in day:
                path = np.array([0] + seq + [0])
                np.add.at(self.tau, (path[:-1], path[1:]), amount)
                np.add.at(self.tau, (path[1:], path[:-1]), amount)

    def run(self):
        p, t0 = self.p, time.time()
        best_days, best_obj = None, float("inf")
        conv_best, conv_mean = [], []
        cancelled = False
        iters = int(p["iterations"])
        if not self.P.servable:
            return {"days": [], "objective": 0.0, "convergence": [], "mean": [], "cancelled": False, "runtime": 0.0}
        for it in range(iters):
            if self.cancel and self.cancel():
                cancelled = True
                break
            sols = []
            for _ in range(int(p["ants"])):
                d = self._construct()
                sols.append((self.objective(d), d))
            sols.sort(key=lambda x: x[0])
            mean = float(np.mean([s[0] for s in sols]))
            if p.get("local_search", True):
                d = self.local_search(sols[0][1])
                sols[0] = (self.objective(d), d)
                sols.sort(key=lambda x: x[0])
            if sols[0][0] < best_obj:
                best_obj, best_days = sols[0]
            self.tau *= (1 - p["rho"])
            for obj, d in sols:
                self._deposit(d, p["Q"] / (obj + 1.0))
            self._deposit(best_days, p["elitist"] * p["Q"] / (best_obj + 1.0))
            np.clip(self.tau, 0.01, 1e4, out=self.tau)
            conv_best.append(round(best_obj, 2)); conv_mean.append(round(mean, 2))
            if self.progress:
                self.progress({"iter": it + 1, "total": iters, "best": best_obj, "iter_best": sols[0][0],
                               "mean": mean, "days": len(best_days)})
        if best_days is None:
            best_days = []
        elif p.get("local_search", True):
            best_days = self.local_search(best_days)
            best_obj = self.objective(best_days)
        return {"days": best_days, "objective": best_obj, "convergence": conv_best, "mean": conv_mean,
                "cancelled": cancelled, "runtime": time.time() - t0}

    # ------------------------------------------------------------ plan / report
    def build_plan(self, days):
        P, S = self.P, self.P.S
        out_days, tot = [], dict(km=0, fuel=0, toll=0, labor=0, pen=0, hrs=0, drive=0, load=0, liters=0, routes=0)
        utils, risks, vehicles_used = [], 0, set()
        for d, day in enumerate(days):
            routes = []
            for vi, seq in sorted(day, key=lambda x: x[0]):
                v = P.veh[vi]; vehicles_used.add(v["id"])
                dep = P.nodes[0]
                stops = [dict(node_id=dep["id"], name=dep["name"], lat=dep["lat"], lng=dep["lng"], kind="depot",
                              demand=0, arrive=S["shift_start"], wait=0, start=S["shift_start"], finish=S["shift_start"],
                              load_after=0, leg=None, gamma=1.0, risk=False)]
                t, cur, load = 0.0, 0, 0.0
                r = dict(km=0.0, fuel=0.0, toll=0.0, svc=0.0, wait=0.0, drive=0.0, liters=0.0)
                for j in list(seq) + [0]:
                    km, hrs = float(v["D"][cur, j]), float(v["T"][cur, j])
                    fuel, toll = float(v["FUEL"][cur, j]), float(v["TOLL"][cur, j])
                    arr = t + hrs
                    start = max(arr, P.open[j]) if j else arr
                    wait = start - arr if j else 0.0
                    fin = start + P.svc[j]
                    load += P.dem[j]
                    nd = P.nodes[j]
                    dc = days_cover(nd) if j else None
                    risk = bool(j and dc is not None and d > dc)
                    risks += int(risk)
                    leg = dict(km=km, hours=hrs, cost=fuel + toll, fuel=fuel, toll=toll,
                               mode="toll" if v["MODE"][cur, j] else "nontoll", liters=km / v["kmpl"])
                    stops.append(dict(node_id=nd["id"], name=nd["name"], lat=nd["lat"], lng=nd["lng"],
                                      kind=nd["kind"], demand=float(P.dem[j]), arrive=S["shift_start"] + arr,
                                      wait=wait, start=S["shift_start"] + start, finish=S["shift_start"] + fin,
                                      load_after=float(load), leg=leg, gamma=float(P.gamma[j]),
                                      days_cover=None if dc is None else round(dc, 2), risk=risk))
                    r["km"] += km; r["fuel"] += fuel; r["toll"] += toll; r["drive"] += hrs
                    r["svc"] += float(P.svc[j]); r["wait"] += wait; r["liters"] += km / v["kmpl"]
                    t, cur = fin, j
                dur = t
                labor = self.drv * dur
                pen = self.pen * d * sum(P.gamma[j] - 1 for j in seq)
                util = load / v["cap"]
                utils.append(util)
                routes.append(dict(vehicle_id=v["id"], vehicle_name=v["name"], color_idx=v["idx"], capacity=v["cap"],
                                   stops=stops, km=r["km"], cost=r["fuel"] + r["toll"], fuel=r["fuel"], toll=r["toll"],
                                   labor=labor, penalty=pen, hours=dur, drive_hours=r["drive"], service_hours=r["svc"],
                                   wait_hours=r["wait"], load=load, utilization=util, liters=r["liters"],
                                   start=S["shift_start"], end=S["shift_start"] + dur))
                tot["km"] += r["km"]; tot["fuel"] += r["fuel"]; tot["toll"] += r["toll"]; tot["labor"] += labor
                tot["pen"] += pen; tot["hrs"] += dur; tot["drive"] += r["drive"]; tot["load"] += load
                tot["liters"] += r["liters"]; tot["routes"] += 1
            out_days.append(dict(day=d + 1, routes=routes,
                                 cost=sum(x["cost"] for x in routes), km=sum(x["km"] for x in routes),
                                 hours=max([x["hours"] for x in routes] or [0]), load=sum(x["load"] for x in routes),
                                 penalty=sum(x["penalty"] for x in routes), labor=sum(x["labor"] for x in routes)))
        n_days = len(out_days)
        summary = dict(total_cost=tot["fuel"] + tot["toll"], fuel_cost=tot["fuel"], toll_cost=tot["toll"],
                       labor_cost=tot["labor"], penalty=tot["pen"],
                       objective=tot["fuel"] + tot["toll"] + tot["labor"] + tot["pen"],
                       grand_total=tot["fuel"] + tot["toll"] + tot["labor"],
                       distance=tot["km"], drive_hours=tot["drive"], shift_hours=tot["hrs"],
                       avg_speed=(tot["km"] / tot["drive"]) if tot["drive"] else 0, days=n_days, routes=tot["routes"],
                       vehicles_used=len(vehicles_used), fleet_size=len(P.veh),
                       avg_utilization=float(np.mean(utils)) if utils else 0, load=tot["load"],
                       liters=tot["liters"], co2_kg=tot["liters"] * float(S["co2_per_liter"]),
                       sla_days=S["sla_days"], sla_ok=n_days <= int(S["sla_days"]), stockout_risks=risks,
                       unserved=len(P.unserved), customers=len(P.servable), policy=S["route_policy"],
                       road_source=getattr(P, "road_source", "estimate"))
        return dict(summary=summary, days=out_days, unserved=P.unserved)


def run_sizing(make_problem, params, max_trucks, progress=None, cancel=None):
    """Re-solve with 1..max_trucks trucks and report days / cost / utilisation for each fleet size."""
    rows = []
    quick = dict(params, iterations=max(25, int(params["iterations"]) // 3), ants=max(10, int(params["ants"]) // 2))
    for k in range(1, max_trucks + 1):
        if cancel and cancel():
            break
        prob = make_problem(k)
        sol = ACOSolver(prob, quick, cancel=cancel)
        res = sol.run()
        plan = sol.build_plan(res["days"])["summary"]
        rows.append(dict(trucks=k, days=plan["days"], cost=plan["total_cost"], grand_total=plan["grand_total"],
                         objective=plan["objective"], utilization=plan["avg_utilization"],
                         distance=plan["distance"], sla_ok=plan["sla_ok"], risks=plan["stockout_risks"]))
        if progress:
            progress({"iter": k, "total": max_trucks, "rows": rows})
    return rows
