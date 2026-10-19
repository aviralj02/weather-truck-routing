# AGENTS.md

Guide for anyone (human or AI) continuing work on this repo. Read `README.md` for the product, `FLOW.md` for diagrams, and `server/ARCHITECTURE.md` for the Django layout.

## Repo

```
client/   React 19 + Vite + TS + Tailwind v4 + shadcn/ui, MapLibre + deck.gl
server/   Django 6 + DRF, stateless (no models), services call ORS + Open-Meteo
```

## Run

```bash
# server  (needs ORS_API_KEY in server/.env)
cd server && .venv/Scripts/python manage.py runserver   # :8000/api
# client
cd client && npm run dev                                 # :5173
```

## Checks before you finish

```bash
cd server && .venv/Scripts/python -m pytest -q   # all green
cd client && npx tsc -b && npm run lint && npm run build
```

Only the shadcn files in `client/src/components/ui/` may carry lint warnings.

## Server rules

- **Layering:** `urls.py` → `views.py` (thin) → `services/*`.
  - Views only validate (serializers) and return `Response`.
  - Services never import DRF or request objects.
- **Where logic lives:**
  - `ors.py`: routing / geocoding.
  - `weather.py`: forecasts.
  - `risk.py`: thresholds and load rules.
  - `planner.py`: orchestration and ranking.
  - `geo.py`: pure math.
- **External failures:** raise `UpstreamError(message, status_code)`. `routing/exceptions.py` turns it into `{"detail": ...}`. Don't return error responses from services.
- **External calls:** every call has a timeout (`HTTP_TIMEOUT_SECONDS`) and is cached through `django.core.cache` with an explicit TTL. Respect free-tier limits:
  - ORS: about 40 directions requests per minute.
  - Open-Meteo: keep concurrency at 2 or less, batches of 25 or less, and back off on 429/5xx. It can take 10–50 s per batch under load.
- **Keep the plan fast:** `/trips/plan/` only fetches checkpoint weather. Heavy, non-ranking data (like the heatmap) belongs in its own endpoint that the client loads afterwards.
- **Risk table:** lives in `risk.py`, and `client/src/lib/risk.ts` mirrors its thresholds for display only. Change both together, plus `test_risk.py`.
- **Units:** miles, mph, inches/hr, pounds, UTC datetimes.
- **Settings:** come from env via `config/settings.py`. Add new keys to `server/.env.example`.
- **Tests:** add pytest tests for new rules. Mock HTTP with `monkeypatch`; never hit live APIs in tests.

## Client rules

- **Imports:** use the `@/` alias. Put types in `src/lib/types.ts` and keep them in sync with the API JSON.
- **Server data:** use TanStack Query (`useMutation` for plans, `useQuery` for autocomplete) and keep API calls in `src/lib/api.ts`.
- **UI primitives:** use shadcn components from `components/ui`. Add new ones with `npx shadcn add <name>`. Don't hand-edit them unless necessary.
- **Styling:** Tailwind only, using the tokens in `src/index.css`. Don't use raw hex values in components.
  - Neutrals are cool-tinted.
  - `signal` (blue) is the single accent: truck, driving window, focus.
  - `success` marks the recommendation.
  - Risk level colours come only from `LEVELS` in `lib/risk.ts`.
  - Floating surfaces use `shadow-float` and `rounded-xl` / `rounded-2xl`.
- **Map:**
  - MapLibre draws the basemap and the pre-plan preview line (`<Source>` / `<Layer>`).
  - deck.gl (`MapboxOverlay`) draws routes, checkpoints, the heatmap bitmap and the truck.
  - Keep `setWorkerUrl(workerUrl)` in `TripMap.tsx`. Without it, Vite breaks the MapLibre worker and the basemap is blank.
- **Map loading:** `TripMap` is lazy-loaded. Keep MapLibre and deck.gl imports out of other modules.
- **Heatmap:** `lib/heatmapRaster.ts` interpolates the server lattice into an image. Don't switch to screen-space heatmap layers.
- **Layout:** test at 390 px and 1440 px, in light and dark.
  - Below `lg`, the forecast panel stacks under the map.
  - At `lg` and up, it floats over the map.
- **Components:** keep them small and memoized where lists render often (`RouteCards`, `CheckpointList`).
- **Icons:** lucide only, no emoji or unicode glyphs as icons.

## Conventions

- **Line endings and naming:** LF line endings; English copy in sentence case.
- **Type style:** Python is typed with dataclasses. TS is strict, with no `any`.
- **Comments:** explain *why*, not what. Match the existing density.
- **Commits:**
  - Small and imperative ("Add snow load rule").
  - Use the developer's own git identity only, with no AI co-author or attribution trailers.
- **Secrets:** never commit `.env` files or API keys.

## Known limits (don't "fix" silently)

- ETAs ignore hours-of-service breaks.
- Wind uses sustained speed, not gusts.
- Departure is capped at 10 days out (Open-Meteo has a 16-day horizon).
- The cache is in-process. Use Redis for multi-instance deploys.
- The public ORS API can be slow or down. "Routing service is unreachable" usually means an upstream timeout.
