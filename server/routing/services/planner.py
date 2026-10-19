"""Trip planning: checkpoints, weather-at-ETA, route scoring, recommendation, corridor heatmap."""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta

from . import ors, weather
from .geo import (
    LonLat,
    bbox,
    haversine_mi,
    interpolate,
    point_at_distance,
    sample_along,
    simplify,
    slice_by_distance,
)
from .risk import RiskLevel, Weather, assess

HEATMAP_HOURS = 49  # forecast slider covers hours 0..48 from departure
HEATMAP_MAX_POINTS = 450
ROUTE_LETTERS = "ABC"


# --------------------------------------------------------------------------- Checkpoints


@dataclass
class Checkpoint:
    mile: float  # along-route miles (ORS distance)
    point: LonLat
    elapsed_s: float
    eta: datetime
    weather: Weather | None = None
    level: RiskLevel = RiskLevel.LOW
    score: float = 0.0
    reasons: list[str] | None = None
    miles_covered: float = 0.0  # share of the route this checkpoint represents


def build_checkpoints(route: ors.Route, departure: datetime, interval_mi: float) -> list[Checkpoint]:
    """A checkpoint every `interval_mi` road miles, plus the destination.

    Mile markers use ORS's reported road distance; positions on the geometry are found by
    scaling to the polyline's geodesic length so the two stay consistent. The ETA at each
    checkpoint interpolates the per-vertex elapsed time derived from ORS's step durations.
    """
    geo_total = route.vertex_dist_mi[-1]
    scale = geo_total / route.distance_mi if route.distance_mi else 1.0

    marks = [i * interval_mi for i in range(int(route.distance_mi // interval_mi) + 1)]
    # Always end at the destination; fold a sliver (<0.5 mi) into the final checkpoint.
    if len(marks) == 1 or route.distance_mi - marks[-1] > 0.5:
        marks.append(route.distance_mi)
    else:
        marks[-1] = route.distance_mi

    checkpoints = []
    for mile in marks:
        point, i, t = point_at_distance(route.coords, route.vertex_dist_mi, mile * scale)
        j = min(i + 1, len(route.vertex_time_s) - 1)
        elapsed = interpolate(route.vertex_time_s[i], route.vertex_time_s[j], t)
        checkpoints.append(Checkpoint(mile=mile, point=point, elapsed_s=elapsed, eta=departure + timedelta(seconds=elapsed)))

    # Each checkpoint represents the stretch halfway to its neighbours, so the
    # attributed miles sum exactly to the route distance.
    for k, cp in enumerate(checkpoints):
        prev_mile = checkpoints[k - 1].mile if k > 0 else cp.mile
        next_mile = checkpoints[k + 1].mile if k < len(checkpoints) - 1 else cp.mile
        cp.miles_covered = (next_mile - prev_mile) / 2
    return checkpoints


# --------------------------------------------------------------------------- Scoring


@dataclass
class RouteSummary:
    miles_by_level: dict[RiskLevel, float]
    avg_risk: float  # distance-weighted mean level, 0..4
    max_level: RiskLevel

    def sort_key(self, duration_s: float) -> tuple:
        """PRD order: fewest Severe miles, fewest High miles, lowest average risk, shortest time.

        No Travel miles are ranked ahead of Severe: a route the rules forbid driving
        cannot be preferred over one that is merely severe. Values are rounded so
        floating-point noise doesn't override the next criterion.
        """
        m = self.miles_by_level
        return (
            round(m[RiskLevel.NO_TRAVEL], 1),
            round(m[RiskLevel.SEVERE], 1),
            round(m[RiskLevel.HIGH], 1),
            round(self.avg_risk, 2),
            round(duration_s),
        )


def summarize(checkpoints: list[Checkpoint]) -> RouteSummary:
    miles = {level: 0.0 for level in RiskLevel}
    for cp in checkpoints:
        miles[cp.level] += cp.miles_covered
    total = sum(miles.values()) or 1.0
    avg = sum(level * m for level, m in miles.items()) / total
    return RouteSummary(miles_by_level=miles, avg_risk=avg, max_level=max(cp.level for cp in checkpoints))


CRITERIA = [
    ("No Travel miles", lambda s, d: s.miles_by_level[RiskLevel.NO_TRAVEL], "mi"),
    ("Severe miles", lambda s, d: s.miles_by_level[RiskLevel.SEVERE], "mi"),
    ("High miles", lambda s, d: s.miles_by_level[RiskLevel.HIGH], "mi"),
    ("average risk", lambda s, d: s.avg_risk, ""),
    ("travel time", lambda s, d: d, "s"),
]


def explain_choice(best: tuple[str, RouteSummary, float], runner_up: tuple[str, RouteSummary, float] | None) -> str:
    name, summary, duration = best
    if runner_up is None:
        return f"{name} is the only route available."
    other_name, other_summary, other_duration = runner_up
    best_key, other_key = summary.sort_key(duration), other_summary.sort_key(other_duration)
    for i, (label, getter, unit) in enumerate(CRITERIA):
        if best_key[i] != other_key[i]:
            a, b = getter(summary, duration), getter(other_summary, other_duration)
            if unit == "s":
                return f"{name} has equal weather risk to {other_name} and is {_fmt_duration(b - a)} faster."
            if unit == "mi":
                # Ranking compares tenths of a mile; show them when whole miles would read as a tie.
                digits = 0 if round(a) != round(b) else 1
                return f"{name} has the fewest {label} ({a:.{digits}f} mi vs {b:.{digits}f} mi on {other_name})."
            return f"{name} has the lowest {label} ({a:.2f} vs {b:.2f} on {other_name}) with no extra High/Severe miles."
    return f"{name} and {other_name} score identically; {name} is listed first."


def _fmt_duration(seconds: float) -> str:
    minutes = round(seconds / 60)
    if minutes < 60:
        return f"{minutes} min"
    h, m = divmod(minutes, 60)
    return f"{h}h {m}m" if m else f"{h}h"


# --------------------------------------------------------------------------- Heatmap


@dataclass
class CorridorGrid:
    """Points of a regular lon/lat lattice that fall within the trip corridor.

    The lattice description lets the client rebuild a dense raster (and interpolate it)
    without guessing spacing from rounded coordinates.
    """

    points: list[LonLat]
    cells: list[tuple[int, int]]  # (row, col) of each point; row 0 is the southern edge
    lon0: float
    lat0: float
    dlon: float
    dlat: float
    rows: int
    cols: int
    spacing_mi: float


def corridor_grid(routes: list[ors.Route]) -> CorridorGrid:
    """Lattice points within a buffer of any route, sized to stay under HEATMAP_MAX_POINTS."""
    all_coords = [c for r in routes for c in r.coords]
    origin, destination = routes[0].coords[0], routes[0].coords[-1]
    straight = haversine_mi(origin, destination)
    buffer_mi = max(20.0, min(60.0, straight * 0.12))
    longest = max(r.distance_mi for r in routes)

    # Estimate corridor area to choose a spacing that yields roughly the target count.
    area = longest * 2 * buffer_mi * 1.4 + math.pi * buffer_mi**2
    step_mi = max(4.0, math.sqrt(area / (HEATMAP_MAX_POINTS * 0.8)))

    min_lon, min_lat, max_lon, max_lat = bbox(all_coords)
    mi_per_deg_lon = 69.0 * max(0.2, math.cos(math.radians((min_lat + max_lat) / 2)))
    pad_lat, pad_lon = buffer_mi / 69.0, buffer_mi / mi_per_deg_lon

    # Index route samples in cells one buffer wide in each axis, so a 3x3 lookup
    # covers every sample within `buffer_mi` of a candidate point.
    def cell_of(p: LonLat) -> tuple[int, int]:
        return int(math.floor(p[0] / pad_lon)), int(math.floor(p[1] / pad_lat))

    while True:
        dlat, dlon = step_mi / 69.0, step_mi / mi_per_deg_lon
        index: dict[tuple[int, int], list[LonLat]] = defaultdict(list)
        for r in routes:
            for p in sample_along(r.coords, r.vertex_dist_mi, max(1.0, step_mi / 3)):
                index[cell_of(p)].append(p)

        lon0, lat0 = min_lon - pad_lon, min_lat - pad_lat
        cols = int((max_lon + pad_lon - lon0) / dlon) + 1
        rows = int((max_lat + pad_lat - lat0) / dlat) + 1
        points, cells = [], []
        for row in range(rows):
            for col in range(cols):
                p = (lon0 + col * dlon, lat0 + row * dlat)
                cx, cy = cell_of(p)
                if any(
                    haversine_mi(p, q) <= buffer_mi
                    for dx in (-1, 0, 1)
                    for dy in (-1, 0, 1)
                    for q in index.get((cx + dx, cy + dy), ())
                ):
                    points.append(p)
                    cells.append((row, col))
        if len(points) <= HEATMAP_MAX_POINTS:
            return CorridorGrid(points, cells, lon0, lat0, dlon, dlat, rows, cols, step_mi)
        step_mi *= math.sqrt(len(points) / HEATMAP_MAX_POINTS) * 1.05


def build_heatmap(grid: CorridorGrid, series: list[weather.HourlySeries], load_lb: float, start: datetime) -> dict:
    """Per-point hourly arrays for hours 0..48 from departure.

    `risk` is the continuous 0-4 score (load rules applied); raw wind/rain/snow are
    included so the client can switch the heatmap's variable without another request.
    """
    risk, wind, rain, snow = [], [], [], []
    for s in series:
        r_row, w_row, ra_row, sn_row = [], [], [], []
        for h in range(HEATMAP_HOURS):
            w = Weather(wind_mph=s.wind_mph[h], rain_in_hr=s.rain_in[h], snow_in_hr=s.snow_in[h])
            r_row.append(round(assess(w, load_lb).score, 2))
            w_row.append(round(w.wind_mph, 1))
            ra_row.append(round(w.rain_in_hr, 3))
            sn_row.append(round(w.snow_in_hr, 3))
        risk.append(r_row)
        wind.append(w_row)
        rain.append(ra_row)
        snow.append(sn_row)
    return {
        "start": start.isoformat(),
        "hours": HEATMAP_HOURS,
        "spacing_mi": round(grid.spacing_mi, 1),
        "lattice": {
            "lon0": grid.lon0,
            "lat0": grid.lat0,
            "dlon": grid.dlon,
            "dlat": grid.dlat,
            "rows": grid.rows,
            "cols": grid.cols,
        },
        "cells": [list(c) for c in grid.cells],
        "points": [[round(p[0], 4), round(p[1], 4)] for p in grid.points],
        "risk": risk,
        "wind_mph": wind,
        "rain_in_hr": rain,
        "snow_in_hr": snow,
    }


# --------------------------------------------------------------------------- Plan


def _risk_segments(route: ors.Route, checkpoints: list[Checkpoint]) -> list[dict]:
    """Route geometry split at the midpoints between checkpoints, each piece tagged with its level.

    Adjacent pieces with the same level are merged to keep the payload small.
    """
    scale = route.vertex_dist_mi[-1] / route.distance_mi if route.distance_mi else 1.0
    pieces: list[dict] = []
    for k, cp in enumerate(checkpoints):
        start = (checkpoints[k - 1].mile + cp.mile) / 2 if k > 0 else 0.0
        end = (cp.mile + checkpoints[k + 1].mile) / 2 if k < len(checkpoints) - 1 else route.distance_mi
        if end <= start:
            continue
        if pieces and pieces[-1]["level"] == int(cp.level):
            pieces[-1]["end"] = end
        else:
            pieces.append({"level": int(cp.level), "start": start, "end": end})
    return [
        {
            "level": p["level"],
            "path": [
                list(c)
                for c in simplify(slice_by_distance(route.coords, route.vertex_dist_mi, p["start"] * scale, p["end"] * scale))
            ],
        }
        for p in pieces
    ]


def _route_name(index: int, route: ors.Route, taken: set[str]) -> str:
    letter = ROUTE_LETTERS[index]
    road = next((r for r in route.roads if r not in taken), route.roads[0] if route.roads else None)
    if road:
        taken.add(road)
        return f"Route {letter} · via {road}"
    return f"Route {letter}"


def plan_trip(origin: LonLat, destination: LonLat, departure: datetime, load_lb: float, interval_mi: float) -> dict:
    """Routes, checkpoints and the recommendation. The corridor heatmap is served separately
    (`trip_heatmap`) so the ranked routes reach the driver without waiting on ~450 grid forecasts."""
    routes = ors.truck_routes(origin, destination, load_lb)

    route_checkpoints = [build_checkpoints(r, departure, interval_mi) for r in routes]

    # Forecast window from the departure hour until just past the latest arrival.
    start = weather.floor_hour(departure)
    longest_h = max(r.duration_s for r in routes) / 3600
    cp_points = [cp.point for cps in route_checkpoints for cp in cps]
    cp_series = weather.fetch_hourly(cp_points, start, math.ceil(longest_h) + 2)

    it = iter(cp_series)
    for cps in route_checkpoints:
        for cp in cps:
            cp.weather = next(it).at(cp.eta)
            result = assess(cp.weather, load_lb)
            cp.level, cp.score, cp.reasons = result.level, result.score, result.reasons

    summaries = [summarize(cps) for cps in route_checkpoints]
    order = sorted(range(len(routes)), key=lambda i: summaries[i].sort_key(routes[i].duration_s))
    rank = {route_idx: pos + 1 for pos, route_idx in enumerate(order)}

    taken: set[str] = set()
    names = [_route_name(i, r, taken) for i, r in enumerate(routes)]
    best_i = order[0]
    runner_i = order[1] if len(order) > 1 else None
    explanation = explain_choice(
        (names[best_i], summaries[best_i], routes[best_i].duration_s),
        (names[runner_i], summaries[runner_i], routes[runner_i].duration_s) if runner_i is not None else None,
    )
    warnings = []
    if summaries[best_i].miles_by_level[RiskLevel.NO_TRAVEL] > 0:
        warnings.append("Every route crosses No Travel conditions at the estimated arrival times. Consider delaying departure.")
    if len(routes) < ors.TARGET_ROUTES:
        warnings.append(f"Only {len(routes)} distinct truck route(s) exist between these points.")

    return {
        "departure": departure.isoformat(),
        "load_lb": load_lb,
        "interval_mi": interval_mi,
        "recommended_route_id": f"route-{best_i}",
        "recommendation": explanation,
        "warnings": warnings,
        "routes": [
            _serialize_route(i, names[i], r, route_checkpoints[i], summaries[i], rank[i], departure)
            for i, r in enumerate(routes)
        ],
    }


def trip_heatmap(origin: LonLat, destination: LonLat, departure: datetime, load_lb: float) -> dict:
    """Corridor risk/weather lattice for hours 0..48 from the departure hour.

    Routes come from the same ORS request as the plan, so this is a cache hit.
    """
    routes = ors.truck_routes(origin, destination, load_lb)
    grid = corridor_grid(routes)
    start = weather.floor_hour(departure)
    return build_heatmap(grid, weather.fetch_hourly(grid.points, start, HEATMAP_HOURS), load_lb, start)


def _serialize_route(
    i: int, name: str, route: ors.Route, cps: list[Checkpoint], summary: RouteSummary, rank: int, departure: datetime
) -> dict:
    return {
        "id": f"route-{i}",
        "name": name,
        "rank": rank,
        "distance_mi": round(route.distance_mi, 1),
        "duration_s": round(route.duration_s),
        "arrival": (departure + timedelta(seconds=route.duration_s)).isoformat(),
        "roads": route.roads,
        "geometry": [list(c) for c in simplify(route.coords)],
        "risk_segments": _risk_segments(route, cps),
        "summary": {
            "miles_by_level": {lvl.key: round(m, 1) for lvl, m in summary.miles_by_level.items()},
            "avg_risk": round(summary.avg_risk, 2),
            "max_level": int(summary.max_level),
            "checkpoint_count": len(cps),
        },
        "checkpoints": [
            {
                "index": k,
                "mile": round(cp.mile, 1),
                "lon": round(cp.point[0], 5),
                "lat": round(cp.point[1], 5),
                "eta": cp.eta.isoformat(),
                "elapsed_s": round(cp.elapsed_s),
                "wind_mph": round(cp.weather.wind_mph, 1),
                "rain_in_hr": round(cp.weather.rain_in_hr, 3),
                "snow_in_hr": round(cp.weather.snow_in_hr, 3),
                "level": int(cp.level),
                "score": cp.score,
                "reasons": cp.reasons or [],
            }
            for k, cp in enumerate(cps)
        ],
    }
