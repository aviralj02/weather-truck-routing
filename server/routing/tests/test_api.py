from datetime import timedelta
from unittest import mock

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from routing.services.exceptions import UpstreamError


@pytest.fixture
def client():
    return APIClient()


def payload(**overrides):
    body = {
        "origin": {"lat": 41.88, "lon": -87.63},
        "destination": {"lat": 39.74, "lon": -104.99},
        "departure_time": (timezone.now() + timedelta(hours=2)).isoformat(),
        "load_weight_lb": 35000,
        "interval_miles": 25,
    }
    body.update(overrides)
    return body


@pytest.mark.parametrize("method", ["get", "head"])
def test_health_answers_uptime_monitors(client, method):
    assert getattr(client, method)("/api/health/").status_code == 200


def test_rejects_past_departure(client):
    resp = client.post("/api/trips/plan/", payload(departure_time="2020-01-01T00:00:00Z"), format="json")
    assert resp.status_code == 400
    assert "past" in resp.json()["detail"]


def test_rejects_invalid_interval(client):
    resp = client.post("/api/trips/plan/", payload(interval_miles=15), format="json")
    assert resp.status_code == 400


def test_upstream_errors_are_surfaced(client):
    with mock.patch("routing.views.planner.plan_trip", side_effect=UpstreamError("No route", status_code=422)):
        resp = client.post("/api/trips/plan/", payload(), format="json")
    assert resp.status_code == 422
    assert resp.json() == {"detail": "No route"}


def test_risk_rules_endpoint(client):
    data = client.get("/api/risk-rules/").json()
    assert data["wind_mph"]["no_travel"] == 55
    assert [lvl["label"] for lvl in data["levels"]] == ["Low", "Moderate", "High", "Severe", "No Travel"]


def test_heatmap_endpoint_is_separate_from_plan(client):
    heatmap = {"start": "2026-01-01T00:00:00+00:00", "hours": 49}
    with mock.patch("routing.views.planner.trip_heatmap", return_value=heatmap) as fn:
        resp = client.post("/api/trips/heatmap/", payload(), format="json")
    assert resp.status_code == 200
    assert resp.json() == heatmap
    assert fn.call_args.kwargs["load_lb"] == 35000


def test_heatmap_validates_like_plan(client):
    resp = client.post("/api/trips/heatmap/", payload(load_weight_lb=0), format="json")
    assert resp.status_code == 400
