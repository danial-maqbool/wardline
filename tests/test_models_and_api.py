import importlib
import json
from pathlib import Path

import numpy as np
import pytest

from wardline import models as M


@pytest.fixture(scope="module")
def fitted(runs):
    R = runs["wardline"]
    y = M.hourly_arrivals(R)
    arr, live = M.fit_arrivals(y)
    rel, train, rm = M.fit_release(R)
    return R, y, arr, live, rel, train, rm


def test_arrivals_beat_both_baselines(fitted):
    _, _, arr, live, *_ = fitted
    assert arr["mae"] < arr["mae_4wk_avg"] < arr["mae_last_week"]
    assert arr["next24_mape"] < arr["next24_mape_4wk_avg"]
    assert arr["interval80_coverage"] >= 78
    assert len(live["mean"]) == 48 and all(l <= m <= h + 1e-9 for l, m, h in zip(live["lo"], live["mean"], live["hi"]))


def test_seasonal_level_follows_a_level_shift():
    y = np.tile(np.r_[np.full(12, 4.0), np.full(12, 8.0)], 7 * 9)
    y[-48:] *= 1.5                                                     # demand jumps by half in the last two days
    f = M.seasonal_level(y, len(y))
    base = np.r_[np.full(12, 4.0), np.full(12, 8.0)]
    assert f[:24].sum() > 1.2 * base.sum()


def test_release_model_is_better_than_the_rule_and_calibrated(fitted):
    *_, rm = fitted
    for h in (24, 48, 72):
        assert rm[h]["auc"] > rm[h]["auc_rule"] + 0.1
        assert rm[h]["ece"] < 0.06


def test_release_probabilities_are_probabilities(fitted):
    R, *_, rel, _, _ = fitted
    live = M.live_release(R, rel)
    assert len(live) == len(R.now["inpatients"])
    for v in live.values():
        assert 0 <= v[24] <= v[48] + 0.05 and v[48] <= v[72] + 0.05 <= 1.06


def test_census_forecast_is_unbiased_and_beats_persistence_per_unit(fitted):
    R, *_, train, _ = fitted
    bt = M.backtest_census(R, train)
    for h in (24, 48, 72):
        assert abs(bt[h]["bias_hospital"]) < 5                          # beds, out of about 190 in use
    for h in (24, 48, 72):
        assert bt[h]["mae_unit"] < bt[h]["mae_unit_persistence"]


@pytest.fixture(scope="module")
def client():
    res = Path(__file__).resolve().parent.parent / "results"
    if not (res / "live.json").exists():
        pytest.skip("run python run.py first")
    from fastapi.testclient import TestClient
    import wardline.api as api
    importlib.reload(api)
    return TestClient(api.app)


@pytest.mark.parametrize("path", ["/api/layout", "/api/live", "/api/metrics", "/api/daily", "/api/hourly", "/api/replay", "/"])
def test_endpoints(client, path):
    assert client.get(path).status_code == 200


def test_accept_then_reset(client):
    live = client.get("/api/live").json()
    ready = [r for r in live["recommendations"] if r["kind"] == "assign"]
    if not ready:
        pytest.skip("no ready recommendation in this run")
    r = ready[0]
    after = client.post(f"/api/accept/{r['rid']}").json()
    assert next(x for x in after["recommendations"] if x["rid"] == r["rid"])["kind"] == "accepted"
    assert client.post(f"/api/accept/{r['rid']}").status_code == 400
    fresh = client.post("/api/reset").json()
    assert next(x for x in fresh["recommendations"] if x["rid"] == r["rid"])["kind"] == "assign"
