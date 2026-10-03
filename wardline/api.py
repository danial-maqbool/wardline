"""Wardline API + dashboard.   python run.py   then   uvicorn wardline.api:app --port 8810"""
from __future__ import annotations

import copy
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "results"
app = FastAPI(title="Wardline", version="1.0")
_data: dict = {}


def load(name):
    if name not in _data:
        _data[name] = json.loads((RES / f"{name}.json").read_text(encoding="utf-8"))
    return _data[name]


def live():
    if "live_state" not in _data:
        _data["live_state"] = copy.deepcopy(load("live"))
    return _data["live_state"]


@app.middleware("http")
async def no_store(request, call_next):
    resp = await call_next(request)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/api/layout")
def layout():
    return load("layout")


@app.get("/api/live")
def get_live():
    return live()


@app.get("/api/metrics")
def metrics():
    return load("metrics")


@app.get("/api/daily")
def daily():
    return load("daily")


@app.get("/api/hourly")
def hourly(days: int = 14):
    h = load("hourly")
    return h[-days * 24:]


@app.get("/api/replay")
def replay():
    return load("replay")


@app.post("/api/accept/{rid}")
def accept(rid: int):
    L = live()
    rec = next((r for r in L["recommendations"] if r["rid"] == rid), None)
    if rec is None or rec.get("kind") != "assign":
        raise HTTPException(400, "nothing to accept for this request")
    bed = next(b for b in L["beds"] if b["bed"] == rec["bed"])
    was = bed["status"]
    bed.update({"status": "reserved" if was == "clean" else was, "pid": rec["pid"], "age": rec["age"], "sex": rec["sex"],
                "service": rec["service"], "reserved": True})
    rec["kind"] = "accepted"
    k = L["kpis"]
    k["open_requests"] -= 1
    if was == "clean":
        k["clean"] -= 1
        k["reserved"] += 1
    for b in L["bays"]:
        if b["pid"] == rec["pid"]:
            b["assigned"] = True
    return L


@app.post("/api/reset")
def reset():
    _data.pop("live_state", None)
    return live()


app.mount("/assets", StaticFiles(directory=ROOT / "web"), name="assets")


@app.get("/")
def index():
    return FileResponse(ROOT / "web" / "index.html")
