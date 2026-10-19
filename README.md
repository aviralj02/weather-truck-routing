# Weather-Aware Truck Routing

A React + Django app that helps a truck driver pick the safest route between two places, using the forecast weather along the way, the truck's load weight, and travel time.

- **client/**: Vite, React 19, TypeScript, Tailwind v4, shadcn/ui, MapLibre GL and deck.gl
- **server/**: Django 6, Django REST Framework. Routing and geocoding come from [OpenRouteService](https://openrouteservice.org) (HGV profile). Weather comes from [Open-Meteo](https://open-meteo.com), which needs no key.

## Running locally

```bash
# API
cd server
python -m venv .venv
.venv/Scripts/activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env              # then set ORS_API_KEY (free key at openrouteservice.org)
python manage.py runserver        # http://localhost:8000/api/

# Web
cd client
npm install
cp .env.example .env              # VITE_API_BASE_URL=http://localhost:8000/api
npm run dev                       # http://localhost:5173
```

Tests: `cd server && pytest` runs 80 tests covering the risk table, the load rules, checkpoint and ETA math, ranking, weather retries and caching, and the API.

## How it works

```
POST /api/trips/plan/
  1. Routes      ORS driving-hgv, with the load weight passed as a truck weight restriction → up to 3 distinct routes
  2. Checkpoints a point every 10 / 25 / 50 road miles plus the destination; ETA comes from ORS step durations
  3. Weather     Open-Meteo hourly forecast, batched, read at each checkpoint's ETA
  4. Risk        PRD threshold table + load rules → level per checkpoint → miles per level per route
  5. Recommend   lexicographic ranking (below), plus a one-line reason

POST /api/trips/heatmap/   (fetched by the client right after the plan)
  6. Heatmap     corridor lattice × 49 hourly frames (departure hour + 0…48 h)
```

The heatmap is ~80% of the weather lookups, so it's a second request: routes and the recommendation show as soon as checkpoint weather is in, and the map fills in the heatmap when it arrives. Both requests reuse the same cached routes.

### Three routes on long trips
ORS's built-in `alternative_routes` only works when the trip is under 100 km on the public API. Short trips use it. Longer trips get the fastest HGV route first. The planner then asks for detours through via-points offset to the left and right of that route's midpoint, at growing offsets. A candidate is kept only if:
- it is at most 1.6× the primary route's length, and
- less than 75% of it overlaps any route already kept.

If fewer than 3 distinct routes exist, the UI says so.

### ETA at each checkpoint
ORS returns a duration for every step of the route. That duration is spread over the step's geometry in proportion to distance, which gives an elapsed time at every vertex. The time at a checkpoint is interpolated from those vertex times. Mile markers use ORS's road distance.

### Weather at the ETA
- **Wind** (`wind_speed_10m`, sustained, mph) is instantaneous, so it is linearly interpolated between the two surrounding hours.
- **Rain** (`rain` + `showers`) and **snow** (`snowfall`) are totals for the preceding hour, so the rate at time *t* is the total of the hour that contains *t*.
- Units come straight from the API as mph and in/hr, so they match the risk table without conversion.

### Risk rules
| | Low | Moderate | High | Severe | No Travel |
|---|---|---|---|---|---|
| Wind (mph) | <25 | 25–34 | 35–44 | 45–54 | ≥55 |
| Rain (in/hr) | <0.10 | 0.10–0.25 | 0.25–0.50 | 0.50–1.00 | >1.00 |
| Snow (in/hr) | <0.5 | 0.5–1.0 | 1.0–2.0 | 2.0–3.0 | >3.0 |

- Each band includes its lower bound (wind 35.0 is High). For rain and snow the top band is strictly ">", so 1.00 in/hr of rain is still Severe.
- **Load rules:** 45–54 mph with a load over 30,000 lb is No Travel. 35–44 mph with a load over 40,000 lb is Severe. Wind of 55 mph or more is No Travel for any load.
- A checkpoint's level is the worst of wind (after load rules), rain and snow. The reason is shown, e.g. "45–54 mph wind with load >30,000 lb".
- Each checkpoint stands for the stretch of road halfway to its neighbours on each side. So the miles per level add up exactly to the route's length, and a route's "Severe miles" really are miles.

### Recommendation
Routes are sorted by a tuple:

1. No Travel miles. This comes first because a route the rules forbid can't beat one that is only severe. It's an assumption I added; the PRD doesn't list it.
2. Severe miles
3. High miles
4. Distance-weighted average risk level (0–4)
5. Travel time

Values are rounded before comparing so floating-point noise can't override the next criterion. The UI names the deciding criterion against the runner-up. If every route crosses No Travel conditions, it warns the driver to consider delaying departure.

### Heatmap
- The server picks a regular lon/lat lattice inside a buffer around all routes, keeping it to at most about 450 points.
- For each point it returns hourly risk score, wind, rain and snow for hours 0–48. That's one batched Open-Meteo request set, cached for 30 minutes.
- The heatmap shows a continuous score: band index plus position inside the band, so 30 mph wind scores 1.5. This lets colours blend smoothly while `floor(score)` always equals the discrete level.
- The client rebuilds the lattice and upsamples it with bilinear interpolation into a small image. deck.gl draws that image as an equirectangular `BitmapLayer`, so it stays geographically exact at every zoom (screen-space heatmap blobs don't).
- The slider moves in quarter-hour steps and blends neighbouring forecast hours. Each frame only recomputes about 450 node values and recolours roughly 30k pixels through a lookup table.
- A blue marker shows where the selected route puts the truck at the slider's time, and the trip's driving window is highlighted on the timeline.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/geocode/autocomplete/?q=` | Place search (ORS/Pelias, US + Canada) |
| POST | `/api/trips/plan/` | `{origin, destination, departure_time, load_weight_lb, interval_miles}` → routes, checkpoints, summaries, recommendation |
| POST | `/api/trips/heatmap/` | Same body → corridor heatmap (hours 0–48) |
| GET | `/api/risk-rules/` | The thresholds the server applies |
| GET | `/api/health/` | Liveness |

## Known limitations
- **ETAs leave out hours-of-service rest breaks.** On multi-day trips the truck would really reach later checkpoints later than shown.
- **Wind uses sustained speed, not gusts.** The PRD thresholds read as sustained values.
- **Departure must be within 10 days**, so the trip plus the 48 h window stays inside Open-Meteo's 16-day forecast.
- **The cache is in-process** (LocMem). A multi-instance deployment should use Redis.
