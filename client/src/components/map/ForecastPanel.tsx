import { addHours, format } from 'date-fns'
import { EyeIcon, EyeOffIcon, Loader2Icon, PauseIcon, PlayIcon, RotateCwIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LEVELS, METRICS, rampCss } from '@/lib/risk'
import type { HeatmapMetric } from '@/lib/types'

const PLAYBACK_HOURS_PER_SECOND = 5

interface Props {
  /** Epoch ms of forecast hour 0. */
  start: number
  hours: number
  hour: number
  onHourChange: (hour: number) => void
  playing: boolean
  onPlayingChange: (playing: boolean) => void
  metric: HeatmapMetric
  onMetricChange: (metric: HeatmapMetric) => void
  visible: boolean
  onVisibleChange: (visible: boolean) => void
  /** Selected route's driving window, in forecast hours. */
  tripWindow: [number, number]
  /** The heatmap loads after the plan; the slider and truck work meanwhile. */
  status: 'loading' | 'error' | 'ready'
  errorMessage?: string
  onRetry: () => void
}

export function ForecastPanel({
  start,
  hours,
  hour,
  onHourChange,
  playing,
  onPlayingChange,
  metric,
  onMetricChange,
  visible,
  onVisibleChange,
  tripWindow,
  status,
  errorMessage,
  onRetry,
}: Props) {
  const max = hours - 1
  const hourRef = useRef(hour)
  useEffect(() => {
    hourRef.current = hour
  }, [hour])

  // Smooth playback: advance by real elapsed time each animation frame.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const next = hourRef.current + ((now - last) / 1000) * PLAYBACK_HOURS_PER_SECOND
      last = now
      if (next >= max) {
        onHourChange(max)
        onPlayingChange(false)
        return
      }
      onHourChange(next)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, max, onHourChange, onPlayingChange])

  const startDate = new Date(start)
  const at = addHours(startDate, hour)
  const [w0, w1] = [Math.max(0, tripWindow[0]), Math.min(max, tripWindow[1])]
  const m = METRICS[metric]

  return (
    <div className="pointer-events-auto rounded-2xl border border-border/80 bg-background/95 p-3.5 shadow-float backdrop-blur-md">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          size="icon"
          className="rounded-full"
          aria-label={playing ? 'Pause forecast' : 'Play forecast'}
          onClick={() => {
            if (!playing && hour >= max) onHourChange(0)
            onPlayingChange(!playing)
          }}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <div className="min-w-0">
          <div className="text-sm font-semibold tracking-tight tabular-nums">{format(at, 'EEE h:mm a')}</div>
          <div className="text-[11px] text-muted-foreground tabular-nums">
            +{Math.floor(hour)} h from departure hour
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Tabs value={metric} onValueChange={(v) => onMetricChange(v as HeatmapMetric)}>
            <TabsList className="h-7">
              {(Object.keys(METRICS) as HeatmapMetric[]).map((key) => (
                <TabsTrigger key={key} value={key} className="px-2 text-xs">
                  {METRICS[key].label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={visible ? 'Hide heatmap' : 'Show heatmap'}
            onClick={() => onVisibleChange(!visible)}
          >
            {visible ? <EyeIcon /> : <EyeOffIcon />}
          </Button>
        </div>
      </div>

      <div className="relative mt-3 px-1">
        {/* Selected route's driving window on the timeline */}
        {w1 > w0 && (
          <div
            className="pointer-events-none absolute top-1/2 h-3 -translate-y-1/2 rounded-full bg-signal/20 ring-1 ring-signal/30"
            style={{ left: `calc(${(w0 / max) * 100}% + 4px)`, width: `calc(${((w1 - w0) / max) * 100}% - 4px)` }}
            title="Selected route's driving window"
          />
        )}
        <Slider
          value={[hour]}
          min={0}
          max={max}
          step={0.25}
          onValueChange={([v]) => {
            onPlayingChange(false)
            onHourChange(v)
          }}
          aria-label="Forecast hour"
        />
      </div>
      <div className="mt-1.5 flex justify-between px-1 text-[10px] text-muted-foreground tabular-nums">
        {[0, 12, 24, 36, 48].map((h) => (
          <span key={h}>{h === 0 ? format(startDate, 'h a') : `+${h}h`}</span>
        ))}
      </div>

      <div className="mt-2.5 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-full bg-signal ring-2 ring-background" /> Truck at this time
        </span>
        {status === 'loading' && (
          <span role="status" className="ml-auto inline-flex items-center gap-1.5 text-[11px]">
            <Loader2Icon className="size-3 animate-spin" />
            Loading weather heatmap…
          </span>
        )}
        {status === 'error' && (
          <span className="ml-auto inline-flex min-w-0 items-center gap-1.5 text-[11px]">
            <span className="truncate" title={errorMessage}>
              Heatmap unavailable
            </span>
            <Button size="xs" variant="outline" onClick={onRetry}>
              <RotateCwIcon />
              Retry
            </Button>
          </span>
        )}
        {status === 'ready' && (
          <div className="ml-auto w-52 sm:w-56">
            <div className="h-1.5 rounded-full" style={{ background: rampCss }} />
            {/* Each label sits at its level's threshold on the 0–4 ramp */}
            <div className="relative mt-0.5 h-3">
              {LEVELS.slice(1).map((l, i) => (
                <span
                  key={l.key}
                  title={l.label}
                  className="absolute whitespace-nowrap"
                  style={i === 3 ? { right: 0 } : { left: `${((i + 1) / 4) * 100}%`, transform: 'translateX(-50%)' }}
                >
                  {metric === 'risk' ? l.label.replace('No Travel', 'No-go').replace('Moderate', 'Mod') : `${m.bounds[i]}`}
                </span>
              ))}
            </div>
          </div>
        )}
        {status === 'ready' && m.unit && <span>{m.unit}</span>}
      </div>
    </div>
  )
}
