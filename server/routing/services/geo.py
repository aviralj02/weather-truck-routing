"""Small spherical-geometry helpers. Coordinates are (lon, lat) tuples, matching GeoJSON."""

from __future__ import annotations

import math
from bisect import bisect_right
from collections.abc import Sequence

EARTH_RADIUS_MI = 3958.7613

LonLat = tuple[float, float]


def haversine_mi(a: LonLat, b: LonLat) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(min(1.0, math.sqrt(h)))


def bearing_deg(a: LonLat, b: LonLat) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dlon = lon2 - lon1
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def destination_point(origin: LonLat, bearing: float, distance_mi: float) -> LonLat:
    lon1, lat1 = map(math.radians, origin)
    brng = math.radians(bearing)
    d = distance_mi / EARTH_RADIUS_MI
    lat2 = math.asin(math.sin(lat1) * math.cos(d) + math.cos(lat1) * math.sin(d) * math.cos(brng))
    lon2 = lon1 + math.atan2(
        math.sin(brng) * math.sin(d) * math.cos(lat1),
        math.cos(d) - math.sin(lat1) * math.sin(lat2),
    )
    return (math.degrees(lon2 + 3 * math.pi) % 360 - 180, math.degrees(lat2))


def cumulative_distances(coords: Sequence[LonLat]) -> list[float]:
    """Running distance (miles) from the first vertex to each vertex."""
    out = [0.0]
    for prev, cur in zip(coords, coords[1:]):
        out.append(out[-1] + haversine_mi(prev, cur))
    return out


def interpolate(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def point_at_distance(coords: Sequence[LonLat], cumdist: Sequence[float], target_mi: float) -> tuple[LonLat, int, float]:
    """Locate the point `target_mi` along the polyline.

    Returns (point, segment_start_index, fraction_along_segment) so callers can
    interpolate other per-vertex values (e.g. elapsed time) the same way.
    """
    if target_mi <= 0:
        return coords[0], 0, 0.0
    if target_mi >= cumdist[-1]:
        return coords[-1], len(coords) - 2, 1.0
    i = bisect_right(cumdist, target_mi) - 1
    seg_len = cumdist[i + 1] - cumdist[i]
    t = 0.0 if seg_len == 0 else (target_mi - cumdist[i]) / seg_len
    a, b = coords[i], coords[i + 1]
    return (interpolate(a[0], b[0], t), interpolate(a[1], b[1], t)), i, t


def sample_along(coords: Sequence[LonLat], cumdist: Sequence[float], step_mi: float) -> list[LonLat]:
    """Evenly spaced points along a polyline, always including both ends."""
    total = cumdist[-1]
    marks = [i * step_mi for i in range(int(total // step_mi) + 1)]
    if not marks or total - marks[-1] > 1e-6:
        marks.append(total)
    return [point_at_distance(coords, cumdist, m)[0] for m in marks]


def bbox(coords: Sequence[LonLat]) -> tuple[float, float, float, float]:
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    return min(lons), min(lats), max(lons), max(lats)


def simplify(coords: Sequence[LonLat], tolerance_deg: float = 0.0002) -> list[LonLat]:
    """Ramer-Douglas-Peucker in degree space (iterative). ~0.0002 deg is ~20 m: invisible on a map."""
    n = len(coords)
    if n < 3:
        return list(coords)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    tol2 = tolerance_deg**2
    while stack:
        start, end = stack.pop()
        ax, ay = coords[start]
        bx, by = coords[end]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        worst, worst_i = -1.0, -1
        for i in range(start + 1, end):
            px, py = coords[i]
            if seg2 == 0:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
                d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d2 > worst:
                worst, worst_i = d2, i
        if worst > tol2:
            keep[worst_i] = True
            stack.append((start, worst_i))
            stack.append((worst_i, end))
    return [c for c, k in zip(coords, keep) if k]


def slice_by_distance(coords: Sequence[LonLat], cumdist: Sequence[float], start_mi: float, end_mi: float) -> list[LonLat]:
    """Sub-polyline between two distances along the line (endpoints interpolated)."""
    a, ia, _ = point_at_distance(coords, cumdist, start_mi)
    b, ib, _ = point_at_distance(coords, cumdist, end_mi)
    return [a, *coords[ia + 1 : ib + 1], b]
