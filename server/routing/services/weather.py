"""Open-Meteo hourly forecast client.

Open-Meteo accepts many coordinates per request, so points are fetched in batches.
Units requested match the risk table directly: mph for wind, inches for rain/snowfall.
`rain` + `showers` gives liquid precipitation; `snowfall` is snow accumulation. Both are
sums over the *preceding* hour, i.e. an hourly rate.
"""

from __future__ import annotations

import logging
import math
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import requests
from django.conf import settings
from django.core.cache import cache

from .exceptions import UpstreamError
from .geo import LonLat
from .risk import Weather

logger = logging.getLogger(__name__)

BATCH_SIZE = 25  # response time grows with points x hours; small batches stay well inside the timeout
MAX_WORKERS = 2  # the free API rejects bursts with 429 "Too many concurrent requests"
RETRY_DELAYS_S = (1.0, 2.5, 5.0)  # backoff before giving up on a busy/overloaded response
RETRY_STATUSES = {429, 502, 503, 504}
CACHE_TTL_SECONDS = 30 * 60
COORD_PRECISION = 2  # ~1 km; finer than the forecast models' grid spacing


@dataclass
class HourlySeries:
    start: datetime  # UTC, on the hour
    wind_mph: list[float]
    rain_in: list[float]
    snow_in: list[float]

    def _index(self, at: datetime) -> float:
        return (at - self.start).total_seconds() / 3600

    def at(self, when: datetime) -> Weather:
        """Weather at an arbitrary instant.

        Wind is instantaneous, so it is linearly interpolated between hours.
        Precipitation is the total for the hour ending at each timestamp, so the
        rate at `when` comes from the hour that contains it (the next timestamp).
        """
        idx = self._index(when)
        last = len(self.wind_mph) - 1
        idx = max(0.0, min(float(last), idx))
        lo = int(math.floor(idx))
        hi = min(last, lo + 1)
        t = idx - lo
        wind = self.wind_mph[lo] + (self.wind_mph[hi] - self.wind_mph[lo]) * t
        precip_idx = min(last, int(math.ceil(idx)))
        return Weather(wind_mph=wind, rain_in_hr=self.rain_in[precip_idx], snow_in_hr=self.snow_in[precip_idx])


def floor_hour(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


def _round_point(p: LonLat) -> LonLat:
    return (round(p[0], COORD_PRECISION), round(p[1], COORD_PRECISION))


def _cache_key(p: LonLat, start: datetime, hours: int) -> str:
    return f"om:{p[0]}:{p[1]}:{start:%Y%m%d%H}:{hours}"


def _nz(values: list[float | None]) -> list[float]:
    return [0.0 if v is None else float(v) for v in values]


def _fetch_batch(points: list[LonLat], start: datetime, hours: int) -> list[HourlySeries]:
    end = start + timedelta(hours=hours - 1)
    params = {
        "latitude": ",".join(f"{p[1]}" for p in points),
        "longitude": ",".join(f"{p[0]}" for p in points),
        "hourly": "wind_speed_10m,rain,showers,snowfall",
        "wind_speed_unit": "mph",
        "precipitation_unit": "inch",
        "timezone": "GMT",
        "start_hour": start.strftime("%Y-%m-%dT%H:%M"),
        "end_hour": end.strftime("%Y-%m-%dT%H:%M"),
    }
    for delay in (*RETRY_DELAYS_S, None):
        try:
            resp = requests.get(settings.OPEN_METEO_BASE_URL, params=params, timeout=settings.WEATHER_TIMEOUT_SECONDS)
        except requests.Timeout as exc:
            raise UpstreamError("Weather service is responding too slowly. Please try again shortly.", 504) from exc
        except requests.RequestException as exc:
            raise UpstreamError("Weather service is unreachable.") from exc
        if resp.status_code not in RETRY_STATUSES or delay is None:
            break
        time.sleep(delay)
    if resp.status_code != 200:
        reason = resp.json().get("reason") if resp.headers.get("content-type", "").startswith("application/json") else None
        logger.warning("Open-Meteo %s: %s", resp.status_code, reason or resp.text[:200])
        raise UpstreamError(reason or "Weather service returned an error.")

    payload = resp.json()
    payload = payload if isinstance(payload, list) else [payload]
    series = []
    for item in payload:
        h = item["hourly"]
        rain = _nz(h["rain"])
        showers = _nz(h["showers"])
        series.append(
            HourlySeries(
                start=start,
                wind_mph=_nz(h["wind_speed_10m"]),
                rain_in=[r + s for r, s in zip(rain, showers)],
                snow_in=_nz(h["snowfall"]),
            )
        )
    return series


def fetch_hourly(points: list[LonLat], start: datetime, hours: int) -> list[HourlySeries]:
    """Hourly forecasts for each point, covering `hours` hours from `start` (floored to the hour).

    Results are aligned with `points`. Nearby points sharing a rounded coordinate are
    fetched once, and each point's series is cached for repeat requests.
    """
    start = floor_hour(start)
    rounded = [_round_point(p) for p in points]
    unique = list(dict.fromkeys(rounded))

    found: dict[LonLat, HourlySeries] = {}
    cached = cache.get_many([_cache_key(p, start, hours) for p in unique])
    missing = []
    for p in unique:
        hit = cached.get(_cache_key(p, start, hours))
        if hit is not None:
            found[p] = hit
        else:
            missing.append(p)

    batches = [missing[i : i + BATCH_SIZE] for i in range(0, len(missing), BATCH_SIZE)]
    if batches:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            results = list(pool.map(lambda b: _fetch_and_cache(b, start, hours), batches))
        for batch, series_list in zip(batches, results):
            found.update(zip(batch, series_list))

    return [found[p] for p in rounded]


def _fetch_and_cache(points: list[LonLat], start: datetime, hours: int) -> list[HourlySeries]:
    # Cache per batch, so a retry after one slow batch only refetches what is still missing.
    series = _fetch_batch(points, start, hours)
    cache.set_many({_cache_key(p, start, hours): s for p, s in zip(points, series)}, CACHE_TTL_SECONDS)
    return series
