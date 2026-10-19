export type LonLat = [number, number]

/** 0 Low · 1 Moderate · 2 High · 3 Severe · 4 No Travel */
export type RiskLevel = 0 | 1 | 2 | 3 | 4

export type LevelKey = 'low' | 'moderate' | 'high' | 'severe' | 'no_travel'

export interface Place {
  label: string
  lat: number
  lon: number
}

export type IntervalMiles = 10 | 25 | 50

export interface PlanRequest {
  origin: Place
  destination: Place
  departure_time: string
  load_weight_lb: number
  interval_miles: IntervalMiles
}

export interface Checkpoint {
  index: number
  mile: number
  lon: number
  lat: number
  eta: string
  elapsed_s: number
  wind_mph: number
  rain_in_hr: number
  snow_in_hr: number
  level: RiskLevel
  score: number
  reasons: string[]
}

export interface RiskSegment {
  level: RiskLevel
  path: LonLat[]
}

export interface RouteOption {
  id: string
  name: string
  rank: number
  distance_mi: number
  duration_s: number
  arrival: string
  roads: string[]
  geometry: LonLat[]
  risk_segments: RiskSegment[]
  summary: {
    miles_by_level: Record<LevelKey, number>
    avg_risk: number
    max_level: RiskLevel
    checkpoint_count: number
  }
  checkpoints: Checkpoint[]
}

export interface Heatmap {
  start: string
  hours: number
  spacing_mi: number
  lattice: { lon0: number; lat0: number; dlon: number; dlat: number; rows: number; cols: number }
  cells: [number, number][]
  points: LonLat[]
  risk: number[][]
  wind_mph: number[][]
  rain_in_hr: number[][]
  snow_in_hr: number[][]
}

export interface TripPlan {
  departure: string
  load_lb: number
  interval_mi: IntervalMiles
  recommended_route_id: string
  recommendation: string
  warnings: string[]
  routes: RouteOption[]
}

export type HeatmapMetric = 'risk' | 'wind_mph' | 'rain_in_hr' | 'snow_in_hr'
