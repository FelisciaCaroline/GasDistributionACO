"""SQLite layer: schema, seed data, settings helpers, urgency helpers."""
import copy
import json
import os
import sqlite3
import time
from contextlib import contextmanager

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("CNG_DB", os.path.join(BASE_DIR, "data", "cng.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'customer',          -- depot | customer
  region TEXT NOT NULL DEFAULT 'SBY',             -- toll-zone: SBY, PANDAAN, MALANG, BATU, OTHER
  lat REAL NOT NULL, lng REAL NOT NULL,
  demand REAL NOT NULL DEFAULT 0,                 -- m3 to deliver
  stock REAL NOT NULL DEFAULT 0,                  -- remaining stock (m3)
  stock_max REAL NOT NULL DEFAULT 0,
  stock_min REAL NOT NULL DEFAULT 0,
  daily_use REAL NOT NULL DEFAULT 0,              -- m3 consumed per day
  tw_open REAL NOT NULL DEFAULT 8,                -- clock hour customer opens
  tw_close REAL NOT NULL DEFAULT 18,              -- clock hour customer closes
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS vehicles(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  capacity REAL NOT NULL DEFAULT 5000,
  km_per_l REAL NOT NULL DEFAULT 3.5,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS edges(                 -- manual / CSV overrides of a leg (undirected, a_id < b_id)
  a_id INTEGER NOT NULL, b_id INTEGER NOT NULL,
  dist_nt REAL, cost_nt REAL, dist_t REAL, cost_t REAL,
  PRIMARY KEY(a_id, b_id),
  FOREIGN KEY(a_id) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY(b_id) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, data_version INTEGER,
  summary TEXT, plan TEXT, params TEXT, convergence TEXT
);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, level TEXT, message TEXT);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS road_cache(     -- real road distances/durations from OSRM, per coordinate pair
  pair TEXT NOT NULL, mode TEXT NOT NULL, dist REAL, dur REAL, PRIMARY KEY(pair, mode)
);
"""

DEFAULT_SETTINGS = {
    # --- cost model
    "fuel_price": 6800,            # Rp / litre
    "route_policy": "cheapest",    # cheapest | fastest | balanced (toll vs non-toll choice)
    "value_of_time": 100000,       # Rp / hour (used by 'balanced')
    "driver_cost_per_hour": 0,     # Rp / hour of shift
    "urgency_penalty": 50000,      # Rp per (gamma-1) per day of delay
    "co2_per_liter": 2.68,         # kg CO2 / litre diesel
    # --- road model (used when no CSV override exists for a leg)
    "toll_speed": 60, "nontoll_speed": 40, "urban_speed": 28,
    "toll_factor": 1.22, "nontoll_factor": 1.30, "urban_factor": 1.38,
    "use_osrm": True,              # real road distances & times from OSRM (falls back to estimates if offline)
    "truck_time_factor": 1.3,      # OSRM times are for cars -> multiply for loaded trucks
    "toll_table": {"PANDAAN-SBY": 45000, "MALANG-SBY": 95000, "BATU-SBY": 95000,
                   "MALANG-PANDAAN": 55000, "BATU-PANDAAN": 55000, "BATU-MALANG": 0},
    # --- operations
    "max_shift": 10.0, "shift_start": 8.0,
    "filling_minutes": 10.0, "filling_unit": 50.0,
    "sla_days": 4, "max_days": 30,
    # --- ant colony
    "aco": {"alpha": 1.0, "beta_cost": 2.0, "beta_dist": 1.0, "eps_time": 1.5,
            "delta_urgency": 2.0, "theta_load": 1.0, "rho": 0.3, "Q": 1000000.0,
            "ants": 30, "iterations": 100, "elitist": 2.0, "local_search": True, "seed": None},
}

# name, region, lat, lng, demand, stock-fraction, tw_open, tw_close   (coordinates are approximate - edit in the UI)
SEED_CUSTOMERS = [
    ("Wingheng HR Muh", "SBY", -7.2905, 112.6805, 220, 0.20, 8, 18),
    ("Wingheng Kertajaya", "SBY", -7.2792, 112.7566, 220, 0.62, 8, 18),
    ("Winglok Pregolan", "SBY", -7.2562, 112.7420, 220, 0.18, 8, 18),
    ("Winglok Merr", "SBY", -7.3140, 112.7760, 220, 0.70, 8, 18),
    ("Deka Hotel HR Muh", "SBY", -7.2893, 112.6775, 220, 0.35, 8, 16),
    ("Crab n Co Clnd", "SBY", -7.3050, 112.6320, 220, 0.15, 9, 17),
    ("Beatus GrahaFam", "SBY", -7.3010, 112.6890, 220, 0.48, 8, 18),
    ("SeaMonsters Darmokali", "SBY", -7.2850, 112.7330, 330, 0.80, 8, 18),
    ("XO Cuisine", "SBY", -7.2640, 112.7460, 440, 0.28, 9, 16),
    ("Maystar Loop", "SBY", -7.3330, 112.7240, 330, 0.12, 8, 18),
    ("Pandaan (Tahesta)", "PANDAAN", -7.6550, 112.7130, 330, 0.40, 8, 18),
    ("Malang (Sirup ABC)", "MALANG", -7.9500, 112.6600, 330, 0.22, 8, 18),
    ("Batu A (Golden Tulip)", "BATU", -7.8700, 112.5290, 660, 0.65, 8, 18),
    ("Batu B (Kusuma Agro)", "BATU", -7.8820, 112.5450, 440, 0.30, 8, 18),
    ("Batu C (Golden Hill)", "BATU", -7.8560, 112.5190, 330, 0.50, 8, 18),
    ("Batu D (Jatimpark2)", "BATU", -7.8890, 112.5290, 440, 0.17, 8, 18),
    ("Batu E (Jatimpark3)", "BATU", -7.8700, 112.5000, 440, 0.72, 8, 18),
    ("Batu F (Amarta Hills)", "BATU", -7.8470, 112.5230, 440, 0.38, 8, 18),
    ("Batu G (Singhasari)", "BATU", -7.8930, 112.5400, 660, 0.25, 8, 18),
    ("Batu H (Lembah Metro)", "BATU", -7.8390, 112.5410, 330, 0.55, 8, 18),
]
DEPOT = ("Gudang SBY", "SBY", -7.3350, 112.7800)
SEED_DAILY_DIV = [4.0, 6.0, 3.5, 5.5, 4.5, 3.0, 5.0, 6.0, 3.5, 3.0, 4.0, 3.5, 5.0, 4.0, 5.5, 3.2, 6.0, 4.5, 3.8, 5.0]


def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def db():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ---------------------------------------------------------------- settings / meta
def get_settings(conn):
    s = copy.deepcopy(DEFAULT_SETTINGS)
    for r in conn.execute("SELECT key, value FROM settings"):
        v = json.loads(r["value"])
        if isinstance(s.get(r["key"]), dict) and isinstance(v, dict):
            s[r["key"]].update(v)
        else:
            s[r["key"]] = v
    return s


def save_settings(conn, patch):
    for k, v in patch.items():
        if k not in DEFAULT_SETTINGS:
            continue
        if isinstance(DEFAULT_SETTINGS[k], dict) and isinstance(v, dict):
            cur = get_settings(conn)[k]
            cur.update(v)
            v = cur
        conn.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                     (k, json.dumps(v)))
    bump_version(conn)


def data_version(conn):
    r = conn.execute("SELECT value FROM meta WHERE key='data_version'").fetchone()
    return int(r["value"]) if r else 1


def bump_version(conn):
    conn.execute("INSERT INTO meta(key,value) VALUES('data_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 (str(data_version(conn) + 1),))


def log_event(conn, level, message):
    conn.execute("INSERT INTO events(ts,level,message) VALUES(?,?,?)", (now(), level, message))


# ---------------------------------------------------------------- urgency helpers (same formula as the notebook)
def urgency(n):
    smax, smin, s = n["stock_max"], n["stock_min"], n["stock"]
    if n["kind"] != "customer" or smax <= smin:
        return 1.0
    return 1 + (smax - max(smin, min(s, smax))) / (smax - smin)


def days_cover(n):
    du = n["daily_use"]
    if not du or du <= 0:
        return None
    return max(n["stock"] - n["stock_min"], 0) / du


def decorate(n):
    n = dict(n)
    g = urgency(n)
    dc = days_cover(n)
    n["gamma"] = round(g, 3)
    n["days_cover"] = None if dc is None else round(dc, 2)
    n["level"] = "critical" if g >= 1.75 else "warning" if g >= 1.4 else "normal"
    n["active"] = bool(n["active"])
    return n


# ---------------------------------------------------------------- init / seed
def init_db():
    with db() as conn:
        conn.executescript(SCHEMA)
        if conn.execute("SELECT COUNT(*) c FROM nodes").fetchone()["c"] == 0:
            seed(conn)


def seed(conn):
    conn.execute("INSERT INTO nodes(name,kind,region,lat,lng,demand,tw_open,tw_close,created_at) VALUES(?,?,?,?,?,0,0,24,?)",
                 (DEPOT[0], "depot", DEPOT[1], DEPOT[2], DEPOT[3], now()))
    for i, (name, reg, lat, lng, dem, frac, o, c) in enumerate(SEED_CUSTOMERS):
        smax, smin = dem * 3.0, dem * 0.3
        conn.execute(
            "INSERT INTO nodes(name,kind,region,lat,lng,demand,stock,stock_max,stock_min,daily_use,tw_open,tw_close,created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (name, "customer", reg, lat, lng, dem, round(smax * frac, 1), smax, smin,
             round(dem / SEED_DAILY_DIV[i], 1), o, c, now()))
    for i, (nm, kmpl) in enumerate([("CNG-TRUCK-01", 3.6), ("CNG-TRUCK-02", 3.4), ("CNG-TRUCK-03", 3.2)]):
        conn.execute("INSERT INTO vehicles(name,capacity,km_per_l) VALUES(?,?,?)", (nm, 5000, kmpl))
    log_event(conn, "info", "Database initialised with demo data (1 depot, 20 customers, 3 trucks)")
    bump_version(conn)


def reset_db():
    with db() as conn:
        for t in ("edges", "runs", "events", "settings", "meta", "road_cache", "vehicles", "nodes"):
            conn.execute(f"DELETE FROM {t}")
        conn.execute("DELETE FROM sqlite_sequence")
        seed(conn)
