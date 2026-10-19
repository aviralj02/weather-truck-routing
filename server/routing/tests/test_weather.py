from datetime import datetime, timedelta, timezone

from routing.services.weather import HourlySeries

T0 = datetime(2026, 1, 1, 0, tzinfo=timezone.utc)


def series():
    return HourlySeries(start=T0, wind_mph=[10, 20, 30], rain_in=[0.0, 0.2, 0.4], snow_in=[0.0, 0.0, 1.0])


def test_wind_is_interpolated():
    assert series().at(T0 + timedelta(minutes=30)).wind_mph == 15


def test_precip_uses_hour_containing_instant():
    # 00:30 falls in the hour ending 01:00, whose total is rain_in[1]
    assert series().at(T0 + timedelta(minutes=30)).rain_in_hr == 0.2
    assert series().at(T0 + timedelta(hours=1)).rain_in_hr == 0.2
    assert series().at(T0 + timedelta(hours=1, minutes=1)).snow_in_hr == 1.0


def test_clamps_outside_window():
    assert series().at(T0 + timedelta(hours=10)).wind_mph == 30
    assert series().at(T0 - timedelta(hours=1)).wind_mph == 10


def test_retries_rate_limited_batch(monkeypatch):
    from routing.services import weather

    class Resp:
        def __init__(self, status):
            self.status_code = status
            self.headers = {"content-type": "application/json"}

        def json(self):
            return {"reason": "Too many concurrent requests"} if self.status_code == 429 else {
                "hourly": {"wind_speed_10m": [5], "rain": [0], "showers": [None], "snowfall": [0]}
            }

    statuses = iter([429, 200])
    monkeypatch.setattr(weather.requests, "get", lambda *a, **k: Resp(next(statuses)))
    monkeypatch.setattr(weather.time, "sleep", lambda s: None)
    [s] = weather._fetch_batch([(-90.0, 40.0)], T0, 1)
    assert s.wind_mph == [5.0]


def test_finished_batches_are_cached_when_another_fails(monkeypatch):
    import pytest
    from django.core.cache import cache
    from routing.services import weather
    from routing.services.exceptions import UpstreamError

    cache.clear()
    good, bad = [(-90.0, 40.0)], [(-91.0, 41.0)]

    def fetch(points, start, hours):
        if points == bad:
            raise UpstreamError("slow", 504)
        return [HourlySeries(start, [5.0], [0.0], [0.0])]

    monkeypatch.setattr(weather, "BATCH_SIZE", 1)
    monkeypatch.setattr(weather, "_fetch_batch", fetch)
    with pytest.raises(UpstreamError):
        weather.fetch_hourly(good + bad, T0, 1)
    assert cache.get(weather._cache_key(good[0], T0, 1)) is not None


def test_slow_weather_is_reported_as_timeout(monkeypatch):
    import pytest
    from routing.services import weather
    from routing.services.exceptions import UpstreamError

    def slow(*a, **k):
        raise weather.requests.ReadTimeout()

    monkeypatch.setattr(weather.requests, "get", slow)
    with pytest.raises(UpstreamError) as exc:
        weather._fetch_batch([(-90.0, 40.0)], T0, 1)
    assert exc.value.status_code == 504
