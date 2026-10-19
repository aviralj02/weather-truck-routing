from datetime import datetime, timezone

import pytest

from routing.services import planner
from routing.services.geo import cumulative_distances
from routing.services.ors import Route
from routing.services.risk import RiskLevel as L

DEPART = datetime(2026, 1, 1, 8, tzinfo=timezone.utc)


def straight_route(miles=100.0, mph=50.0):
    # Due north along a meridian: 1 degree of latitude is ~69.05 miles.
    n = 200
    lat_span = miles / 69.05
    coords = [(-100.0, 40.0 + lat_span * i / (n - 1)) for i in range(n)]
    dist = cumulative_distances(coords)
    times = [d / mph * 3600 for d in dist]
    return Route(coords=coords, distance_mi=dist[-1], duration_s=times[-1], vertex_time_s=times, vertex_dist_mi=dist)


@pytest.mark.parametrize("interval,expected_count", [(10, 11), (25, 5), (50, 3)])
def test_checkpoints_cover_route_at_interval(interval, expected_count):
    route = straight_route(100)
    cps = planner.build_checkpoints(route, DEPART, interval)
    assert len(cps) == expected_count
    assert cps[0].mile == 0
    assert cps[-1].mile == pytest.approx(route.distance_mi)
    assert sum(cp.miles_covered for cp in cps) == pytest.approx(route.distance_mi)


def test_checkpoint_eta_follows_route_speed():
    cps = planner.build_checkpoints(straight_route(100, mph=50), DEPART, 25)
    # mile 50 at 50 mph -> one hour after departure
    assert (cps[2].eta - DEPART).total_seconds() == pytest.approx(3600, rel=0.01)


def test_trailing_sliver_is_folded_into_destination():
    cps = planner.build_checkpoints(straight_route(50.3), DEPART, 25)
    assert [round(c.mile) for c in cps] == [0, 25, 50]


def summary(no_travel=0, severe=0, high=0, moderate=0, low=100):
    cps = []
    bands = [(L.NO_TRAVEL, no_travel), (L.SEVERE, severe), (L.HIGH, high), (L.MODERATE, moderate), (L.LOW, low)]
    for level, miles in bands:
        if miles:
            cp = planner.Checkpoint(mile=0, point=(0, 0), elapsed_s=0, eta=DEPART, level=level)
            cp.miles_covered = miles
            cps.append(cp)
    return planner.summarize(cps)


def test_ranking_follows_prd_priority():
    fast_but_severe = summary(severe=10, low=90).sort_key(3600)
    slow_but_high = summary(high=50, low=50).sort_key(9000)
    assert slow_but_high < fast_but_severe  # fewest Severe miles beats everything below it

    more_high = summary(high=20, low=80).sort_key(3600)
    more_moderate = summary(moderate=60, low=40).sort_key(9000)
    assert more_moderate < more_high  # then fewest High miles

    calmer = summary(moderate=10, low=90).sort_key(9000)
    windier = summary(moderate=30, low=70).sort_key(3600)
    assert calmer < windier  # then lowest average risk

    assert summary().sort_key(3600) < summary().sort_key(3700)  # then shortest time


def test_no_travel_ranks_worse_than_severe():
    assert summary(severe=50, low=50).sort_key(0) < summary(no_travel=1, low=99).sort_key(0)


def test_explanation_names_deciding_criterion():
    best = ("Route A", summary(high=5, low=95), 3600)
    other = ("Route B", summary(severe=12, low=88), 3000)
    assert "fewest Severe miles" in planner.explain_choice(best, other)

    tie_best = ("Route A", summary(), 3600)
    tie_other = ("Route B", summary(), 4500)
    assert "15 min faster" in planner.explain_choice(tie_best, tie_other)


def test_explanation_never_reads_as_a_tie():
    best = ("Route A", summary(severe=12.3, low=87.7), 3600)
    other = ("Route B", summary(severe=12.4, low=87.6), 3600)
    assert "(12.3 mi vs 12.4 mi" in planner.explain_choice(best, other)


def test_no_routes_from_ors_is_a_clear_error(monkeypatch):
    from routing.services import ors
    from routing.services.exceptions import UpstreamError

    monkeypatch.setattr(ors, "_directions", lambda *a, **k: [])
    with pytest.raises(UpstreamError) as exc:
        ors._find_routes((-100.0, 40.0), (-95.0, 41.0), 30_000, 270)
    assert exc.value.status_code == 422
