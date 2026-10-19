import type { Heatmap, Place, PlanRequest, TripPlan } from './types'

const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '')

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new ApiError('Could not reach the server. Is the API running?', 0)
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    throw new ApiError(body?.detail ?? `Request failed (${res.status})`, res.status)
  }
  return body as T
}

export function autocompletePlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({ q: query })
  return request<{ results: Place[] }>(`/geocode/autocomplete/?${params}`, { signal }).then((r) => r.results)
}

export function planTrip(body: PlanRequest): Promise<TripPlan> {
  return request<TripPlan>('/trips/plan/', { method: 'POST', body: JSON.stringify(body) })
}

/** Corridor heatmap for a plan; fetched after the plan so routes render without waiting on it. */
export function fetchHeatmap(body: PlanRequest, signal?: AbortSignal): Promise<Heatmap> {
  return request<Heatmap>('/trips/heatmap/', { method: 'POST', body: JSON.stringify(body), signal })
}
