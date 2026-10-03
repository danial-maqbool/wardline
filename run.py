"""Regenerate everything Wardline reports, from scratch, in under a minute.

  1. generate 90 days of patients for Halvern Bay General (fictional, seeded)
  2. replay them twice: first-come-first-served placement, then Wardline placement (same patients, same draws)
  3. fit and backtest the arrivals, bed-release and census models
  4. export the live state at Sat 3 Oct 2026 14:20 and the history for the dashboard

Nothing here is hand-typed: every number in the README and the dashboard comes from this run.
"""
from __future__ import annotations

import json
import statistics as st
import time
from pathlib import Path

from wardline import models as M
from wardline import sim
from wardline.hospital import (DAYS, ED_PER_DAY, FIT, NOW_MIN, OUTLIER, START, UNITS, at, build_beds, make_patients)

OUT = Path(__file__).parent / "results"
TOTAL_BEDS = sum(u[3] for u in UNITS)
SURGE_FROM_DAY = 80


def policy_metrics(R, day_from=0, day_to=DAYS):
    a, b = day_from * 1440, day_to * 1440
    ed_req = [r for r in R.requests if r.origin == "ED" and r.t_move is not None and a <= r.t < b]
    board = sorted((r.t_move - r.t) / 60 for r in ed_req)
    visits = [v for v in R.ed.values() if a <= v["arrive"] < b]
    placed = [r for r in R.requests if r.fit is not None and a <= r.t < b]
    q = lambda p: round(board[int(p * (len(board) - 1))], 2)
    return {"ed_visits": len(visits), "ed_admissions_placed": len(ed_req), "boarding_median_h": round(st.median(board), 2),
            "boarding_mean_h": round(st.mean(board), 2), "boarding_p90_h": q(0.9),
            "boarding_over_4h_pct": round(100 * sum(x > 4 for x in board) / len(board), 1),
            "lwbs_pct": round(100 * sum(v["lwbs"] for v in visits) / len(visits), 2),
            "lwbs": sum(v["lwbs"] for v in visits),
            "outliers": sum(r.fit >= OUTLIER for r in placed), "placements": len(placed),
            "outlier_pct": round(100 * sum(r.fit >= OUTLIER for r in placed) / len(placed), 1)}


def daily(R):
    out = []
    for d in range(DAYS):
        a, b = d * 1440, (d + 1) * 1440
        if a >= NOW_MIN:
            break
        board = [(r.t_move - r.t) / 60 for r in R.requests if r.origin == "ED" and r.t_move is not None and a <= r.t < b]
        v = [x for x in R.ed.values() if a <= x["arrive"] < b]
        hrs = [h for h in R.hourly if a <= h["t"] < b]
        occ = [sum(h[f"occ_{u[0]}"] for u in UNITS) / TOTAL_BEDS for h in hrs]
        out.append({"day": d, "date": at(a).date().isoformat(), "arrivals": len(v), "lwbs": sum(x["lwbs"] for x in v),
                    "board_median_h": round(st.median(board), 2) if board else None,
                    "board_over4": sum(x > 4 for x in board), "admits": len(board),
                    "occ_mean": round(st.mean(occ), 3) if occ else None, "occ_max": round(max(occ), 3) if occ else None,
                    "boarders_max": max((h["boarders"] for h in hrs), default=0)})
    return out


def surge_level(h):
    occ = sum(h[f"occ_{u[0]}"] for u in UNITS) / TOTAL_BEDS
    ed = (h["in_bays"] + h["waiting"]) / sim.ED_BAYS
    b = h["boarders"]
    if occ >= 0.97 or ed >= 1.6 or b >= 14:
        return 4
    if occ >= 0.92 or ed >= 1.25 or b >= 8:
        return 3
    if occ >= 0.85 or ed >= 0.95 or b >= 4:
        return 2
    return 1


