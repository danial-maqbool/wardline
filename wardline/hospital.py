"""Halvern Bay General: a fictional 202-bed hospital, and every patient who will arrive over 90 days.

All randomness is drawn here, up front, per patient. Both placement policies then replay exactly the same
patients (same arrival times, same treatment times, same lengths of stay, same cleaning times), so any
difference in the results comes from the policy and nothing else ("common random numbers").
"""
from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass, field

import numpy as np

SEED = 20261003
START = dt.datetime(2026, 7, 6, 0, 0)            # a Monday
DAYS = 90
NOW_MIN = (DAYS - 1) * 1440 + 14 * 60 + 20       # 2026-10-03 14:20, the "live" moment in the dashboard
HORIZON_MIN = DAYS * 1440


def at(minute: float) -> dt.datetime:
    return START + dt.timedelta(minutes=float(minute))


# ------------------------------------------------------------------------------------------ beds
# key, display name, floor label, beds, single rooms, telemetry beds (-1 = all), home service
UNITS = [
    ("ICU", "Intensive Care", "ICU", 14, 14, -1, "critical"),
    ("SDU", "Step-Down", "3S", 16, 8, -1, "stepdown"),
    ("CARD", "Cardiology 5E", "5E", 24, 8, -1, "cardiac"),
    ("MEDA", "Medicine 4A", "4A", 36, 8, 14, "medicine"),
    ("MEDB", "Medicine 4B", "4B", 36, 8, 0, "medicine"),
    ("SURG", "Surgery 6A", "6A", 28, 8, 0, "surgical"),
    ("ORTH", "Orthopedics 6B", "6B", 20, 6, 0, "ortho"),
    ("PEDS", "Pediatrics 2B", "2B", 12, 12, 0, "peds"),
    ("MAT", "Maternity 2A", "2A", 16, 10, 0, "maternity"),
]
UNIT = {u[0]: u for u in UNITS}

# where each service may go, and what it costs in fit (0 = home unit; >= 40 counts as an outlier)
FIT = {
    "critical": {"ICU": 0},
    "stepdown": {"SDU": 0, "CARD": 15, "MEDA": 45},
    "cardiac": {"CARD": 0, "SDU": 10, "MEDA": 30},
    "medicine": {"MEDA": 0, "MEDB": 0, "CARD": 40, "SURG": 50, "ORTH": 50},
    "surgical": {"SURG": 0, "ORTH": 25, "MEDB": 50},
    "ortho": {"ORTH": 0, "SURG": 15, "MEDB": 50},
    "peds": {"PEDS": 0},
    "maternity": {"MAT": 0},
}
OUTLIER = 40


@dataclass
class Bed:
    id: str
    unit: str
    room: str
    single: bool
    tele: bool
    idx: int


def build_beds() -> list[Bed]:
    beds, i = [], 0
    for key, _, floor, n, singles, tele, _svc in UNITS:
        room = 1
        made = 0
        tele_left = n if tele < 0 else tele
        while made < n:
            single = made < singles
            for side in ([""] if single else ["A", "B"]):
                if made >= n:
                    break
                t = tele_left > 0
                tele_left -= 1 if t else 0
                beds.append(Bed(id=f"{floor}-{room:02d}{side}", unit=key, room=f"{floor}-{room:02d}", single=single, tele=t, idx=i))
                i += 1
                made += 1
            room += 1
    return beds


# ------------------------------------------------------------------------------------------ patients
HOUR_PROFILE = np.array([0.45, 0.38, 0.33, 0.30, 0.30, 0.35, 0.50, 0.75, 1.05, 1.30, 1.45, 1.50,
                         1.48, 1.42, 1.38, 1.36, 1.35, 1.32, 1.28, 1.20, 1.05, 0.90, 0.72, 0.58])
