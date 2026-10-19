import pytest

from routing.services.risk import RiskLevel as L
from routing.services.risk import Weather, assess


def w(wind=0.0, rain=0.0, snow=0.0):
    return Weather(wind_mph=wind, rain_in_hr=rain, snow_in_hr=snow)


@pytest.mark.parametrize(
    "wind,expected",
    [
        (0, L.LOW),
        (24.9, L.LOW),
        (25, L.MODERATE),
        (34.9, L.MODERATE),
        (35, L.HIGH),
        (44.9, L.HIGH),
        (45, L.SEVERE),
        (54.9, L.SEVERE),
        (55, L.NO_TRAVEL),
        (70, L.NO_TRAVEL),
    ],
)
def test_wind_bands_light_load(wind, expected):
    assert assess(w(wind=wind), load_lb=10_000).level == expected


@pytest.mark.parametrize(
    "rain,expected",
    [(0.09, L.LOW), (0.10, L.MODERATE), (0.25, L.HIGH), (0.50, L.SEVERE), (1.00, L.SEVERE), (1.01, L.NO_TRAVEL)],
)
def test_rain_bands(rain, expected):
    assert assess(w(rain=rain), load_lb=0).level == expected


@pytest.mark.parametrize(
    "snow,expected",
    [(0.49, L.LOW), (0.5, L.MODERATE), (1.0, L.HIGH), (2.0, L.SEVERE), (3.0, L.SEVERE), (3.1, L.NO_TRAVEL)],
)
def test_snow_bands(snow, expected):
    assert assess(w(snow=snow), load_lb=0).level == expected


@pytest.mark.parametrize(
    "wind,load,expected",
    [
        (55, 1_000, L.NO_TRAVEL),  # >=55 is No Travel for any load
        (50, 30_000, L.SEVERE),  # 45-54 needs strictly >30k to escalate
        (50, 30_001, L.NO_TRAVEL),
        (40, 40_000, L.HIGH),  # 35-44 needs strictly >40k
        (40, 40_001, L.SEVERE),
        (40, 35_000, L.HIGH),  # 35-44 between 30k and 40k is unaffected
        (30, 80_000, L.MODERATE),  # load rules leave lower bands alone
    ],
)
def test_load_rules(wind, load, expected):
    assert assess(w(wind=wind), load_lb=load).level == expected


def test_worst_condition_wins_and_reasons_name_it():
    result = assess(w(wind=30, rain=0.6, snow=0.2), load_lb=20_000)
    assert result.level == L.SEVERE
    assert result.reasons == ["Rain 0.60 in/hr"]


def test_load_rule_reason_is_reported():
    result = assess(w(wind=47), load_lb=35_000)
    assert result.level == L.NO_TRAVEL
    assert "30,000" in result.reasons[0]


@pytest.mark.parametrize("wind", [0, 12, 25, 30, 35, 44, 45, 54.9, 55])
@pytest.mark.parametrize("load", [10_000, 35_000, 45_000])
def test_score_is_consistent_with_level(wind, load):
    result = assess(w(wind=wind), load_lb=load)
    assert int(result.score) == result.level
