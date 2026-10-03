"""Discrete-event simulation of patient flow at Halvern Bay General, under a choice of bed-placement policy.

Policies
  baseline   what most hospitals do by phone and whiteboard: requests first-come-first-served, the first clean
             bed that fits, cleaning crews work in the order beds were vacated, outliers after 6 hours.
  wardline   every 10 minutes, assign all waiting requests to clean beds AND beds that will be clean within
             30 minutes in one optimal matching (Hungarian algorithm) weighted by acuity and waiting time;
             cleaning crews go first to beds that a waiting patient can use. Same 6-hour outlier rule.

The two runs share every random draw (hospital.make_patients), so differences are caused by the policy.
"""
from __future__ import annotations

import heapq
import math
from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import linear_sum_assignment

from .hospital import (DAYS, FIT, NOW_MIN, OUTLIER, UNITS, Bed, Patient, build_beds, make_patients)

ED_BAYS = 34
OUTLIER_AFTER_MIN = 360
PRIORITY = {"ICU": 3.0, "critical": 3.0}
HISTORY_DAYS = 7                                     # hourly bed-status snapshots kept for the replay view


def crews_at(minute: float) -> int:
    h = (minute % 1440) / 60
    return 6 if 7 <= h < 19 else 3


@dataclass
class Request:
    rid: int
    pid: int
    origin: str          # ED | ELECTIVE | MAT | DIRECT | ICU
    service: str
    tele: bool
    iso: bool
    sex: str
    t: float
    priority: float
    bed: int | None = None
    t_assign: float | None = None
    t_move: float | None = None
    fit: int | None = None


@dataclass
class BedState:
    status: str = "clean"        # clean | occupied | dirty | cleaning | reserved
    occupant: int | None = None
    reserved_for: int | None = None
    dirty_since: float = 0.0
    clean_end: float = 0.0
    clean_min: float = 40.0


@dataclass
class Result:
    policy: str
    requests: list
    ed: dict
    stays: list
    hourly: list
    bed_history: list
    now: dict
    snapshots: list
    patients: dict


