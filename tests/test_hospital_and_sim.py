from collections import Counter, defaultdict

import pytest

from wardline import sim
from wardline.hospital import FIT, OUTLIER, UNITS, build_beds, make_patients


def test_patients_are_deterministic():
    a, b = make_patients(), make_patients()
    assert [(p.t_arrive, p.service, p.los_h) for p in a] == [(p.t_arrive, p.service, p.los_h) for p in b]


def test_bed_layout():
    beds = build_beds()
    assert len(beds) == sum(u[3] for u in UNITS) == 202
    assert len({b.id for b in beds}) == len(beds)
    per = Counter(b.unit for b in beds)
    assert all(per[u[0]] == u[3] for u in UNITS)
    rooms = Counter(b.room for b in beds)
    assert all(n <= 2 for n in rooms.values())
    assert all((rooms[b.room] == 1) == b.single for b in beds)


def test_every_service_has_a_home_unit():
    assert all(0 in fits.values() for fits in FIT.values())


@pytest.mark.parametrize("policy", ["baseline", "wardline"])
def test_hard_constraints_never_broken(runs, policy):
    R = runs[policy]
    beds = build_beds()
    for r in R.requests:
        if r.bed is None:
            continue
        b = beds[r.bed]
        assert b.unit in FIT[r.service]
        if r.iso:
            assert b.single, "isolation patient in a shared room"
        if r.tele:
            assert b.tele, "telemetry patient without telemetry"
        if r.fit >= OUTLIER:
            assert r.t_assign - r.t >= sim.OUTLIER_AFTER_MIN - 1e-6, "outlier placed before the 6-hour rule"
        assert r.t_move is None or r.t_move >= r.t_assign >= r.t


@pytest.mark.parametrize("policy", ["baseline", "wardline"])
def test_no_bed_is_double_booked_and_rooms_are_single_sex(runs, policy):
    R = runs[policy]
    beds = build_beds()
    occupants = [s["occupant"] for s in R.now["beds"] if s["occupant"] is not None]
    assert len(occupants) == len(set(occupants))
    by_room = defaultdict(list)
    for b, s in zip(beds, R.now["beds"]):
        pid = s["occupant"] if s["occupant"] is not None else s["reserved_for"]
        if pid is not None:
            by_room[b.room].append(R.patients[pid].sex)
    assert all(len(set(v)) == 1 for v in by_room.values())


@pytest.mark.parametrize("policy", ["baseline", "wardline"])
def test_ed_capacity_and_accounting(runs, policy):
    R = runs[policy]
    assert max(h["in_bays"] for h in R.hourly) <= sim.ED_BAYS
    for v in R.ed.values():
        if v["start"] is not None:
            assert v["start"] >= v["arrive"]
        if v["lwbs"]:
            assert v["start"] is None


def test_same_patients_in_both_runs(runs):
    a, b = runs["baseline"], runs["wardline"]
    assert set(a.ed) == set(b.ed)
    assert [p.t_arrive for p in a.patients.values()] == [p.t_arrive for p in b.patients.values()]


def test_wardline_beats_first_come_first_served(runs):
    def over4(R):
        x = [(r.t_move - r.t) / 60 for r in R.requests if r.origin == "ED" and r.t_move is not None]
        return sum(v > 4 for v in x) / len(x)
    def outliers(R):
        return sum(1 for r in R.requests if r.fit is not None and r.fit >= OUTLIER)
    assert over4(runs["wardline"]) < over4(runs["baseline"])
    assert outliers(runs["wardline"]) < outliers(runs["baseline"])


def test_recommendations_respect_constraints(runs):
    R = runs["wardline"]
    p24 = {pid: 0.5 for pid in R.now["inpatients"]}
    recs = R.sim.recommend(p24)
    beds = {b.id: b for b in build_beds()}
    used = [r["bed"] for r in recs if r["kind"] in ("assign", "expected")]
    assert len(used) == len(set(used)), "two patients offered the same bed"
    for r in recs:
        if r["kind"] == "assign":
            b = beds[r["bed"]]
            assert b.unit in FIT[r["service"]] and (b.single or not r["iso"]) and (b.tele or not r["tele"])