HOUR_PROFILE = HOUR_PROFILE / HOUR_PROFILE.mean()
DOW = np.array([1.12, 1.04, 1.00, 0.98, 0.97, 0.93, 0.96])          # Mon..Sun
ED_PER_DAY = 148
COMPLAINTS = {
    1: ["Cardiac arrest", "Major trauma", "Respiratory failure"],
    2: ["Chest pain", "Stroke symptoms", "Sepsis", "Shortness of breath"],
    3: ["Abdominal pain", "Shortness of breath", "Fever", "Fall", "Back pain", "Headache"],
    4: ["Laceration", "Ankle injury", "Urinary symptoms", "Rash", "Ear pain"],
    5: ["Prescription refill", "Minor burn", "Sore throat"],
}
ADMIT_COMPLAINTS = {
    "critical": ["Sepsis", "Respiratory failure", "Major trauma", "Stroke", "Cardiac arrest"],
    "stepdown": ["Chest pain", "GI bleed", "Shortness of breath"],
    "cardiac": ["Chest pain", "Palpitations", "Syncope", "Heart failure"],
    "medicine": ["Shortness of breath", "Fever", "Pneumonia", "Confusion", "Weakness", "Cellulitis", "Kidney injury"],
    "surgical": ["Abdominal pain", "Appendicitis", "Bowel obstruction", "Gallbladder pain"],
    "ortho": ["Hip fracture", "Fall with fracture", "Wrist fracture"],
    "peds": ["Asthma attack", "Bronchiolitis", "Dehydration", "Fever"],
}
LOS_MEDIAN_H = {"critical": 66, "stepdown": 50, "cardiac": 68, "medicine": 92, "surgical": 60, "ortho": 52, "peds": 42, "maternity": 44}


def season(day: float) -> float:
    """Summer baseline, a respiratory wave in early September, and a second wave building this week."""
    a = 0.20 * math.exp(-((day - 62) / 6.0) ** 2)
    b = 0.30 / (1 + math.exp(-(day - 82.0) / 2.0))
    return 1.0 + a + b


@dataclass
class Patient:
    id: int
    source: str                  # ED | ELECTIVE | MAT | DIRECT
    t_arrive: float              # minutes from START
    age: int
    sex: str
    esi: int = 0
    complaint: str = ""
    admit: bool = False
    service: str = ""
    tele: bool = False
    iso: bool = False
    treat_min: float = 0.0
    triage_min: float = 10.0
    patience_min: float = 1e9
    los_h: float = 0.0
    dc_delay_h: float = 0.0
    dc_hour: float = 13.0
    barriers: dict = field(default_factory=dict)       # true barriers
    seen_barriers: dict = field(default_factory=dict)  # what the team has documented
    clean_min: float = 40.0
    transport_min: float = 25.0
    icu_next: str = ""          # service after ICU
    edd_known: bool = False     # the team documented an expected discharge date
    edd_err_h: float = 0.0      # how far off that date is
    order_u: float = 1.0        # < 0.6 means the discharge order is written by mid-morning on the day
    los2_h: float = 0.0         # length of stay after the ICU step


def _lognorm(rng, median, sigma):
    return float(median * math.exp(rng.normal(0, sigma)))


