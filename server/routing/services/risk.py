"""Weather risk classification, implementing the PRD's threshold and load tables.

Bands are read as lower-bound-inclusive (e.g. wind 25-34 means 25 <= w < 35), which
matches how the table is written ("<25", "25-34", ... ">=55"). For rain and snow the
top band is ">1.00" / ">3.0", so the boundary value itself stays Severe.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum


class RiskLevel(IntEnum):
    LOW = 0
    MODERATE = 1
    HIGH = 2
    SEVERE = 3
    NO_TRAVEL = 4

    @property
    def label(self) -> str:
        return self.name.replace("_", " ").title()

    @property
    def key(self) -> str:
        return self.name.lower()


@dataclass(frozen=True)
class Thresholds:
    """Lower bounds for Moderate, High, Severe and No Travel."""

    moderate: float
    high: float
    severe: float
    no_travel: float
    no_travel_inclusive: bool  # True for ">= x", False for "> x"

    def level(self, value: float) -> RiskLevel:
        if value > self.no_travel or (self.no_travel_inclusive and value == self.no_travel):
            return RiskLevel.NO_TRAVEL
        if value >= self.severe:
            return RiskLevel.SEVERE
        if value >= self.high:
            return RiskLevel.HIGH
        if value >= self.moderate:
            return RiskLevel.MODERATE
        return RiskLevel.LOW

    def fraction_in_band(self, value: float, level: RiskLevel) -> float:
        """How far `value` sits through its band, 0..1 (used for the continuous heatmap score)."""
        bounds = [0.0, self.moderate, self.high, self.severe, self.no_travel]
        if level == RiskLevel.NO_TRAVEL:
            return 0.0
        lo, hi = bounds[level], bounds[level + 1]
        return max(0.0, min(0.99, (value - lo) / (hi - lo)))


WIND_MPH = Thresholds(moderate=25, high=35, severe=45, no_travel=55, no_travel_inclusive=True)
RAIN_IN_HR = Thresholds(moderate=0.10, high=0.25, severe=0.50, no_travel=1.00, no_travel_inclusive=False)
SNOW_IN_HR = Thresholds(moderate=0.5, high=1.0, severe=2.0, no_travel=3.0, no_travel_inclusive=False)

# Load rules (pounds)
NO_TRAVEL_SEVERE_WIND_LOAD_LB = 30_000
SEVERE_HIGH_WIND_LOAD_LB = 40_000


@dataclass(frozen=True)
class Weather:
    wind_mph: float
    rain_in_hr: float
    snow_in_hr: float


@dataclass
class RiskAssessment:
    level: RiskLevel
    score: float  # continuous 0..4; floor(score) == level
    wind_level: RiskLevel
    rain_level: RiskLevel
    snow_level: RiskLevel
    reasons: list[str] = field(default_factory=list)


def wind_level_for_load(wind_mph: float, load_lb: float) -> tuple[RiskLevel, str | None]:
    """Wind band after applying the load rules. Returns (level, reason if a load rule fired)."""
    base = WIND_MPH.level(wind_mph)
    if base == RiskLevel.SEVERE and load_lb > NO_TRAVEL_SEVERE_WIND_LOAD_LB:
        return RiskLevel.NO_TRAVEL, f"45-54 mph wind with load >{NO_TRAVEL_SEVERE_WIND_LOAD_LB:,} lb"
    if base == RiskLevel.HIGH and load_lb > SEVERE_HIGH_WIND_LOAD_LB:
        return RiskLevel.SEVERE, f"35-44 mph wind with load >{SEVERE_HIGH_WIND_LOAD_LB:,} lb"
    return base, None


def assess(weather: Weather, load_lb: float) -> RiskAssessment:
    wind_base = WIND_MPH.level(weather.wind_mph)
    wind, load_reason = wind_level_for_load(weather.wind_mph, load_lb)
    rain = RAIN_IN_HR.level(weather.rain_in_hr)
    snow = SNOW_IN_HR.level(weather.snow_in_hr)
    level = max(wind, rain, snow)

    # Continuous score per factor: band index + position inside the band. A load rule
    # lifts the wind score into the escalated band while keeping its relative position.
    scores = [
        wind + WIND_MPH.fraction_in_band(weather.wind_mph, wind_base) if wind < RiskLevel.NO_TRAVEL else 4.0,
        rain + RAIN_IN_HR.fraction_in_band(weather.rain_in_hr, rain),
        snow + SNOW_IN_HR.fraction_in_band(weather.snow_in_hr, snow),
    ]
    score = min(4.0, max(scores))

    reasons: list[str] = []
    if level > RiskLevel.LOW:
        if wind == level:
            reasons.append(load_reason or f"Wind {weather.wind_mph:.0f} mph")
        if rain == level:
            reasons.append(f"Rain {weather.rain_in_hr:.2f} in/hr")
        if snow == level:
            reasons.append(f"Snow {weather.snow_in_hr:.2f} in/hr")

    return RiskAssessment(
        level=level,
        score=round(score, 3),
        wind_level=wind,
        rain_level=rain,
        snow_level=snow,
        reasons=reasons,
    )
