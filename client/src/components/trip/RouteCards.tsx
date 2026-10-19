import { ShieldCheckIcon, TriangleAlertIcon } from 'lucide-react'
import { memo } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { formatDuration, formatEta, formatMiles } from '@/lib/format'
import { LEVELS } from '@/lib/risk'
import type { TripPlan } from '@/lib/types'
import { cn } from '@/lib/utils'

import { LevelBadge, RiskBar } from './RiskBar'

interface Props {
  plan: TripPlan
  selectedId: string
  onSelect: (id: string) => void
}

export const RouteCards = memo(function RouteCards({ plan, selectedId, onSelect }: Props) {
  const routes = [...plan.routes].sort((a, b) => a.rank - b.rank)
  const fastest = Math.min(...plan.routes.map((r) => r.duration_s))

  return (
    <div className="space-y-3">
      <div className="flex gap-3 rounded-xl bg-success/[0.08] px-3.5 py-3 text-[13px] leading-relaxed dark:bg-success/[0.12]">
        <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
        <p className="text-pretty text-foreground/85">{plan.recommendation}</p>
      </div>

      {plan.warnings.map((w) => (
        <Alert key={w} variant="destructive" className="rounded-xl py-2.5">
          <TriangleAlertIcon />
          <AlertDescription>{w}</AlertDescription>
        </Alert>
      ))}

      <div role="radiogroup" aria-label="Route options" className="space-y-2">
        {routes.map((route) => {
          const selected = route.id === selectedId
          const recommended = route.id === plan.recommended_route_id
          const m = route.summary.miles_by_level
          const delta = route.duration_s - fastest
          return (
            <button
              key={route.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onSelect(route.id)}
              className={cn(
                'group/route w-full rounded-xl border p-3.5 text-left transition-[background-color,border-color,box-shadow] duration-200',
                'focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none',
                selected
                  ? 'border-foreground/80 bg-card shadow-float dark:border-foreground/50'
                  : 'border-border bg-card/40 hover:border-foreground/20 hover:bg-card',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold tracking-tight">{route.name}</span>
                    {recommended && (
                      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-success">
                        <ShieldCheckIcon className="size-3" />
                        Recommended
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                    <span>{formatMiles(route.distance_mi)}</span>
                    <span aria-hidden className="text-foreground/20">/</span>
                    <span>{formatDuration(route.duration_s)}</span>
                    {delta > 60 && <span className="text-muted-foreground/70">+{formatDuration(delta)}</span>}
                  </div>
                </div>
                <LevelBadge level={route.summary.max_level} />
              </div>

              <RiskBar miles={m} className="mt-3.5" />

              <dl className="mt-3 grid grid-cols-[1fr_1fr_1fr_auto] gap-2 border-t border-border/70 pt-2.5 text-xs tabular-nums">
                <Stat label="Severe+" value={`${Math.round(m.severe + m.no_travel)} mi`} alert={m.severe + m.no_travel > 0} />
                <Stat label="High" value={`${Math.round(m.high)} mi`} />
                <Stat label="Avg risk" value={route.summary.avg_risk.toFixed(2)} />
                <Stat label="Arrive" value={formatEta(route.arrival, plan.departure)} />
              </dl>
            </button>
          )
        })}
      </div>
    </div>
  )
})

function Stat({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 text-[13px] font-medium whitespace-nowrap', alert && 'text-destructive')}>{value}</dd>
    </div>
  )
}

export function LevelLegend() {
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[11px] text-muted-foreground">
      {LEVELS.map((l) => (
        <span key={l.key} className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: l.hex }} />
          {l.label}
        </span>
      ))}
    </div>
  )
}
