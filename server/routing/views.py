from rest_framework.decorators import api_view
from rest_framework.response import Response

from .serializers import AutocompleteQuerySerializer, PlanRequestSerializer
from .services import ors, planner
from .services.risk import RAIN_IN_HR, SNOW_IN_HR, WIND_MPH, RiskLevel


@api_view(["GET"])
def health(request):
    return Response({"status": "ok"})


@api_view(["GET"])
def geocode_autocomplete(request):
    params = AutocompleteQuerySerializer(data=request.query_params)
    params.is_valid(raise_exception=True)
    data = params.validated_data
    focus = (data["lon"], data["lat"]) if "lat" in data and "lon" in data else None
    return Response({"results": ors.autocomplete(data["q"], focus)})


@api_view(["POST"])
def plan_trip(request):
    body = PlanRequestSerializer(data=request.data)
    body.is_valid(raise_exception=True)
    data = body.validated_data
    result = planner.plan_trip(
        origin=(data["origin"]["lon"], data["origin"]["lat"]),
        destination=(data["destination"]["lon"], data["destination"]["lat"]),
        departure=data["departure_time"],
        load_lb=data["load_weight_lb"],
        interval_mi=data["interval_miles"],
    )
    return Response(result)


@api_view(["POST"])
def trip_heatmap(request):
    body = PlanRequestSerializer(data=request.data)
    body.is_valid(raise_exception=True)
    data = body.validated_data
    result = planner.trip_heatmap(
        origin=(data["origin"]["lon"], data["origin"]["lat"]),
        destination=(data["destination"]["lon"], data["destination"]["lat"]),
        departure=data["departure_time"],
        load_lb=data["load_weight_lb"],
    )
    return Response(result)


@api_view(["GET"])
def risk_rules(request):
    """The thresholds the server applies, so the UI legend never drifts from the logic."""

    def table(t):
        return {"moderate": t.moderate, "high": t.high, "severe": t.severe, "no_travel": t.no_travel}

    return Response(
        {
            "levels": [{"value": int(l), "key": l.key, "label": l.label} for l in RiskLevel],
            "wind_mph": table(WIND_MPH),
            "rain_in_hr": table(RAIN_IN_HR),
            "snow_in_hr": table(SNOW_IN_HR),
        }
    )
