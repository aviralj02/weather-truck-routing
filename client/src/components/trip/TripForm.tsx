import { ArrowDownUpIcon, Loader2Icon } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { IntervalMiles, Place, PlanRequest } from '@/lib/types'

import { DepartureTimePicker } from './DepartureTimePicker'
import { LocationCombobox } from './LocationCombobox'

const INTERVALS: IntervalMiles[] = [10, 25, 50]
const MAX_LOAD_LB = 120_000

const EXAMPLES: { label: string; origin: Place; destination: Place }[] = [
  {
    label: 'Chicago → Denver',
    origin: { label: 'Chicago, IL, USA', lat: 41.8781, lon: -87.6298 },
    destination: { label: 'Denver, CO, USA', lat: 39.7392, lon: -104.9903 },
  },
  {
    label: 'Salt Lake City → Sacramento',
    origin: { label: 'Salt Lake City, UT, USA', lat: 40.7608, lon: -111.891 },
    destination: { label: 'Sacramento, CA, USA', lat: 38.5816, lon: -121.4944 },
  },
  {
    label: 'Dallas → Atlanta',
    origin: { label: 'Dallas, TX, USA', lat: 32.7767, lon: -96.797 },
    destination: { label: 'Atlanta, GA, USA', lat: 33.749, lon: -84.388 },
  },
]

function nextQuarterHour(): Date {
  const d = new Date()
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15, 0, 0)
  return d
}

interface Props {
  loading: boolean
  hasPlan: boolean
  onSubmit: (request: PlanRequest) => void
  /** Lets the map preview the endpoints before a plan exists. */
  onPlacesChange?: (origin: Place | null, destination: Place | null) => void
}

export function TripForm({ loading, hasPlan, onSubmit, onPlacesChange }: Props) {
  const [origin, setOrigin] = useState<Place | null>(null)
  const [destination, setDestination] = useState<Place | null>(null)
  const [departure, setDeparture] = useState<Date>(nextQuarterHour)
  const [load, setLoad] = useState('35000')
  const [interval, setIntervalMi] = useState<IntervalMiles>(25)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    onPlacesChange?.(origin, destination)
  }, [origin, destination, onPlacesChange])

  const build = (overrides: Partial<{ interval: IntervalMiles; origin: Place; destination: Place }> = {}) => {
    const o = overrides.origin ?? origin
    const d = overrides.destination ?? destination
    const loadLb = Number(load.replace(/,/g, ''))
    if (!o || !d) return 'Choose an origin and a destination.'
    if (o.lat === d.lat && o.lon === d.lon) return 'Origin and destination must differ.'
    if (!Number.isFinite(loadLb) || loadLb <= 0 || loadLb > MAX_LOAD_LB)
      return `Load weight must be between 1 and ${MAX_LOAD_LB.toLocaleString()} lb.`
    if (departure.getTime() < Date.now() - 60 * 60 * 1000) return 'Departure time is in the past.'
    return {
      origin: o,
      destination: d,
      departure_time: departure.toISOString(),
      load_weight_lb: loadLb,
      interval_miles: overrides.interval ?? interval,
    } satisfies PlanRequest
  }

  const submit = (overrides?: Parameters<typeof build>[0]) => {
    const result = build(overrides)
    if (typeof result === 'string') {
      setError(result)
      return
    }
    setError(null)
    onSubmit(result)
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    submit()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      <Field label="Route" htmlFor="origin">
        <div className="relative rounded-xl border border-input bg-card shadow-xs dark:bg-input/20">
          {/* Origin ring and destination square joined by a dotted connector */}
          <div aria-hidden className="pointer-events-none absolute inset-y-0 left-3.5 flex flex-col items-center py-[15px]">
            <span className="size-2.5 rounded-full border-2 border-foreground/70 bg-card" />
            <span className="my-1 w-px flex-1 border-l border-dashed border-foreground/25" />
            <span className="size-2.5 rounded-[3px] bg-foreground" />
          </div>
          <LocationCombobox
            id="origin"
            value={origin}
            onChange={setOrigin}
            placeholder="Choose origin"
            ariaLabel="Origin"
            className="rounded-t-xl pr-11"
          />
          <div className="mr-12 ml-9 border-t border-border" />
          <LocationCombobox
            id="destination"
            value={destination}
            onChange={setDestination}
            placeholder="Choose destination"
            ariaLabel="Destination"
            className="rounded-b-xl pr-11"
          />
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            aria-label="Swap origin and destination"
            className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-full bg-card shadow-xs"
            onClick={() => {
              setOrigin(destination)
              setDestination(origin)
            }}
          >
            <ArrowDownUpIcon />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              type="button"
              className="rounded-full border border-transparent bg-muted px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-card hover:text-foreground"
              onClick={() => {
                setOrigin(ex.origin)
                setDestination(ex.destination)
              }}
            >
              {ex.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Departure">
        <DepartureTimePicker value={departure} onChange={setDeparture} />
      </Field>

      <div className="grid grid-cols-[1fr_auto] gap-3">
        <Field label="Load weight" htmlFor="load">
          <div className="relative">
            <Input
              id="load"
              inputMode="numeric"
              className="h-9 pr-9 tabular-nums"
              value={load}
              onChange={(e) => setLoad(e.target.value.replace(/[^d,]/g, ''))}
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
              lb
            </span>
          </div>
        </Field>
        <Field label="Weather every">
          <Tabs
            value={String(interval)}
            onValueChange={(v) => {
              const next = Number(v) as IntervalMiles
              setIntervalMi(next)
              if (hasPlan && !loading) submit({ interval: next })
            }}
          >
            <TabsList className="h-9">
              {INTERVALS.map((mi) => (
                <TabsTrigger key={mi} value={String(mi)} className="px-2.5 tabular-nums">
                  {mi} mi
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </Field>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" size="lg" className="h-10 w-full rounded-xl text-[0.9rem]" disabled={loading}>
        {loading && <Loader2Icon className="animate-spin" />}
        {loading ? 'Planning routes…' : 'Plan safest route'}
      </Button>
    </form>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  )
}