def main():
    OUT.mkdir(exist_ok=True)
    t0 = time.perf_counter()
    pts = make_patients()
    RB = sim.run("baseline", pts)
    RW = sim.run("wardline", pts)
    sim_s = time.perf_counter() - t0

    pol = {"all": {"baseline": policy_metrics(RB), "wardline": policy_metrics(RW)},
           "surge": {"baseline": policy_metrics(RB, SURGE_FROM_DAY), "wardline": policy_metrics(RW, SURGE_FROM_DAY)}}
    board_hist = {}
    for name, R in (("baseline", RB), ("wardline", RW)):
        bins = [0] * 13
        for r in R.requests:
            if r.origin == "ED" and r.t_move is not None:
                bins[min(12, int((r.t_move - r.t) / 60))] += 1
        board_hist[name] = bins

    t1 = time.perf_counter()
    y = M.hourly_arrivals(RW)
    arr_metrics, arr_live = M.fit_arrivals(y)
    rel_models, rel_train, rel_metrics = M.fit_release(RW)
    census_bt = M.backtest_census(RW, rel_train)
    live_rel = M.live_release(RW, rel_models)
    cur, census = M.census_forecast(RW, rel_models)
    model_s = time.perf_counter() - t1

    # ---------------- live state at NOW
    beds = build_beds()
    now = RW.now
    p24 = {pid: v[24] for pid, v in live_rel.items()}
    recs = RW.sim.recommend(p24)
    P = RW.patients
    bed_rows = []
    for b, s in zip(beds, now["beds"]):
        row = {"bed": b.id, "idx": b.idx, "unit": b.unit, "room": b.room, "single": b.single, "tele": b.tele, "status": s["status"],
               "ready_in": s["ready_in"], "dirty_min": s["dirty_min"]}
        pid = s["occupant"] or s["reserved_for"]
        if pid is not None:
            p, info = P[pid], now["inpatients"].get(pid, {})
            row.update({"pid": pid, "age": p.age, "sex": p.sex, "service": p.service if info.get("phase") != "post" else p.icu_next,
                        "iso": p.iso, "source": p.source, "barriers": sorted(p.seen_barriers),
                        "hours_in": round((NOW_MIN - info["t_admit"]) / 60, 1) if info else None,
                        "p24": live_rel.get(pid, {}).get(24), "p48": live_rel.get(pid, {}).get(48),
                        "outlier": bool(info.get("outlier")) if info else False,
                        "edd_h": round((info["t_plan"] + p.edd_err_h * 60 - NOW_MIN) / 60, 1) if info.get("t_plan") and p.edd_known else None})
        bed_rows.append(row)
    ed_wait = [{"pid": pid, "esi": P[pid].esi, "age": P[pid].age, "sex": P[pid].sex, "complaint": P[pid].complaint,
                "wait_min": round(NOW_MIN - RW.ed[pid]["arrive"])} for pid in now["waiting"]]
    open_by_pid = {r["pid"]: r for r in now["open"]}
    bays = []
    for pid, start in sorted(now["bays"].items(), key=lambda x: x[1]):
        v = RW.ed[pid]
        st_ = "boarding" if v["decision"] is not None else "treating"
        bays.append({"pid": pid, "esi": P[pid].esi, "age": P[pid].age, "sex": P[pid].sex, "complaint": P[pid].complaint, "status": st_,
                     "minutes": round(NOW_MIN - v["arrive"]), "boarding_min": round(NOW_MIN - v["decision"]) if v["decision"] else None,
                     "service": P[pid].service if st_ == "boarding" else None, "assigned": st_ == "boarding" and pid not in open_by_pid})
    h_now = RW.hourly[-1]
    levels = [{"t": h["t"], "level": surge_level(h)} for h in RW.hourly[-14 * 24:]]
    occ_now = sum(1 for b in bed_rows if b["status"] == "occupied")
    kpis = {"occupancy_pct": round(100 * occ_now / TOTAL_BEDS, 1), "occupied": occ_now, "beds": TOTAL_BEDS,
            "clean": sum(b["status"] == "clean" for b in bed_rows), "cleaning": sum(b["status"] == "cleaning" for b in bed_rows),
            "dirty": sum(b["status"] == "dirty" for b in bed_rows), "reserved": sum(b["status"] == "reserved" for b in bed_rows),
            "ed_waiting": len(ed_wait), "ed_in_bays": len(bays), "ed_bays": sim.ED_BAYS,
            "boarders": sum(1 for b in bays if b["status"] == "boarding"),
            "longest_wait_min": max((w["wait_min"] for w in ed_wait), default=0),
            "open_requests": len(now["open"]), "expected_releases_24h": round(sum(p24.values()), 1),
            "lwbs_today": sum(1 for v in RW.ed.values() if v["lwbs"] and v["arrive"] >= (NOW_MIN // 1440) * 1440),
            "arrivals_today": sum(1 for v in RW.ed.values() if v["arrive"] >= (NOW_MIN // 1440) * 1440),
            "surge_level": surge_level(h_now)}
    # last six hours of admit / discharge / transfer / arrival events, newest first
    since = NOW_MIN - 6 * 60
    bed_id = {b.idx: b.id for b in beds}
    ev = []
    for r in RW.requests:
        if r.t_move is not None and r.t_move >= since:
            ev.append({"t": r.t_move, "kind": "transfer" if r.origin == "ICU" else "admit", "pid": r.pid, "bed": bed_id[r.bed],
                       "unit": beds[r.bed].unit, "from": r.origin, "wait_min": round(r.t_move - r.t)})
    for s_ in RW.stays:
        if s_["final"] and s_["t_out"] >= since:
            ev.append({"t": s_["t_out"], "kind": "discharge", "pid": s_["pid"], "bed": bed_id[s_["bed"]], "unit": s_["unit"],
                       "los_h": round((s_["t_out"] - s_["t_in"]) / 60)})
    for pid, v in RW.ed.items():
        if v["arrive"] >= NOW_MIN - 90:
            ev.append({"t": v["arrive"], "kind": "arrival", "pid": pid, "esi": v["esi"], "complaint": P[pid].complaint})
        if v["lwbs"] and v["depart"] >= since:
            ev.append({"t": v["depart"], "kind": "lwbs", "pid": pid, "esi": v["esi"]})
    ev.sort(key=lambda e: -e["t"])
    for e in ev:
        e["at"] = at(e["t"]).strftime("%H:%M")
    live = {"now": at(NOW_MIN).isoformat(), "kpis": kpis, "events": ev[:60], "beds": bed_rows, "ed_waiting": ed_wait, "bays": bays, "recommendations": recs,
            "census_now": cur, "census_forecast": census, "arrivals_forecast": arr_live, "surge_levels": levels}

    layout = {"hospital": "Halvern Bay General", "units": [{"key": u[0], "name": u[1], "floor": u[2], "beds": u[3]} for u in UNITS],
              "beds": [{"bed": b.id, "idx": b.idx, "unit": b.unit, "room": b.room, "single": b.single, "tele": b.tele} for b in beds],
              "ed_bays": sim.ED_BAYS, "start": START.isoformat(), "now": at(NOW_MIN).isoformat(), "fit": FIT}
    hourly = [{"t": h["t"], "waiting": h["waiting"], "in_bays": h["in_bays"], "boarders": h["boarders"],
               "occ": sum(h[f"occ_{u[0]}"] for u in UNITS), **{u[0]: h[f"occ_{u[0]}"] for u in UNITS}} for h in RW.hourly]
    metrics = {"simulation": {"days": DAYS, "patients": len(pts), "ed_visits": len(RW.ed), "ed_per_day_base": ED_PER_DAY,
                              "beds": TOTAL_BEDS, "ed_bays": sim.ED_BAYS, "seconds_both_runs": round(sim_s, 1),
                              "admissions_per_day": round(sum(1 for p in pts if p.admit) / DAYS, 1)},
               "policy": pol, "boarding_hist": board_hist,
               "arrivals": arr_metrics, "release": rel_metrics, "census": census_bt, "model_seconds": round(model_s, 1),
               "feature_names": M.FEATURE_NAMES}
    for name, obj in (("metrics", metrics), ("live", live), ("layout", layout), ("hourly", hourly),
                      ("daily", {"baseline": daily(RB), "wardline": daily(RW)}), ("replay", RW.bed_history)):
        (OUT / f"{name}.json").write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")

    A, B, S1, S2 = pol["all"]["baseline"], pol["all"]["wardline"], pol["surge"]["baseline"], pol["surge"]["wardline"]
    lines = [
        f"Simulation: {DAYS} days, {len(pts):,} patients, {len(RW.ed):,} ED visits, {TOTAL_BEDS} beds, {sim.ED_BAYS} ED bays, both policies in {sim_s:.1f} s",
        f"Placement, 90 days (first-come-first-served -> Wardline): boarding over 4 h {A['boarding_over_4h_pct']}% -> {B['boarding_over_4h_pct']}%,"
        f" p90 {A['boarding_p90_h']} h -> {B['boarding_p90_h']} h, median {A['boarding_median_h']} h -> {B['boarding_median_h']} h,"
        f" LWBS {A['lwbs_pct']}% -> {B['lwbs_pct']}% ({A['lwbs']} -> {B['lwbs']} patients), outliers {A['outliers']} -> {B['outliers']}",
        f"  surge days {SURGE_FROM_DAY}-{DAYS}: over 4 h {S1['boarding_over_4h_pct']}% -> {S2['boarding_over_4h_pct']}%, LWBS {S1['lwbs_pct']}% -> {S2['lwbs_pct']}%",
        f"Arrivals 48 h: hourly MAE {arr_metrics['mae']} (last week {arr_metrics['mae_last_week']}, 4-week avg {arr_metrics['mae_4wk_avg']});"
        f" next-24h error {arr_metrics['next24_mape']}% (vs {arr_metrics['next24_mape_last_week']}% / {arr_metrics['next24_mape_4wk_avg']}%);"
        f" 80% band covered {arr_metrics['interval80_coverage']}% of hours",
        f"Bed release in 24 h: AUC {rel_metrics[24]['auc']} (length-of-stay rule {rel_metrics[24]['auc_rule']}), Brier {rel_metrics[24]['brier']}, ECE {rel_metrics[24]['ece']}",
        f"Census 48 h: hospital MAE {census_bt[48]['mae_hospital']} beds (persistence {census_bt[48]['mae_hospital_persistence']}),"
        f" per unit {census_bt[48]['mae_unit']} (persistence {census_bt[48]['mae_unit_persistence']})",
        f"Now ({at(NOW_MIN):%a %d %b %H:%M}): occupancy {kpis['occupancy_pct']}%, ED {kpis['ed_in_bays']}/{sim.ED_BAYS} bays + {kpis['ed_waiting']} waiting,"
        f" {kpis['boarders']} boarders, surge level {kpis['surge_level']}, {kpis['expected_releases_24h']} beds expected to free in 24 h",
    ]
    (OUT / "summary.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
