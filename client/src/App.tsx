import { useMutation, useQuery } from '@tanstack/react-query'
import { Loader2Icon, MoonIcon, SunIcon, TruckIcon } from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import { ForecastPanel } from '@/components/map/ForecastPanel'
import { CheckpointList } from '@/components/trip/CheckpointList'
import { LevelLegend, RouteCards } from '@/components/trip/RouteCards'
import { TripForm } from '@/components/trip/TripForm'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTheme } from '@/hooks/useTheme'
import { fetchHeatmap, planTrip } from '@/lib/api'
import { formatDateTime, formatMiles, formatWeight } from '@/lib/format'
import { haversineMi } from '@/lib/geo'
import { createHeatmapRaster } from '@/lib/heatmapRaster'
import type { HeatmapMetric, Place, PlanRequest, TripPlan } from '@/lib/types'

// MapLibre + deck.gl are the bulk of the bundle; load them in parallel with the form.
const TripMap = lazy(() => import('@/components/map/TripMap').then((m) => ({ default: m.TripMap })))

// Wide layouts float the forecast panel over the map's lower edge; narrow ones stack it below.
const FIT_PADDING_WIDE = { top: 60, bottom: 210, left: 60, right: 60 }
const FIT_PADDING_NARROW = { top: 40, bottom: 40, left: 30, right: 30 }
const WIDE_QUERY = '(min-width: 1024px)'
const FORECAST_HOURS = 49 // hours 0..48 from the departure hour, matching the server's heatmap

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export default function App() {
  const { theme, toggle } = useTheme()
  const [plan, setPlan] = useState<TripPlan | null>(null)
  const [planRequest, setPlanRequest] = useState<PlanRequest | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredCheckpoint, setHoveredCheckpoint] = useState<number | null>(null)
  const [focusCheckpoint, setFocusCheckpoint] = useState<{ index: number; nonce: number } | null>(null)
  const [hour, setHour] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [metric, setMetric] = useState<HeatmapMetric>('risk')
  const [showHeatmap, setShowHeatmap] = useState(true)
  const [tab, setTab] = useState('routes')
  const wide = useMediaQuery(WIDE_QUERY)
  const [places, setPlaces] = useState<{ origin: Place | null; destination: Place | null }>({
    origin: null,
    destination: null,
  })
  const onPlacesChange = useCallback(
    (origin: Place | null, destination: Place | null) => setPlaces({ origin, destination }),
    [],
  )

  const mutation = useMutation({
    mutationFn: planTrip,
    onSuccess: (data, request) => {
      setPlan(data)
      setPlanRequest(request)
      setSelectedId(data.recommended_route_id)
      setHoveredCheckpoint(null)
      setHour(0)
      setPlaying(false)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const handleSubmit = useCallback((req: PlanRequest) => mutation.mutate(req), [mutation])

  // The heatmap doesn't depend on the checkpoint interval, so switching interval reuses it.
  const heatmapQuery = useQuery({
    queryKey: [
      'heatmap',
      planRequest?.origin,
      planRequest?.destination,
      planRequest?.departure_time,
      planRequest?.load_weight_lb,
    ],
    queryFn: ({ signal }) => fetchHeatmap(planRequest!, signal),
    enabled: !!planRequest,
    staleTime: 30 * 60_000,
    retry: 1,
  })
  const raster = useMemo(() => (heatmapQuery.data ? createHeatmapRaster(heatmapQuery.data) : null), [heatmapQuery.data])
  const heatmapStatus = heatmapQuery.isError ? 'error' : heatmapQuery.data ? 'ready' : 'loading'
  const selectedRoute = plan?.routes.find((r) => r.id === selectedId) ?? null

  // Hour 0 of the forecast is the departure time floored to the UTC hour, as on the server.
  const forecastStart = useMemo(
    () => (plan ? Math.floor(new Date(plan.departure).getTime() / 3_600_000) * 3_600_000 : 0),
    [plan],
  )

  const tripWindow = useMemo<[number, number]>(() => {
    if (!plan || !selectedRoute) return [0, 0]
    const dep = (new Date(plan.departure).getTime() - forecastStart) / 3_600_000
    return [dep, dep + selectedRoute.duration_s / 3600]
  }, [plan, selectedRoute, forecastStart])

  const onFocus = useCallback((index: number) => setFocusCheckpoint({ index, nonce: Date.now() }), [])
  const loading = mutation.isPending

  return (
    <div className="flex h-dvh flex-col bg-background lg:flex-row">
      <aside className="relative z-10 flex max-h-none flex-col border-b bg-sidebar lg:h-full lg:w-[400px] lg:shrink-0 lg:border-r lg:border-b-0">
        <header className="flex items-center gap-3 px-5 pt-5 pb-4">
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs">
            <TruckIcon className="size-[18px]" strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <h1 className="text-[15px] leading-tight font-semibold tracking-tight">Weather-Aware Truck Routing</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">Safest route by weather, load and time</p>
          </div>
          <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Toggle theme" onClick={toggle}>
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="px-5 pt-1 pb-6">
            <TripForm loading={loading} hasPlan={!!plan} onSubmit={handleSubmit} onPlacesChange={onPlacesChange} />
          </div>

          {loading && !plan && (
            <div className="space-y-2.5 border-t p-5">
              <Skeleton className="h-14 w-full rounded-xl" />
              <Skeleton className="h-28 w-full rounded-xl" />
              <Skeleton className="h-28 w-full rounded-xl" />
            </div>
          )}

          {plan && selectedRoute && (
            <div key={plan.departure + plan.interval_mi} className="animate-in border-t duration-500 fade-in slide-in-from-bottom-2">
              <Tabs value={tab} onValueChange={setTab} className="gap-0">
                <div className="flex items-center justify-between px-5 pt-4 pb-3">
                  <TabsList className="h-8">
                    <TabsTrigger value="routes" className="text-xs">
                      Routes ({plan.routes.length})
                    </TabsTrigger>
                    <TabsTrigger value="checkpoints" className="text-xs">
                      Checkpoints ({selectedRoute.checkpoints.length})
                    </TabsTrigger>
                  </TabsList>
                  {loading && <Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
                </div>
                <p className="px-5 pb-4 text-xs leading-relaxed text-muted-foreground">
                  Departing {formatDateTime(plan.departure)} · {formatWeight(plan.load_lb)} · weather every{' '}
                  {plan.interval_mi} mi at ETA
                </p>
                <TabsContent value="routes" className="space-y-4 px-5 pb-6">
                  <RouteCards plan={plan} selectedId={selectedRoute.id} onSelect={setSelectedId} />
                  <LevelLegend />
                </TabsContent>
                <TabsContent value="checkpoints" className="px-3 pb-6">
                  <p className="px-2 pb-2 text-xs font-medium">{selectedRoute.name}</p>
                  <CheckpointList
                    route={selectedRoute}
                    departure={plan.departure}
                    hoveredIndex={hoveredCheckpoint}
                    onHover={setHoveredCheckpoint}
                    onFocus={onFocus}
                  />
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>
      </aside>

      <main className="flex flex-1 flex-col lg:relative lg:h-full">
        <div className="relative h-[60vh] min-h-[380px] lg:h-full">
          <Suspense fallback={<div className="h-full w-full animate-pulse bg-muted" />}>
            <TripMap
              plan={plan}
              raster={raster}
              selectedRoute={selectedRoute}
              onSelectRoute={setSelectedId}
              hoveredCheckpoint={hoveredCheckpoint}
              onHoverCheckpoint={setHoveredCheckpoint}
              focusCheckpoint={focusCheckpoint}
              hour={hour}
              metric={metric}
              showHeatmap={showHeatmap}
              fitPadding={wide ? FIT_PADDING_WIDE : FIT_PADDING_NARROW}
              preview={places}
              forecastStart={forecastStart}
            />
          </Suspense>

          {!plan && !loading && <MapHint origin={places.origin} destination={places.destination} />}

          {loading && (
            <MapPill>
              <Loader2Icon className="size-4 animate-spin text-signal" />
              Routing and sampling weather along each route…
            </MapPill>
          )}
        </div>

        {plan && (
          <div className="p-3 lg:pointer-events-none lg:absolute lg:bottom-4 lg:left-4 lg:w-[560px] lg:p-0">
            <ForecastPanel
              start={forecastStart}
              hours={FORECAST_HOURS}
              status={heatmapStatus}
              errorMessage={heatmapQuery.error?.message}
              onRetry={() => heatmapQuery.refetch()}
              hour={hour}
              onHourChange={setHour}
              playing={playing}
              onPlayingChange={setPlaying}
              metric={metric}
              onMetricChange={setMetric}
              visible={showHeatmap}
              onVisibleChange={setShowHeatmap}
              tripWindow={tripWindow}
            />
          </div>
        )}
      </main>
    </div>
  )
}

function MapPill({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute top-3 right-14 left-3 flex justify-center lg:inset-x-0 lg:top-5 lg:px-4">
      <div
        role="status"
        className="flex max-w-full animate-in items-center gap-2 rounded-full text-center border border-border/80 bg-background/95 px-4 py-2 text-[13px] shadow-float backdrop-blur duration-300 fade-in slide-in-from-top-1"
      >
        {children}
      </div>
    </div>
  )
}

/** Guides the first trip: what to choose next, then how far apart the endpoints are. */
function MapHint({ origin, destination }: { origin: Place | null; destination: Place | null }) {
  if (origin && destination) {
    const mi = haversineMi([origin.lon, origin.lat], [destination.lon, destination.lat])
    return (
      <MapPill>
        <span className="font-medium tabular-nums">{formatMiles(mi)}</span>
        <span className="text-muted-foreground">straight line · ready to plan</span>
      </MapPill>
    )
  }
  return (
    <MapPill>
      <span className="text-muted-foreground">
        {origin
          ? 'Now choose a destination'
          : destination
            ? 'Now choose an origin'
            : 'Choose an origin and destination to compare three truck routes against the forecast'}
      </span>
    </MapPill>
  )
}
