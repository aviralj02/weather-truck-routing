import { formatDuration, formatEta, formatMiles } from '@/lib/format'
import { LEVELS, METRICS, scoreFor } from '@/lib/risk'
import type { Checkpoint, HeatmapMetric, RouteOption } from '@/lib/types'

export type HoverInfo =
  | { kind: 'checkpoint'; x: number; y: number; checkpoint: Checkpoint }
  | { kind: 'route'; x: number; y: number; route: RouteOption }
  | { kind: 'heatmap'; x: number; y: number; metric: HeatmapMetric; value: number }

export function MapTooltip({ info, departure }: { info: HoverInfo; departure: string }) {
  return (
    <div
      className="pointer-events-none absolute z-20 max-w-64 -translate-x-1/2 -translate-y-[calc(100%+14px)] rounded-xl border border-border/80 bg-popover/95 px-3 py-2.5 text-xs text-popover-foreground shadow-float backdrop-blur"
      style={{ left: info.x, top: info.y }}
    >
      {info.kind === 'checkpoint' && <CheckpointBody cp={info.checkpoint} departure={departure} />}
      {info.kind === 'route' && (
        <>
          <div className="font-medium">{info.route.name}</div>
          <div className="text-muted-foreground">
            {formatMiles(info.route.distance_mi)} · {formatDuration(info.route.duration_s)} · click to select
          </div>
        </>
      )}
      {info.kind === 'heatmap' && <HeatmapBody metric={info.metric} value={info.value} />}
    </div>
  )
}

function CheckpointBody({ cp, departure }: { cp: Checkpoint; departure: string }) {
  const meta = LEVELS[cp.level]
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">Mile {Math.round(cp.mile)}</span>
        <span className="font-medium" style={{ color: meta.hex }}>
          {meta.label}
        </span>
      </div>
      <div className="text-muted-foreground">
        ETA {formatEta(cp.eta, departure)} · {formatDuration(cp.elapsed_s)} in
      </div>
      <div className="grid grid-cols-3 gap-2 tabular-nums">
        <Metric label="Wind" value={`${Math.round(cp.wind_mph)} mph`} />
        <Metric label="Rain" value={`${cp.rain_in_hr.toFixed(2)}″/h`} />
        <Metric label="Snow" value={`${cp.snow_in_hr.toFixed(2)}″/h`} />
      </div>
      {cp.reasons.length > 0 && <div className="border-t pt-1.5 text-muted-foreground">{cp.reasons.join(' · ')}</div>}
    </div>
  )
}

function HeatmapBody({ metric, value }: { metric: HeatmapMetric; value: number }) {
  const m = METRICS[metric]
  const level = LEVELS[Math.min(4, Math.floor(scoreFor(metric, value)))]
  return (
    <div className="flex items-center gap-2 tabular-nums">
      <span className="size-2 rounded-full" style={{ background: level.hex }} />
      <span>
        {m.label} {value.toFixed(m.digits)} {m.unit}
      </span>
      <span className="text-muted-foreground">· {level.label}</span>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  )
}
