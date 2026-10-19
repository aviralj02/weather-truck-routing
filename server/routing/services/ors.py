"""OpenRouteService client: geocoding autocomplete and truck (HGV) directions.

ORS's native `alternative_routes` option is capped at 100 km on the public API, which
rules it out for most truck trips. So we use it for short trips and otherwise build
alternatives ourselves: route the primary path, then force detours through via-points
offset to either side of its midpoint, keeping only candidates that are genuinely
different from the routes already accepted.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import requests
from django.conf import settings
from django.core.cache import cache

from .exceptions import UpstreamError
from .geo import (
    LonLat,
    bearing_deg,
    cumulative_distances,
    destination_point,
    haversine_mi,
    point_at_distance,
    sample_along,
)

logger = logging.getLogger(__name__)

LB_PER_TONNE = 2204.62
NATIVE_ALTERNATIVES_MAX_STRAIGHT_MI = 50  # ORS rejects native alternatives beyond ~100 km of route
TARGET_ROUTES = 3
MAX_DETOUR_RATIO = 1.6  # discard alternatives far longer than the primary route
MAX_OVERLAP = 0.75  # candidates sharing more than this fraction of road with an accepted route are duplicates
ROUTE_CACHE_TTL = 60 * 60
GEOCODE_CACHE_TTL = 24 * 60 * 60


@dataclass
class Route:
    coords: list[LonLat]
    distance_mi: float
    duration_s: float
    vertex_time_s: list[float]  # elapsed driving time at each vertex
    vertex_dist_mi: list[float]  # cumulative geodesic distance at each vertex
    roads: list[str] = field(default_factory=list)  # main roads by distance, for labeling
    via: LonLat | None = None


# --------------------------------------------------------------------------- HTTP


def _require_key() -> str:
    if not settings.ORS_API_KEY:
        raise UpstreamError("ORS_API_KEY is not configured on the server.", status_code=500)
    return settings.ORS_API_KEY


def _ors_error(resp: requests.Response) -> UpstreamError:
    try:
        err = resp.json().get("error")
        message = err.get("message") if isinstance(err, dict) else str(err)
    except ValueError:
        message = None
    logger.warning("ORS %s: %s", resp.status_code, message or resp.text[:200])
    if resp.status_code == 429:
        return UpstreamError("Routing rate limit reached. Please wait a minute and retry.", status_code=429)
    if resp.status_code in (400, 404):
        return UpstreamError(message or "No truck route found between these locations.", status_code=422)
    return UpstreamError(message or "Routing service returned an error.")


# --------------------------------------------------------------------------- Geocoding


def autocomplete(text: str, focus: LonLat | None = None) -> list[dict]:
    key = "geo:" + hashlib.sha1(f"{text.lower()}|{focus}".encode()).hexdigest()
    if (hit := cache.get(key)) is not None:
        return hit

    params = {"api_key": _require_key(), "text": text, "boundary.country": "US,CA", "size": 6}
    if focus:
        params["focus.point.lon"], params["focus.point.lat"] = focus
    try:
        resp = requests.get(
            f"{settings.ORS_BASE_URL}/geocode/autocomplete", params=params, timeout=settings.HTTP_TIMEOUT_SECONDS
        )
    except requests.RequestException as exc:
        raise UpstreamError("Geocoding service is unreachable.") from exc
    if resp.status_code != 200:
        raise _ors_error(resp)

    results = [
        {
            "label": f["properties"].get("label"),
            "lon": f["geometry"]["coordinates"][0],
            "lat": f["geometry"]["coordinates"][1],
        }
        for f in resp.json().get("features", [])
    ]
    cache.set(key, results, GEOCODE_CACHE_TTL)
    return results


# --------------------------------------------------------------------------- Directions


def _directions(waypoints: list[LonLat], load_lb: float, native_alternatives: bool = False) -> list[Route]:
    body: dict = {
        "coordinates": [list(p) for p in waypoints],
        "units": "mi",
        "instructions": True,
        "geometry_simplify": False,
        # Snap endpoints within 5 km; via-points (detour targets) may snap anywhere.
        "radiuses": [5000] + [-1] * (len(waypoints) - 2) + [5000],
        "options": {
            "vehicle_type": "hgv",
            "profile_params": {"restrictions": {"weight": round(load_lb / LB_PER_TONNE, 2)}},
        },
    }
    if native_alternatives:
        body["alternative_routes"] = {"target_count": TARGET_ROUTES, "share_factor": 0.6, "weight_factor": 1.6}

    key = "ors:" + hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest()
    if (hit := cache.get(key)) is not None:
        return hit

    try:
        resp = requests.post(
            f"{settings.ORS_BASE_URL}/v2/directions/driving-hgv/geojson",
            json=body,
            headers={"Authorization": _require_key(), "Accept": "application/geo+json"},
            timeout=settings.HTTP_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        raise UpstreamError("Routing service is unreachable.") from exc
    if resp.status_code != 200:
        raise _ors_error(resp)

    routes = [_parse_feature(f) for f in resp.json().get("features", [])]
    cache.set(key, routes, ROUTE_CACHE_TTL)
    return routes


def _parse_feature(feature: dict) -> Route:
    coords: list[LonLat] = [(c[0], c[1]) for c in feature["geometry"]["coordinates"]]
    props = feature["properties"]
    vertex_dist = cumulative_distances(coords)

    # Spread each step's duration over its vertices in proportion to distance, so the
    # elapsed time at any vertex reflects ORS's road-speed model for truck traffic.
    vertex_time = [0.0] * len(coords)
    road_miles: Counter[str] = Counter()
    for segment in props.get("segments", []):
        for step in segment.get("steps", []):
            start, end = step["way_points"]
            if end <= start:
                continue
            t0 = vertex_time[start]
            span = vertex_dist[end] - vertex_dist[start]
            for i in range(start + 1, end + 1):
                frac = (vertex_dist[i] - vertex_dist[start]) / span if span > 0 else (i - start) / (end - start)
                vertex_time[i] = t0 + step["duration"] * frac
            name = step.get("name") or ""
            if name and name != "-":
                road_miles[name] += step.get("distance", 0)

    summary = props.get("summary", {})
    duration = summary.get("duration", vertex_time[-1])
    # Ensure monotonic and anchored to ORS's reported total.
    if vertex_time[-1] > 0 and duration:
        scale = duration / vertex_time[-1]
        vertex_time = [t * scale for t in vertex_time]

    return Route(
        coords=coords,
        distance_mi=summary.get("distance", vertex_dist[-1]),
        duration_s=duration,
        vertex_time_s=vertex_time,
        vertex_dist_mi=vertex_dist,
        roads=[name for name, _ in road_miles.most_common(3)],
    )


# --------------------------------------------------------------------------- Alternatives


def _overlap(a: Route, b: Route, tolerance_mi: float = 1.0) -> float:
    """Fraction of route `a` (sampled every mile) that runs within `tolerance_mi` of route `b`."""
    cell = 0.05  # degrees (~3.5 mi), larger than the tolerance so a 3x3 lookup suffices
    grid: dict[tuple[int, int], list[LonLat]] = defaultdict(list)
    for p in sample_along(b.coords, b.vertex_dist_mi, 0.5):
        grid[(int(p[0] // cell), int(p[1] // cell))].append(p)

    samples = sample_along(a.coords, a.vertex_dist_mi, 1.0)
    shared = 0
    for p in samples:
        cx, cy = int(p[0] // cell), int(p[1] // cell)
        if any(
            haversine_mi(p, q) <= tolerance_mi
            for dx in (-1, 0, 1)
            for dy in (-1, 0, 1)
            for q in grid.get((cx + dx, cy + dy), ())
        ):
            shared += 1
    return shared / len(samples)


def _is_distinct(candidate: Route, accepted: list[Route]) -> bool:
    return all(_overlap(candidate, r) < MAX_OVERLAP and _overlap(r, candidate) < MAX_OVERLAP for r in accepted)


def _via_candidates(primary: Route, origin: LonLat, destination: LonLat) -> list[list[LonLat]]:
    """Detour via-points left/right of the primary route's midpoint, at growing offsets."""
    straight = haversine_mi(origin, destination)
    mid, _, _ = point_at_distance(primary.coords, primary.vertex_dist_mi, primary.vertex_dist_mi[-1] / 2)
    heading = bearing_deg(origin, destination)
    rounds = []
    for frac in (0.15, 0.28, 0.42):
        offset = max(8.0, min(160.0, straight * frac))
        rounds.append([destination_point(mid, heading + side, offset) for side in (90, -90)])
    return rounds


