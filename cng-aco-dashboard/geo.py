"""Geography + road network model: haversine, toll zones, optional OSRM, per-vehicle cost matrices."""
import json
import math
import urllib.request

import numpy as np


def haversine(lat1, lng1, lat2, lng2):
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def toll_key(a, b):
    return "-".join(sorted([a, b]))


def guess_region(lat, lng):
    """Rough toll-zone classifier for the Surabaya - Pandaan - Malang - Batu corridor."""
    if lat > -7.45:
        return "SBY"
    if lat > -7.78:
        return "PANDAAN"
    if -7.95 < lat < -7.78 and lng < 112.58:
        return "BATU"
    if lat <= -7.78:
        return "MALANG"
    return "OTHER"


def osrm_table(coords, exclude=None, timeout=25):
    """One OSRM /table call -> (distance km, duration h) matrices (nan where unroutable). Raises on failure."""
    s = ";".join(f"{lng:.6f},{lat:.6f}" for lat, lng in coords)
    url = f"https://router.project-osrm.org/table/v1/driving/{s}?annotations=distance,duration"
    if exclude:
        url += f"&exclude={exclude}"
    req = urllib.request.Request(url, headers={"User-Agent": "cng-aco-dashboard/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.load(r)
    if data.get("code") != "Ok":
        raise RuntimeError("OSRM: " + str(data.get("code")))
    conv = lambda m, k: np.array([[np.nan if v is None else v for v in row] for row in m], dtype=float) / k
    return conv(data["distances"], 1000.0), conv(data["durations"], 3600.0)


class Network:
    """Holds the toll / non-toll alternatives for every node pair."""

    def __init__(self, nodes, S, overrides=None, road=None):
        n = len(nodes)
        self.n, self.S = n, S
        self.DNT = np.zeros((n, n)); self.TNT = np.zeros((n, n))
        self.DT = np.full((n, n), np.inf); self.TT = np.full((n, n), np.inf)
        self.FEE = np.zeros((n, n))
        self.CNT_O = np.full((n, n), np.nan); self.CT_O = np.full((n, n), np.nan)
        tt = S["toll_table"]
        for i in range(n):
            for j in range(i + 1, n):
                a, b = nodes[i], nodes[j]
                km = haversine(a["lat"], a["lng"], b["lat"], b["lng"])
                same = a["region"] == b["region"]
                v_nt = S["urban_speed"] if same else S["nontoll_speed"]
                fee = 0.0 if same else float(tt.get(toll_key(a["region"], b["region"]), 0) or 0)
                tf = float(S.get("truck_time_factor", 1.3))
                fd = road["fast"][0][i][j] if road else np.nan
                if road and np.isfinite(fd):           # ---- real road data (OSRM)
                    ft = road["fast"][1][i][j] * tf
                    d_t, t_t = fd, ft
                    nt = road.get("notoll")
                    if same:
                        d_nt, t_nt = fd, ft
                    elif nt is not None and np.isfinite(nt[0][i][j]):
                        d_nt, t_nt = nt[0][i][j], nt[1][i][j] * tf
                        if abs(d_nt - fd) / max(fd, 0.1) < 0.02:   # fastest route never touches a toll road
                            fee = 0.0
                    else:
                        d_nt = fd * 1.04
                        t_nt = d_nt / v_nt
                else:                                   # ---- estimate (haversine x road factor)
                    d_nt = km * (S["urban_factor"] if same else S["nontoll_factor"])
                    d_t = km * S["toll_factor"]
                    t_nt, t_t = d_nt / v_nt, d_t / S["toll_speed"]
                self.DNT[i, j] = self.DNT[j, i] = d_nt
                self.TNT[i, j] = self.TNT[j, i] = t_nt
                if fee > 0:
                    self.DT[i, j] = self.DT[j, i] = d_t
                    self.TT[i, j] = self.TT[j, i] = t_t
                    self.FEE[i, j] = self.FEE[j, i] = fee
        if overrides:
            idx = {nd["id"]: k for k, nd in enumerate(nodes)}
            for e in overrides:
                if e["a_id"] not in idx or e["b_id"] not in idx:
                    continue
                i, j = idx[e["a_id"]], idx[e["b_id"]]
                same = nodes[i]["region"] == nodes[j]["region"]
                v_nt = S["urban_speed"] if same else S["nontoll_speed"]
                for a, b in ((i, j), (j, i)):
                    if e["dist_nt"] is not None:
                        self.DNT[a, b] = e["dist_nt"]; self.TNT[a, b] = e["dist_nt"] / v_nt
                    if e["cost_nt"] is not None:
                        self.CNT_O[a, b] = e["cost_nt"]
                    if e["dist_t"] is not None:
                        self.DT[a, b] = e["dist_t"]; self.TT[a, b] = e["dist_t"] / S["toll_speed"]
                    if e["cost_t"] is not None:
                        self.CT_O[a, b] = e["cost_t"]

    def for_vehicle(self, km_per_l):
        S, price = self.S, self.S["fuel_price"]
        with np.errstate(invalid="ignore"):
            fuel_nt = np.where(np.isnan(self.CNT_O), self.DNT / km_per_l * price, self.CNT_O)
            fuel_t_est = self.DT / km_per_l * price
            cost_t = np.where(np.isnan(self.CT_O), fuel_t_est + self.FEE, self.CT_O)
            toll_t = np.where(np.isnan(self.CT_O), self.FEE, np.maximum(self.CT_O - fuel_t_est, 0))
        fuel_t = cost_t - toll_t
        valid_t = np.isfinite(self.DT) & np.isfinite(cost_t) & np.isfinite(self.TT)
        pol, vot = S["route_policy"], S["value_of_time"]
        if pol == "fastest":
            s_nt, s_t = self.TNT, self.TT
        elif pol == "balanced":
            s_nt, s_t = fuel_nt + vot * self.TNT, cost_t + vot * self.TT
        else:
            s_nt, s_t = fuel_nt + 1e-6 * self.TNT, cost_t + 1e-6 * self.TT
        with np.errstate(invalid="ignore"):
            use_t = valid_t & (s_t < s_nt)
        np.fill_diagonal(use_t, False)
        return {
            "C": np.where(use_t, cost_t, fuel_nt), "D": np.where(use_t, self.DT, self.DNT),
            "T": np.where(use_t, self.TT, self.TNT), "FUEL": np.where(use_t, fuel_t, fuel_nt),
            "TOLL": np.where(use_t, toll_t, 0.0), "MODE": use_t.astype(int),
            "alt": {"nt": (self.DNT, self.TNT, fuel_nt, np.zeros_like(fuel_nt)),
                    "t": (self.DT, self.TT, fuel_t, toll_t), "valid_t": valid_t},
        }
