import { COORDINATE_SYSTEM, type PickingInfo } from '@deck.gl/core'
import { BitmapLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers'
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox'
import { setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Layer, Map, NavigationControl, Source, useControl, type MapRef } from 'react-map-gl/maplibre'

import { useTheme } from '@/hooks/useTheme'
import { boundsOf, createRoutePositioner, greatCircle } from '@/lib/geo'
import type { HeatmapRaster } from '@/lib/heatmapRaster'
import { LEVELS } from '@/lib/risk'
import type { Checkpoint, HeatmapMetric, LonLat, Place, RiskSegment, RouteOption, TripPlan } from '@/lib/types'

import { MapTooltip, type HoverInfo } from './MapTooltip'

const STYLES = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
}

// MapLibre resolves its worker relative to its own module, which Vite's dependency
// pre-bundling relocates; point it at the real file so the basemap can load.
setWorkerUrl(workerUrl)

const INITIAL_VIEW = { longitude: -98.5, latitude: 39.5, zoom: 3.6 }
const PREVIEW_PADDING = { top: 110, bottom: 110, left: 90, right: 90 }

const SIGNAL = { light: [37, 99, 235], dark: [96, 150, 250] } as const

function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props))
  overlay.setProps(props)
  return null
}

interface Props {
  plan: TripPlan | null
  raster: HeatmapRaster | null
  selectedRoute: RouteOption | null
  onSelectRoute: (id: string) => void
  hoveredCheckpoint: number | null
  onHoverCheckpoint: (index: number | null) => void
  focusCheckpoint: { index: number; nonce: number } | null
  hour: number
  metric: HeatmapMetric
  showHeatmap: boolean
  fitPadding: { top: number; bottom: number; left: number; right: number }
  /** Endpoints chosen in the form, previewed until a plan exists. */
  preview: { origin: Place | null; destination: Place | null }
  /** Epoch ms of forecast hour 0. */
  forecastStart: number
}