def truck_routes(origin: LonLat, destination: LonLat, load_lb: float) -> list[Route]:
    """Up to three distinct HGV routes, primary (fastest) first.

    The finished set is cached so the plan and its heatmap (a separate request) always
    describe the same routes, even if a detour lookup failed transiently the first time.
    """
    straight = haversine_mi(origin, destination)
    if straight < 1:
        raise UpstreamError("Origin and destination are too close together.", status_code=422)

    key = "routes:" + hashlib.sha1(json.dumps([origin, destination, round(load_lb)]).encode()).hexdigest()
    if (hit := cache.get(key)) is not None:
        return hit
    routes = _find_routes(origin, destination, load_lb, straight)
    cache.set(key, routes, ROUTE_CACHE_TTL)
    return routes


def _find_routes(origin: LonLat, destination: LonLat, load_lb: float, straight: float) -> list[Route]:
    if straight <= NATIVE_ALTERNATIVES_MAX_STRAIGHT_MI:
        try:
            routes = _directions([origin, destination], load_lb, native_alternatives=True)
            if len(routes) >= TARGET_ROUTES:
                return routes[:TARGET_ROUTES]
            accepted = routes[:1]
            for r in routes[1:]:
                if _is_distinct(r, accepted):
                    accepted.append(r)
        except UpstreamError as exc:
            if exc.status_code == 429:
                raise
            accepted = []
    else:
        accepted = []

    if not accepted:
        accepted = _directions([origin, destination], load_lb)[:1]
    if not accepted:
        raise UpstreamError("No truck route found between these locations.", status_code=422)
    primary = accepted[0]

    with ThreadPoolExecutor(max_workers=2) as pool:
        for vias in _via_candidates(primary, origin, destination):
            if len(accepted) >= TARGET_ROUTES:
                break
            futures = [pool.submit(_safe_detour, origin, via, destination, load_lb) for via in vias]
            for fut in futures:
                cand = fut.result()
                if (
                    cand
                    and len(accepted) < TARGET_ROUTES
                    and cand.distance_mi <= primary.distance_mi * MAX_DETOUR_RATIO
                    and _is_distinct(cand, accepted)
                ):
                    accepted.append(cand)

    return accepted


def _safe_detour(origin: LonLat, via: LonLat, destination: LonLat, load_lb: float) -> Route | None:
    try:
        route = _directions([origin, via, destination], load_lb)[0]
    except UpstreamError as exc:
        if exc.status_code == 429:
            raise
        return None  # via-point unroutable (water, no roads); try the next candidate
    route.via = via
    return route
