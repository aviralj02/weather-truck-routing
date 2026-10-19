# Server architecture

Django + DRF. No database models. Every request calls external APIs, computes a result, and returns it.

## Django vs. MVC

| MVC term | Django equivalent | Here |
|---|---|---|
| Router | `urls.py` | `config/urls.py` → `routing/urls.py` |
| Controller | `views.py` | `routing/views.py` |
| Request validation / DTO | `serializers.py` | `routing/serializers.py` |
| Business logic | (not built-in) | `routing/services/` |
| Model | `models.py` | none (stateless) |

A **project** (`config/`) holds the global settings. An **app** (`routing/`) holds one feature.

## Layout

```
server/
├── manage.py               CLI: runserver, test, etc.
├── .env                    secrets/config (ORS_API_KEY, CORS, DEBUG)
├── config/                 PROJECT
│   ├── settings.py         installed apps, middleware, CORS, env vars
│   ├── urls.py             root router: /api/ → routing.urls
│   └── wsgi.py / asgi.py   server entry points (gunicorn uses wsgi)
└── routing/                APP
    ├── urls.py             routes → view functions
    ├── views.py            controllers: validate → call service → Response
    ├── serializers.py      input validation (fields, ranges, departure window)
    ├── exceptions.py       turns all errors into {"detail", "errors"}
    ├── services/           business logic, no Django/HTTP request objects
    │   ├── ors.py          OpenRouteService: geocode + 3 truck routes
    │   ├── weather.py      Open-Meteo: batched hourly forecast, cached
    │   ├── risk.py         PRD threshold table + load rules → RiskLevel
    │   ├── planner.py      orchestrator: checkpoints, ETAs, ranking, heatmap
    │   ├── geo.py          pure math: distance, bearing, sampling, simplify
    │   └── exceptions.py   UpstreamError (external API failed)
    └── tests/              pytest
```

## Endpoints

| Route | View | Calls |
|---|---|---|
| `GET /api/health/` | `health` | nothing |
| `GET /api/geocode/autocomplete/?q=` | `geocode_autocomplete` | `ors.autocomplete` |
| `POST /api/trips/plan/` | `plan_trip` | `planner.plan_trip` |
| `POST /api/trips/heatmap/` | `trip_heatmap` | `planner.trip_heatmap` |
| `GET /api/risk-rules/` | `risk_rules` | `risk` constants |

## Request flow: `POST /api/trips/plan/`

```
urls.py → views.plan_trip
  → PlanRequestSerializer      validate body (400 if bad)
  → planner.plan_trip
      ors.truck_routes         up to 3 HGV routes      (ORS)
      build_checkpoints        point every N mi + ETA
      weather.fetch_hourly     forecast per point      (Open-Meteo)
      risk.assess              weather + load → level
      summarize / sort_key     miles per level, pick best
  → Response(JSON)

POST /api/trips/heatmap/  (client calls it after the plan)
  → planner.trip_heatmap
      ors.truck_routes         cached from the plan
      corridor_grid + fetch_hourly + build_heatmap   0–48 h grid

Errors: UpstreamError / ValidationError → exceptions.api_exception_handler
```

## Error messages

| Message | Raised in | Cause |
|---|---|---|
| `ORS_API_KEY is not configured` | `ors._require_key` | key missing in `.env` (restart after adding) |
| `Routing service is unreachable` | `ors._directions` | ORS directions timed out or had a network error (`HTTP_TIMEOUT_SECONDS`, default 20) |
| `Geocoding service is unreachable` | `ors.autocomplete` | same, for search |
| `Weather service is responding too slowly` (504) | `weather._fetch_batch` | Open-Meteo batch exceeded `WEATHER_TIMEOUT_SECONDS` (default 45) |
| `Weather service is unreachable` (502) | `weather._fetch_batch` | network error, or 429/5xx still failing after 3 retries |
| `Routing rate limit reached` | `ors._ors_error` | ORS 429 (free tier quota) |
| `No truck route found` | `ors._ors_error` | ORS 400/404 (e.g. no road nearby) |

## Where to change things

- New endpoint: add a function in `views.py` and a line in `routing/urls.py`.
- Input rules: `serializers.py`.
- Risk thresholds: `services/risk.py`.
- Ranking / checkpoint logic: `services/planner.py`.
- External API behavior: `services/ors.py`, `services/weather.py`.
- Config / env vars: `config/settings.py` + `.env`.
