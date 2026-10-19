from django.urls import path

from . import views

urlpatterns = [
    path("health/", views.health),
    path("geocode/autocomplete/", views.geocode_autocomplete),
    path("trips/plan/", views.plan_trip),
    path("trips/heatmap/", views.trip_heatmap),
    path("risk-rules/", views.risk_rules),
]
