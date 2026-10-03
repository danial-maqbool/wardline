"""The three models behind the dashboard, each backtested on days the model never saw.

1. ED arrivals, hourly, 48 hours ahead: a weekly arrival profile (day of week x hour, eight weeks) scaled by the
   current level of demand, with a damped trend so a building surge is followed. 80% intervals are Poisson spread
   widened by a factor calibrated on held-out days. Compared with: same hour last week; four-week same-hour average.
   (A gradient-boosted model was tried first; it did not beat the four-week average, so it is not used.)
2. Bed release within 24 / 48 / 72 hours, per inpatient: gradient-boosted classifier on what the unit can see
   (unit, service, age, hours in hospital vs typical, documented barriers, expected discharge date, a discharge
   order). Compared with the rule of thumb "how far past a typical stay is this patient".
3. Census per unit, 24-72 hours ahead: each current patient stays with probability 1 - p(release); an ICU release
   is a move to step-down or medicine, not a discharge; newly admitted patients still in a bed at the horizon are
   estimated from the last three weeks. Compared with "the census stays where it is".
"""
from __future__ import annotations

import numpy as np
from scipy.stats import poisson
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import brier_score_loss, roc_auc_score

from .hospital import LOS_MEDIAN_H, NOW_MIN, START, UNITS

UNIT_KEYS = [u[0] for u in UNITS]
SERVICES = list(LOS_MEDIAN_H)
SOURCES = ["ED", "ELECTIVE", "MAT", "DIRECT"]
TEST_FROM_DAY = 68
WEEK0 = START.weekday() * 24