def make_patients(seed: int = SEED) -> list[Patient]:
    rng = np.random.default_rng(seed)
    cosmetic = np.random.default_rng(seed + 1)                          # labels only; never changes the dynamics
    pts: list[Patient] = []

    def common(p: Patient):
        p.los_h = max(8.0, _lognorm(rng, LOS_MEDIAN_H[p.service], 0.55))
        p.dc_delay_h = float(rng.lognormal(math.log(1.6), 0.6))
        p.dc_hour = float(np.clip(rng.normal(13.2, 2.1), 9, 19.5))
        b = {}
        if rng.random() < 0.10: b["transport"] = 4.0
        if rng.random() < 0.08: b["imaging"] = 16.0
        if rng.random() < 0.06 and p.age >= 65: b["placement"] = 56.0
        p.barriers = b
        p.seen_barriers = {k: v for k, v in b.items() if rng.random() < 0.75}
        if rng.random() < 0.03: p.seen_barriers["transport"] = 4.0          # documented but not real
        p.clean_min = _lognorm(rng, 38, 0.35) * (1.6 if p.iso else 1.0)
        p.transport_min = float(rng.uniform(18, 35))
        p.edd_known = rng.random() < 0.7
        p.edd_err_h = float(rng.normal(0, 16))
        p.order_u = float(rng.random())
        if p.service == "critical":
            p.icu_next = "stepdown" if rng.random() < 0.55 else "medicine"
            p.los2_h = max(8.0, _lognorm(rng, LOS_MEDIAN_H[p.icu_next], 0.5))

    pid = 0
    for day in range(DAYS):
        d = START + dt.timedelta(days=day)
        dow = d.weekday()
        for h in range(24):
            lam = ED_PER_DAY / 24 * HOUR_PROFILE[h] * DOW[dow] * season(day + h / 24)
            for _ in range(rng.poisson(lam)):
                pid += 1
                t = day * 1440 + h * 60 + rng.uniform(0, 60)
                age = int(np.clip(rng.choice([rng.normal(8, 5), rng.normal(38, 14), rng.normal(70, 11)], p=[0.14, 0.50, 0.36]), 0, 98))
                sex = "F" if rng.random() < 0.52 else "M"
                esi = int(rng.choice([1, 2, 3, 4, 5], p=[0.012, 0.13, 0.45, 0.31, 0.098]))
                p = Patient(pid, "ED", t, age, sex, esi=esi, complaint=str(cosmetic.choice(COMPLAINTS[esi])))
                p.treat_min = _lognorm(rng, {1: 160, 2: 210, 3: 185, 4: 90, 5: 55}[esi], 0.45)
                p.triage_min = 0.0 if esi == 1 else float(rng.uniform(6, 18))
                p.patience_min = {1: 1e9, 2: 1e9, 3: rng.exponential(420), 4: rng.exponential(200), 5: rng.exponential(130)}[esi]
                p_admit = {1: 0.88, 2: 0.50, 3: 0.21, 4: 0.04, 5: 0.01}[esi] * (1.15 if age >= 70 else 0.8 if age < 16 else 1.0)
                p.admit = rng.random() < min(0.95, p_admit)
                if p.admit:
                    if age < 16:
                        p.service = "peds"
                    elif esi == 1 and rng.random() < 0.75 or esi == 2 and rng.random() < 0.15:
                        p.service = "critical"
                    else:
                        p.service = str(rng.choice(["medicine", "cardiac", "surgical", "ortho", "stepdown"], p=[0.58, 0.18, 0.12, 0.07, 0.05]))
                    p.tele = p.service in ("cardiac", "stepdown") or (p.service == "medicine" and rng.random() < 0.22)
                    p.iso = rng.random() < 0.09
                    p.complaint = str(cosmetic.choice(ADMIT_COMPLAINTS[p.service]))
                    common(p)
                pts.append(p)
        if dow < 5:                                                    # elective surgery, out of recovery 12:00-17:00
            for _ in range(rng.poisson(10)):
                pid += 1
                svc = "surgical" if rng.random() < 0.62 else "ortho"
                if rng.random() < 0.06: svc = "critical"
                p = Patient(pid, "ELECTIVE", day * 1440 + rng.uniform(12 * 60, 17 * 60), int(np.clip(rng.normal(58, 14), 18, 92)),
                            "F" if rng.random() < 0.5 else "M", admit=True, service=svc, iso=rng.random() < 0.03)
                common(p); pts.append(p)
        for _ in range(rng.poisson(5)):                                 # births, from labour & delivery
            pid += 1
            p = Patient(pid, "MAT", day * 1440 + rng.uniform(0, 1440), int(np.clip(rng.normal(30, 5), 17, 45)), "F", admit=True, service="maternity")
            common(p); pts.append(p)
        for _ in range(rng.poisson(3)):                                 # direct admissions from clinics
            pid += 1
            svc = "medicine" if rng.random() < 0.7 else "cardiac"
            p = Patient(pid, "DIRECT", day * 1440 + rng.uniform(10 * 60, 20 * 60), int(np.clip(rng.normal(66, 13), 18, 95)),
                        "F" if rng.random() < 0.5 else "M", admit=True, service=svc, tele=svc == "cardiac", iso=rng.random() < 0.06)
            common(p); pts.append(p)
    pts.sort(key=lambda p: p.t_arrive)
    return pts