export function TripMap({
  plan,
  raster,
  selectedRoute,
  onSelectRoute,
  hoveredCheckpoint,
  onHoverCheckpoint,
  focusCheckpoint,
  hour,
  metric,
  showHeatmap,
  fitPadding,
  preview,
  forecastStart,
}: Props) {
  const { theme } = useTheme()
  const mapRef = useRef<MapRef>(null)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const dark = theme === 'dark'

  // Frame all routes whenever a new plan arrives (padding changes alone shouldn't refit).
  const paddingRef = useRef(fitPadding)
  useEffect(() => {
    paddingRef.current = fitPadding
  }, [fitPadding])
  useEffect(() => {
    if (!plan || !mapRef.current) return
    const coords = plan.routes.flatMap((r) => r.geometry)
    mapRef.current.fitBounds(boundsOf(coords), { padding: paddingRef.current, duration: 900, maxZoom: 10 })
  }, [plan])

  useEffect(() => {
    if (!focusCheckpoint || !selectedRoute || !mapRef.current) return
    const cp = selectedRoute.checkpoints[focusCheckpoint.index]
    if (cp) mapRef.current.flyTo({ center: [cp.lon, cp.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: 700 })
  }, [focusCheckpoint, selectedRoute])

  // Before a plan exists, frame whatever endpoints have been chosen.
  const { origin, destination } = preview
  useEffect(() => {
    const map = mapRef.current
    if (plan || !map) return
    if (origin && destination) {
      map.fitBounds(
        boundsOf([
          [origin.lon, origin.lat],
          [destination.lon, destination.lat],
        ]),
        { padding: PREVIEW_PADDING, duration: 1100, maxZoom: 8 },
      )
    } else if (origin || destination) {
      const p = (origin ?? destination)!
      map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 5.5), duration: 1100 })
    }
  }, [plan, origin, destination])

  const previewLine = useMemo(() => {
    if (plan || !origin || !destination) return null
    return {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: greatCircle([origin.lon, origin.lat], [destination.lon, destination.lat]),
      },
    }
  }, [plan, origin, destination])

  const positioner = useMemo(() => (selectedRoute ? createRoutePositioner(selectedRoute) : null), [selectedRoute])

  // Hour 0 of the forecast is the departure hour (floored); the truck marker shows
  // where the selected route puts the driver at the slider's time.
  const truckPosition = useMemo<LonLat | null>(() => {
    if (!plan || !positioner) return null
    const t = forecastStart + hour * 3_600_000
    return positioner((t - new Date(plan.departure).getTime()) / 1000)
  }, [plan, positioner, hour, forecastStart])

  const heatmapImage = useMemo(
    () => (raster && showHeatmap ? raster.render(metric, hour) : null),
    [raster, showHeatmap, metric, hour],
  )

  const casing = useMemo<[number, number, number, number]>(() => (dark ? [15, 15, 20, 255] : [255, 255, 255, 255]), [dark])

  const staticLayers = useMemo(() => {
    if (!plan || !selectedRoute) return []
    const alternatives = plan.routes.filter((r) => r.id !== selectedRoute.id)
    return [
      new PathLayer<RouteOption>({
        id: 'alt-routes',
        data: alternatives,
        getPath: (r) => r.geometry,
        getColor: dark ? [150, 150, 165, 200] : [110, 110, 125, 190],
        getWidth: 4,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: dark ? [220, 220, 235, 230] : [40, 40, 50, 230],
        onClick: (info) => info.object && onSelectRoute(info.object.id),
      }),
      new PathLayer<{ path: LonLat[] }>({
        id: 'selected-casing',
        data: [{ path: selectedRoute.geometry }],
        getPath: (d) => d.path,
        getColor: casing,
        getWidth: 9,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
      }),
      new PathLayer<RiskSegment>({
        id: 'selected-risk',
        data: selectedRoute.risk_segments,
        getPath: (s) => s.path,
        getColor: (s) => LEVELS[s.level].rgb,
        getWidth: 5,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
      }),
    ]
  }, [plan, selectedRoute, dark, casing, onSelectRoute])

  const checkpointLayer = useMemo(() => {
    if (!selectedRoute) return null
    return new ScatterplotLayer<Checkpoint>({
      id: 'checkpoints',
      data: selectedRoute.checkpoints,
      getPosition: (c) => [c.lon, c.lat],
      getFillColor: (c) => LEVELS[c.level].rgb,
      getLineColor: casing,
      getRadius: (c) => (c.index === hoveredCheckpoint ? 9 : c.level >= 2 ? 6 : 4.5),
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      stroked: true,
      pickable: true,
      updateTriggers: { getRadius: hoveredCheckpoint, getLineColor: dark },
      transitions: { getRadius: 120 },
    })
  }, [selectedRoute, hoveredCheckpoint, dark, casing])

  const endpointsLayer = useMemo(() => {
    let data: { p: LonLat; end: boolean }[]
    if (selectedRoute) {
      const g = selectedRoute.geometry
      data = [
        { p: g[0], end: false },
        { p: g[g.length - 1], end: true },
      ]
    } else {
      data = [
        ...(origin ? [{ p: [origin.lon, origin.lat] as LonLat, end: false }] : []),
        ...(destination ? [{ p: [destination.lon, destination.lat] as LonLat, end: true }] : []),
      ]
    }
    if (!data.length) return null
    return new ScatterplotLayer<{ p: LonLat; end: boolean }>({
      id: 'endpoints',
      data,
      getPosition: (d) => d.p,
      getFillColor: (d) => (d.end ? [17, 17, 17] : [255, 255, 255]),
      getLineColor: (d) => (d.end ? [255, 255, 255] : [17, 17, 17]),
      getRadius: 8,
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      getLineWidth: 3,
      stroked: true,
      transitions: { getPosition: 300 },
    })
  }, [selectedRoute, origin, destination])

  const layers = [
    heatmapImage &&
      raster &&
      new BitmapLayer({
        id: 'heatmap',
        image: heatmapImage,
        bounds: raster.bounds,
        _imageCoordinateSystem: COORDINATE_SYSTEM.LNGLAT,
        pickable: true,
        opacity: 1,
      }),
    ...staticLayers,
    checkpointLayer,
    endpointsLayer,
    truckPosition &&
      new ScatterplotLayer<LonLat>({
        id: 'truck',
        data: [truckPosition],
        getPosition: (d) => d,
        getFillColor: dark ? [...SIGNAL.dark] : [...SIGNAL.light],
        getLineColor: [255, 255, 255],
        getRadius: 7,
        radiusUnits: 'pixels',
        lineWidthUnits: 'pixels',
        getLineWidth: 3,
        stroked: true,
      }),
  ]

  const onHover = useCallback(
    (info: PickingInfo) => {
      const id = info.layer?.id
      if (id === 'checkpoints' && info.object) {
        const cp = info.object as Checkpoint
        onHoverCheckpoint(cp.index)
        setHover({ kind: 'checkpoint', x: info.x, y: info.y, checkpoint: cp })
        return
      }
      onHoverCheckpoint(null)
      if (id === 'alt-routes' && info.object) {
        setHover({ kind: 'route', x: info.x, y: info.y, route: info.object as RouteOption })
      } else if (id === 'heatmap' && info.coordinate && raster) {
        const [lon, lat] = info.coordinate
        const value = raster.sample(metric, hour, lon, lat)
        setHover(value == null ? null : { kind: 'heatmap', x: info.x, y: info.y, metric, value })
      } else {
        setHover(null)
      }
    },
    [onHoverCheckpoint, raster, metric, hour],
  )

  return (
    <div className="relative h-full w-full">
      <Map
        ref={mapRef}
        initialViewState={INITIAL_VIEW}
        mapStyle={dark ? STYLES.dark : STYLES.light}
        style={{ width: '100%', height: '100%' }}
        attributionControl={{ compact: true }}
        dragRotate={false}
        maxPitch={0}
      >
        <NavigationControl position="top-right" showCompass={false} />
        {previewLine && (
          <Source id="preview" type="geojson" data={previewLine}>
            <Layer
              id="preview-line"
              type="line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-color': dark ? '#e5e7eb' : '#1f2937',
                'line-width': 2,
                'line-opacity': 0.7,
                'line-dasharray': [0.5, 2.5],
              }}
            />
          </Source>
        )}
        <DeckOverlay
          layers={layers}
          onHover={onHover}
          getCursor={({ isHovering }) => (isHovering ? 'pointer' : 'grab')}
        />
      </Map>
      {hover && plan && <MapTooltip info={hover} departure={plan.departure} />}
    </div>
  )
}