# ------------------------------------------------------------------------------------------ arrivals
def hourly_arrivals(R) -> np.ndarray:
    n = int(NOW_MIN // 60)
    y = np.zeros(n)
    for v in R.ed.values():
        h = int(v["arrive"] // 60)
        if h < n:
            y[h] += 1
    return y


def seasonal_level(y, origin, horizon=48, weeks=8, half_life_h=36.0):
    hrs = np.arange(max(0, origin - weeks * 168), origin)
    prof, cnt = np.zeros(168), np.zeros(168)
    np.add.at(prof, (hrs + WEEK0) % 168, y[hrs])
    np.add.at(cnt, (hrs + WEEK0) % 168, 1)
    prof = prof / np.maximum(cnt, 1)
    look = np.arange(origin - 120, origin)
    w = 0.5 ** ((origin - 1 - look) / half_life_h)
    exp_ = prof[(look + WEEK0) % 168]
    level = float((w * y[look]).sum() / max((w * exp_).sum(), 1e-6))
    recent = y[origin - 48:origin].sum() / max(exp_[-48:].sum(), 1e-6)
    before = y[origin - 120:origin - 72].sum() / max(exp_[:48].sum(), 1e-6)
    slope = (recent - before) / 72.0
    k = np.arange(horizon)
    lv = level + 0.5 * slope * np.minimum(k + 24, 72)
    return np.maximum(0.0, prof[(origin + k + WEEK0) % 168] * lv)


def _interval(mean, q):
    return poisson.ppf(0.1, np.maximum(mean * (1 - q), 1e-6)).astype(float), poisson.ppf(0.9, mean * (1 + q)).astype(float)


def fit_arrivals(y):
    last = int(NOW_MIN // 1440)
    cal_o = [d * 24 + 14 for d in range(TEST_FROM_DAY - 14, TEST_FROM_DAY - 2)]
    test_o = [d * 24 + 14 for d in range(TEST_FROM_DAY, last - 1)]
    best_q = 0.4
    for q in np.linspace(-0.3, 0.4, 71):                                  # widen until held-out coverage reaches 80%
        cov = np.mean([((y[o:o + 48] >= lo) & (y[o:o + 48] <= hi)).mean()
                       for o in cal_o for lo, hi in [_interval(seasonal_level(y, o), q)]])
        if cov >= 0.8:
            best_q = float(q)
            break
    P, Yt, N1, A4, LO, HI = [], [], [], [], [], []
    tot, tp, tn, ta = [], [], [], []
    for o in test_o:
        m = seasonal_level(y, o)
        lo, hi = _interval(m, best_q)
        yt = y[o:o + 48]
        n1 = y[o - 168:o - 120]
        a4 = np.mean([y[o - 168 * j:o - 168 * j + 48] for j in range(1, 5)], axis=0)
        for a, b in ((P, m), (Yt, yt), (N1, n1), (A4, a4), (LO, lo), (HI, hi)):
            a.extend(b)
        tot.append(yt[:24].sum()); tp.append(m[:24].sum()); tn.append(n1[:24].sum()); ta.append(a4[:24].sum())
    P, Yt, N1, A4, LO, HI, tot = map(np.array, (P, Yt, N1, A4, LO, HI, tot))
    mape = lambda v: round(100 * float(np.mean(np.abs(np.array(v) - tot) / tot)), 1)
    mae = lambda v: round(float(np.mean(np.abs(v - Yt))), 3)
    metrics = {"model": "weekly profile x current level, damped trend", "test_origins": len(test_o), "hours_scored": int(len(Yt)),
               "mae": mae(P), "mae_last_week": mae(N1), "mae_4wk_avg": mae(A4),
               "next24_mape": mape(tp), "next24_mape_last_week": mape(tn), "next24_mape_4wk_avg": mape(ta),
               "interval80_coverage": round(100 * float(np.mean((Yt >= LO) & (Yt <= HI))), 1), "interval_widening": round(best_q, 2)}
    origin = int(NOW_MIN // 60)
    m = seasonal_level(y, origin)
    lo, hi = _interval(m, best_q)
    hist = y[origin - 72:origin].tolist()
    live = {"origin_h": origin, "mean": m.round(2).tolist(), "lo": lo.tolist(), "hi": hi.tolist(), "history": hist}
    return metrics, live


# ------------------------------------------------------------------------------------------ bed release
def snapshot_features(P, snap):
    p = P[snap["pid"]]
    svc = "critical" if snap["phase"] == "icu" else (p.icu_next if snap["phase"] == "post" else p.service)
    exp_h = LOS_MEDIAN_H[svc]
    t = snap["t"]
    tp = snap.get("t_plan")
    edd = (tp + p.edd_err_h * 60 - t) / 60 if (p.edd_known and tp is not None) else np.nan
    order = int(tp is not None and snap["phase"] != "icu" and int(tp // 1440) == int(t // 1440) and (t % 1440) >= 600 and p.order_u < 0.6)
    f = [p.age, snap["los_h"], snap["in_unit_h"], exp_h, snap["in_unit_h"] / exp_h, ((t // 1440) + START.weekday()) % 7,
         (t % 1440) / 60, int(p.iso), int(p.tele), edd, order,
         int("transport" in p.seen_barriers), int("imaging" in p.seen_barriers), int("placement" in p.seen_barriers),
         int(snap["phase"] == "icu"), int(snap["phase"] == "post")]
    f += [int(snap["unit"] == u) for u in UNIT_KEYS] + [int(svc == s) for s in SERVICES] + [int(p.source == s) for s in SOURCES]
    return f


FEATURE_NAMES = (["age", "hours in hospital", "hours on unit", "typical stay (h)", "progress vs typical", "weekday", "hour",
                  "isolation", "telemetry", "hours to expected discharge date", "discharge order written",
                  "barrier: transport", "barrier: imaging", "barrier: placement", "in ICU", "after ICU"]
                 + [f"unit {u}" for u in UNIT_KEYS] + [f"service {s}" for s in SERVICES] + [f"source {s}" for s in SOURCES])


def _clf():
    return HistGradientBoostingClassifier(max_iter=250, learning_rate=0.06, max_leaf_nodes=20, random_state=7)


def fit_release(R, horizons=(24, 48, 72)):
    rel = {}
    for s in R.stays:
        rel.setdefault(s["pid"], []).append((s["t_in"], s["t_out"], s["unit"]))
    X, T, Y = [], [], {h: [] for h in horizons}
    for sn in R.snapshots:
        if sn["t"] + max(horizons) * 60 > NOW_MIN:
            continue                                                   # outcome not known yet
        t_out = next((o for i, o, u in rel.get(sn["pid"], []) if i <= sn["t"] < o and u == sn["unit"]), None)
        X.append(snapshot_features(R.patients, sn)); T.append(sn["t"])
        for h in horizons:
            Y[h].append(int(t_out is not None and t_out <= sn["t"] + h * 60))
    X, T = np.array(X, float), np.array(T)
    tr, te = T < TEST_FROM_DAY * 1440, T >= TEST_FROM_DAY * 1440
    models, train_models, metrics = {}, {}, {}
    for h in horizons:
        y = np.array(Y[h])
        m = _clf().fit(X[tr], y[tr])
        p = m.predict_proba(X[te])[:, 1]
        cal = []
        for a, b in zip(np.linspace(0, 0.9, 10), np.linspace(0.1, 1.0, 10)):
            k = (p >= a) & ((p < b) if b < 1 else (p <= b))
            if k.sum() >= 5:
                cal.append({"p": round(float(p[k].mean()), 3), "obs": round(float(y[te][k].mean()), 3), "n": int(k.sum())})
        ece = sum(c["n"] * abs(c["p"] - c["obs"]) for c in cal) / max(1, sum(c["n"] for c in cal))
        metrics[h] = {"train": int(tr.sum()), "test": int(te.sum()), "positive_rate": round(float(y[te].mean()), 3),
                      "auc": round(float(roc_auc_score(y[te], p)), 3), "auc_rule": round(float(roc_auc_score(y[te], X[te, 4])), 3),
                      "brier": round(float(brier_score_loss(y[te], p)), 4), "ece": round(float(ece), 4), "calibration": cal}
        train_models[h] = m
        models[h] = _clf().fit(X, y)
    return models, train_models, metrics


def live_rows(R):
    return [{"t": NOW_MIN, "pid": pid, "unit": info["unit"], "phase": info["phase"], "los_h": (NOW_MIN - info["t_admit"]) / 60,
             "in_unit_h": (NOW_MIN - info["t_in"]) / 60, "t_plan": info.get("t_plan")} for pid, info in R.now["inpatients"].items()]


def live_release(R, models):
    rows = live_rows(R)
    X = np.array([snapshot_features(R.patients, sn) for sn in rows], float)
    probs = {h: m.predict_proba(X)[:, 1] for h, m in models.items()}
    return {sn["pid"]: {h: round(float(probs[h][i]), 3) for h in models} for i, sn in enumerate(rows)}


# ------------------------------------------------------------------------------------------ census
STEP_DEST = {"stepdown": {"SDU": 1.0}, "medicine": {"MEDA": 0.5, "MEDB": 0.5}}


def new_admission_carry(R, t, h, days=21):
    """Patients admitted inside an h-hour window who are still in a bed at its end, per unit, from recent history."""
    acc = {u: 0.0 for u in UNIT_KEYS}
    # same-weekday windows (elective surgery only runs Monday to Friday) that have fully ended by time t
    starts = [t - 7 * k * 1440 for k in range(1, 5) if t - 7 * k * 1440 + h * 60 <= t and t - 7 * k * 1440 >= 7 * 1440]
    stays = [s for s in all_stays(R) if s["phase"] != "post" and s["t_in"] < t]
    recent = sum(1 for s in stays if t - 7 * 1440 <= s["t_in"]) / 7
    base = sum(1 for s in stays if t - 28 * 1440 <= s["t_in"]) / 28
    surge = recent / max(base, 1e-6)                                    # admissions are running above or below normal
    for s in stays:
        for o in starts:
            if o < s["t_in"] <= o + h * 60 < s["t_out"]:                # still in that bed at o + h, which is <= t
                acc[s["unit"]] += 1
    return {u: v / max(len(starts), 1) * surge for u, v in acc.items()}


def all_stays(R):
    """Completed stays plus the ones still in progress at the end of the run."""
    if "_all" not in R.__dict__:
        ongoing = [{"pid": pid, "unit": i["unit"], "t_in": i["t_in"], "t_out": float("inf"), "phase": i["phase"]}
                   for pid, i in R.now["inpatients"].items()]
        R.__dict__["_all"] = R.stays + ongoing
    return R.__dict__["_all"]


def _project(rows, probs, P, carry):
    pred = {u: 0.0 for u in UNIT_KEYS}
    for sn, pp in zip(rows, probs):
        pred[sn["unit"]] += 1 - pp
        if sn["phase"] == "icu":                                       # an ICU release is a move, not a discharge
            for u, w in STEP_DEST[P[sn["pid"]].icu_next].items():
                pred[u] += pp * w
    for u in UNIT_KEYS:
        pred[u] += carry[u]
    return pred


def census_forecast(R, live_models, horizons=(24, 48, 72)):
    rows = live_rows(R)
    X = np.array([snapshot_features(R.patients, sn) for sn in rows], float)
    cur = {u: sum(1 for sn in rows if sn["unit"] == u) for u in UNIT_KEYS}
    out = {h: {u: round(float(v), 1) for u, v in _project(rows, live_models[h].predict_proba(X)[:, 1], R.patients,
                                                   new_admission_carry(R, NOW_MIN, h)).items()} for h in horizons}
    return cur, out


def backtest_census(R, train_models, horizons=(24, 48, 72)):
    """Census at +24 h and +48 h from every 14:00 in the test window, using release models that never saw it."""
    occ = {h["t"] // 60: {u: h[f"occ_{u}"] for u in UNIT_KEYS} for h in R.hourly}
    snaps = {}
    for sn in R.snapshots:
        snaps.setdefault(sn["t"], []).append(sn)
    res = {h: {"err": [], "err_naive": [], "unit_err": [], "unit_err_naive": [], "bias": []} for h in horizons}
    for d in range(TEST_FROM_DAY, int(NOW_MIN // 1440) - 1):
        t = d * 1440 + 14 * 60
        rows = snaps.get(t, [])
        if not rows:
            continue
        X = np.array([snapshot_features(R.patients, sn) for sn in rows], float)
        cur = {u: sum(1 for sn in rows if sn["unit"] == u) for u in UNIT_KEYS}
        for h in horizons:
            act = occ.get(t // 60 + h)
            if act is None:
                continue
            pred = _project(rows, train_models[h].predict_proba(X)[:, 1], R.patients, new_admission_carry(R, t, h))
            res[h]["err"].append(abs(sum(pred.values()) - sum(act.values())))
            res[h]["bias"].append(sum(pred.values()) - sum(act.values()))
            res[h]["err_naive"].append(abs(sum(cur.values()) - sum(act.values())))
            res[h]["unit_err"].append(np.mean([abs(pred[u] - act[u]) for u in UNIT_KEYS]))
            res[h]["unit_err_naive"].append(np.mean([abs(cur[u] - act[u]) for u in UNIT_KEYS]))
    r2 = lambda v: round(float(np.mean(v)), 2)
    return {h: {"origins": len(v["err"]), "mae_hospital": r2(v["err"]), "bias_hospital": r2(v["bias"]),
                "mae_hospital_persistence": r2(v["err_naive"]), "mae_unit": r2(v["unit_err"]),
                "mae_unit_persistence": r2(v["unit_err_naive"])} for h, v in res.items()}