class Sim:
    def __init__(self, patients: list[Patient], policy: str, until: float = NOW_MIN):
        self.P = {p.id: p for p in patients}
        self.arrivals = patients
        self.policy, self.until = policy, until
        self.beds: list[Bed] = build_beds()
        self.bs = [BedState() for _ in self.beds]
        self.room_beds = defaultdict(list)
        for b in self.beds:
            self.room_beds[b.room].append(b.idx)
        self.ev: list = []
        self.seq = 0
        self.t = 0.0
        self.waiting: list[int] = []
        self.bays: dict[int, int] = {}             # pid -> bay start
        self.ed = {}                               # pid -> record
        self.req: dict[int, Request] = {}
        self.open_req: set[int] = set()
        self.req_of: dict[int, int] = {}           # pid -> open rid
        self.inpt: dict[int, dict] = {}            # pid -> {bed, phase, t_in}
        self.stays: list = []
        self.dirty_q: list[int] = []
        self.cleaning: dict[int, float] = {}       # bed idx -> end time
        self.hourly: list = []
        self.bed_history: list = []
        self.snapshots: list = []
        self.rid = 0
        self.lwbs_count = 0

    # ------------------------------------------------------------------ plumbing
    def push(self, t, kind, *data):
        self.seq += 1
        heapq.heappush(self.ev, (t, self.seq, kind, data))

    def run(self) -> Result:
        for p in self.arrivals:
            if p.t_arrive < self.until:
                self.push(p.t_arrive, "arrive", p.id)
        for h in range(int(self.until // 60) + 1):
            self.push(h * 60 + 0.001, "hour")
            if h % 24 in (7, 19):
                self.push(h * 60 + 0.002, "shift")
            if h % 24 in (7, 14):
                self.push(h * 60 + 0.003, "snapshot")
        if self.policy == "wardline":
            for k in range(int(self.until // 10)):
                self.push(k * 10 + 0.004, "tick")
        while self.ev and self.ev[0][0] <= self.until:
            t, _, kind, data = heapq.heappop(self.ev)
            self.t = t
            getattr(self, "on_" + kind)(*data)
        res = Result(self.policy, list(self.req.values()), self.ed, self.stays, self.hourly, self.bed_history,
                     self.now_state(), self.snapshots, self.P)
        res.sim = self
        return res

    # ------------------------------------------------------------------ live recommendations (dashboard)
    def recommend(self, p24: dict, horizon_min=90):
        """For every open request: the best bed now or soon (one optimal matching), and if there is none,
        the compatible occupied bed most likely to be released, using the bed-release model."""
        reqs = [self.req[k] for k in sorted(self.open_req)]
        cand = [b for b in self.beds if self.bs[b.idx].status == "clean" or
                (self.bs[b.idx].status in ("cleaning", "dirty") and self.bs[b.idx].reserved_for is None)]

        def ready_in(b):
            s = self.bs[b.idx]
            if s.status == "clean":
                return 0.0
            if s.status == "cleaning":
                return max(0.0, s.clean_end - self.t)
            return 45.0 + s.clean_min                                  # waiting for a crew, then cleaning

        out = []
        C = np.full((len(reqs), max(1, len(cand))), 1e6)
        for i, r in enumerate(reqs):
            w = (self.t - r.t) / 60
            for j, b in enumerate(cand):
                f = self.fit(r, b)
                if f is None or ready_in(b) > horizon_min:
                    continue
                C[i, j] = (f + 0.4 * ready_in(b) - 30 * r.priority - 6 * w + (4 if b.single and not r.iso else 0)
                           + (3 if b.tele and not r.tele else 0))
        pairs = {}
        if reqs and cand:
            ri, ci = linear_sum_assignment(C)
            for i, j in zip(ri, ci):
                if C[i, j] < 1e5:
                    pairs[i] = j
        used_expected = set()
        order = sorted(range(len(reqs)), key=lambda i: (-reqs[i].priority, reqs[i].t))
        for i in order:
            r = reqs[i]
            p = self.P[r.pid]
            rec = {"rid": r.rid, "pid": r.pid, "origin": r.origin, "service": r.service, "tele": r.tele, "iso": r.iso, "sex": r.sex,
                   "age": p.age, "esi": p.esi, "complaint": p.complaint, "waiting_min": round(self.t - r.t), "priority": r.priority}
            if i in pairs:
                b = cand[pairs[i]]
                f = FIT[r.service][b.unit]
                why = ["Home unit" if f == 0 else ("Sibling unit" if f < OUTLIER else "Outlier, waited 6 h+")]
                if r.iso:
                    why.append("Single room for isolation")
                if r.tele:
                    why.append("Telemetry bed")
                if not b.single:
                    why.append(f"Shared room, same sex")
                ri_ = ready_in(b)
                why.append("Clean now" if ri_ == 0 else f"Clean in {round(ri_)} min")
                rec.update({"bed": b.id, "unit": b.unit, "ready_in": round(ri_), "fit": f, "why": why, "kind": "assign"})
            else:
                best = None
                for b in self.beds:
                    s = self.bs[b.idx]
                    if s.status != "occupied" or s.occupant not in p24 or b.idx in used_expected:
                        continue
                    f = FIT[r.service].get(b.unit)
                    if f is None or (r.iso and not b.single) or (r.tele and not b.tele):
                        continue
                    sc = p24[s.occupant] - f / 100
                    if best is None or sc > best[0]:
                        best = (sc, b, p24[s.occupant])
                if best:
                    used_expected.add(best[1].idx)
                    rec.update({"bed": best[1].id, "unit": best[1].unit, "kind": "expected", "p_release": min(0.99, best[2]),
                                "why": [f"No compatible bed in the next {horizon_min} min",
                                        f"Occupant {min(99, round(100 * best[2]))}% likely to leave within 24 h"]})
                else:
                    rec.update({"kind": "none", "why": ["No compatible bed expected"]})
            out.append(rec)
        return out

    # ------------------------------------------------------------------ ED
    def on_arrive(self, pid):
        p = self.P[pid]
        if p.source == "ED":
            self.ed[pid] = {"arrive": self.t, "esi": p.esi, "start": None, "decision": None, "depart": None, "lwbs": False, "admit": p.admit}
            self.push(self.t + p.triage_min, "triaged", pid)
            if p.patience_min < 1e8:
                self.push(self.t + p.patience_min, "lwbs", pid)
            self.try_bays()
        else:
            self.new_request(pid, p.source, p.service)

    def on_triaged(self, pid):
        if not self.ed[pid]["lwbs"]:
            self.ed[pid]["triaged"] = self.t
            self.waiting.append(pid)
            self.try_bays()

    def try_bays(self):
        while self.waiting and len(self.bays) < ED_BAYS:
            self.waiting.sort(key=lambda q: (self.P[q].esi, self.ed[q]["arrive"]))
            pid = self.waiting.pop(0)
            self.bays[pid] = self.t
            self.ed[pid]["start"] = self.t
            self.push(self.t + self.P[pid].treat_min, "ed_done", pid)

    def on_lwbs(self, pid):
        if pid in self.waiting or (self.ed[pid]["start"] is None and "triaged" not in self.ed[pid]):
            if pid in self.waiting:
                self.waiting.remove(pid)
            self.ed[pid]["lwbs"] = True
            self.ed[pid]["depart"] = self.t
            self.lwbs_count += 1

    def on_ed_done(self, pid):
        p = self.P[pid]
        self.ed[pid]["decision"] = self.t
        if p.admit:
            self.new_request(pid, "ED", p.service)
        else:
            self.leave_ed(pid)

    def leave_ed(self, pid):
        self.bays.pop(pid, None)
        self.ed[pid]["depart"] = self.t
        self.try_bays()

    # ------------------------------------------------------------------ requests and placement
    def new_request(self, pid, origin, service):
        p = self.P[pid]
        self.rid += 1
        pr = 3.0 if service == "critical" else 2.0 if origin == "ICU" else 1.5 if (origin == "ED" and p.esi <= 2) else 1.0
        tele = p.tele if origin != "ICU" else service == "stepdown"
        r = Request(self.rid, pid, origin, service, tele, p.iso, p.sex, self.t, pr)
        self.req[r.rid] = r
        self.open_req.add(r.rid)
        self.req_of[pid] = r.rid
        if self.policy == "baseline":
            self.place_baseline()
        else:
            self.on_tick()

    def fit(self, r: Request, b: Bed, extra_reserved: dict | None = None):
        f = FIT[r.service].get(b.unit)
        if f is None:
            return None
        if r.tele and not b.tele:
            return None
        if r.iso and not b.single:
            return None
        if f >= OUTLIER and self.t - r.t < OUTLIER_AFTER_MIN:
            return None
        if not b.single:
            for j in self.room_beds[b.room]:
                if j == b.idx:
                    continue
                s = self.bs[j]
                other = s.occupant if s.occupant is not None else s.reserved_for
                if other is None and extra_reserved:
                    other = extra_reserved.get(j)
                if other is not None and self.P[other].sex != r.sex:
                    return None
        return f

    def assign(self, r: Request, bi: int):
        s = self.bs[bi]
        r.bed, r.t_assign, r.fit = bi, self.t, FIT[r.service][self.beds[bi].unit]
        self.open_req.discard(r.rid)
        s.reserved_for = r.pid
        if s.status == "clean":
            s.status = "reserved"
            self.push(self.t + self.P[r.pid].transport_min, "move", r.rid)
        # otherwise the move is scheduled when cleaning finishes

    def place_baseline(self):
        for rid in sorted(self.open_req, key=lambda k: self.req[k].t):
            r = self.req[rid]
            best = None
            for b in self.beds:
                if self.bs[b.idx].status != "clean":
                    continue
                f = self.fit(r, b)
                if f is not None and (best is None or f < best[0]):
                    best = (f, b.idx)
                    if f == 0:
                        break
            if best:
                self.assign(r, best[1])

    def on_tick(self):
        if not self.open_req:
            return
        reqs = [self.req[k] for k in sorted(self.open_req)]
        cand = [b for b in self.beds if self.bs[b.idx].status == "clean" or
                (self.bs[b.idx].status == "cleaning" and self.bs[b.idx].reserved_for is None and self.bs[b.idx].clean_end - self.t <= 30)]
        if not cand:
            return
        C = np.full((len(reqs), len(cand)), 1e6)
        for i, r in enumerate(reqs):
            w = (self.t - r.t) / 60
            for j, b in enumerate(cand):
                f = self.fit(r, b)
                if f is None:
                    continue
                ready = max(0.0, self.bs[b.idx].clean_end - self.t) if self.bs[b.idx].status == "cleaning" else 0.0
                C[i, j] = (f + 0.4 * ready - 30 * r.priority - 6 * w + (4 if b.single and not r.iso else 0)
                           + (3 if b.tele and not r.tele else 0))
        ri, ci = linear_sum_assignment(C)
        order = sorted(zip(ri, ci), key=lambda x: C[x[0], x[1]])
        taken = {}
        for i, j in order:
            if C[i, j] >= 1e5:
                continue
            r, b = reqs[i], cand[j]
            if self.fit(r, b, taken) is None:           # same-sex check against this round's other picks
                continue
            taken[b.idx] = r.pid
            self.assign(r, b.idx)

    def on_move(self, rid):
        r = self.req[rid]
        p = self.P[r.pid]
        r.t_move = self.t
        bi = r.bed
        s = self.bs[bi]
        s.status, s.occupant, s.reserved_for = "occupied", r.pid, None
        if r.origin == "ED":
            self.leave_ed(r.pid)
        prev = self.inpt.get(r.pid)
        if prev is not None:                                   # step-down out of the ICU
            self.vacate(prev["bed"], r.pid, prev)
        phase = "icu" if r.service == "critical" else ("post" if r.origin == "ICU" else "stay")
        self.inpt[r.pid] = {"bed": bi, "phase": phase, "t_in": self.t, "unit": self.beds[bi].unit,
                            "t_admit": prev["t_admit"] if prev else self.t, "outlier": r.fit >= OUTLIER}
        los = p.los2_h if phase == "post" else p.los_h
        t_ready = self.t + los * 60
        if phase == "icu":
            self.inpt[r.pid]["t_plan"] = t_ready
            self.push(t_ready, "icu_ready", r.pid)
        else:
            t_dc = self.discharge_time(t_ready, p)
            self.inpt[r.pid]["t_plan"] = t_dc
            self.push(t_dc, "discharge", r.pid)

    def discharge_time(self, t_ready, p: Patient):
        t = t_ready + p.dc_delay_h * 60
        h = (t % 1440) / 60
        if not (9 <= h <= 19.5):
            day = math.floor(t / 1440) + (1 if h > 19.5 else 0)
            t = day * 1440 + p.dc_hour * 60
        return t + sum(p.barriers.values()) * 60

    def on_icu_ready(self, pid):
        self.new_request(pid, "ICU", self.P[pid].icu_next)

    def on_discharge(self, pid):
        info = self.inpt.pop(pid)
        self.vacate(info["bed"], pid, info, final=True)

    def vacate(self, bi, pid, info, final=False):
        s = self.bs[bi]
        self.stays.append({"pid": pid, "bed": bi, "unit": self.beds[bi].unit, "t_in": info["t_in"], "t_out": self.t,
                           "phase": info["phase"], "outlier": info["outlier"], "final": final})
        s.status, s.occupant, s.dirty_since = "dirty", None, self.t
        s.clean_min = self.P[pid].clean_min
        self.dirty_q.append(bi)
        self.start_cleaning()
        if self.policy == "baseline":
            self.place_baseline()

    # ------------------------------------------------------------------ environmental services
    def start_cleaning(self):
        while self.dirty_q and len(self.cleaning) < crews_at(self.t):
            if self.policy == "wardline":
                demand = defaultdict(int)
                for k in self.open_req:
                    r = self.req[k]
                    for u, f in FIT[r.service].items():
                        if f < OUTLIER:
                            demand[u] += 1
                self.dirty_q.sort(key=lambda bi: (-demand[self.beds[bi].unit], self.bs[bi].dirty_since))
            bi = self.dirty_q.pop(0)
            s = self.bs[bi]
            s.status, s.clean_end = "cleaning", self.t + s.clean_min
            self.cleaning[bi] = s.clean_end
            self.push(s.clean_end, "clean_done", bi)

    def on_shift(self):
        self.start_cleaning()

    def on_clean_done(self, bi):
        self.cleaning.pop(bi, None)
        s = self.bs[bi]
        if s.reserved_for is not None:
            s.status = "reserved"
            rid = self.req_of[s.reserved_for]
            r = self.req[rid]
            self.push(max(self.t, r.t_assign + self.P[r.pid].transport_min), "move", rid)
        else:
            s.status = "clean"
        self.start_cleaning()
        if self.policy == "baseline":
            self.place_baseline()
        else:
            self.on_tick()

    # ------------------------------------------------------------------ observation
    def on_hour(self):
        if self.policy == "baseline" and self.open_req:
            self.place_baseline()                      # lets the 6-hour outlier rule fire
        cnt = defaultdict(int)
        st = defaultdict(int)
        for b in self.beds:
            s = self.bs[b.idx]
            st[s.status] += 1
            if s.status in ("occupied",):
                cnt[b.unit] += 1
        boarders = len([pid for pid in self.bays if self.ed[pid]["decision"] is not None])
        self.hourly.append({"t": round(self.t), "waiting": len(self.waiting), "in_bays": len(self.bays), "boarders": boarders,
                            "open_requests": len(self.open_req), "lwbs": self.lwbs_count,
                            **{f"occ_{u[0]}": cnt[u[0]] for u in UNITS}, **{f"st_{k}": v for k, v in st.items()}})
        if self.t >= self.until - HISTORY_DAYS * 1440:
            self.bed_history.append({"t": round(self.t), "s": "".join(
                {"occupied": "O", "clean": "C", "dirty": "D", "cleaning": "L", "reserved": "R"}[s.status] for s in self.bs)})

    def on_snapshot(self):
        """07:00 and 14:00 each day: what the bed-release model would see for every inpatient."""
        for pid, info in self.inpt.items():
            self.snapshots.append({"t": round(self.t), "pid": pid, "unit": info["unit"], "phase": info["phase"],
                                   "los_h": (self.t - info["t_admit"]) / 60, "in_unit_h": (self.t - info["t_in"]) / 60,
                                   "t_plan": info.get("t_plan")})

    def now_state(self):
        beds = []
        for b in self.beds:
            s = self.bs[b.idx]
            beds.append({"bed": b.id, "unit": b.unit, "room": b.room, "single": b.single, "tele": b.tele, "status": s.status,
                         "occupant": s.occupant, "reserved_for": s.reserved_for,
                         "ready_in": round(s.clean_end - self.t) if s.status == "cleaning" else None,
                         "dirty_min": round(self.t - s.dirty_since) if s.status == "dirty" else None})
        return {"t": self.t, "beds": beds, "waiting": list(self.waiting), "bays": dict(self.bays),
                "open": [self.req[k].__dict__ for k in sorted(self.open_req)],
                "inpatients": {pid: dict(v) for pid, v in self.inpt.items()}, "lwbs": self.lwbs_count}


def run(policy: str, patients: list[Patient] | None = None, until: float = NOW_MIN) -> Result:
    return Sim(patients if patients is not None else make_patients(), policy, until).run()
