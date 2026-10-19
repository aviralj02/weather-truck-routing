import { SnowflakeIcon } from 'lucide-react'
import { memo } from 'react'

import { formatEta } from '@/lib/format'
import { LEVELS } from '@/lib/risk'
import type { RouteOption } from '@/lib/types'
import { cn } from '@/lib/utils'

import { LevelDot } from './RiskBar'

interface Props {
  route: RouteOption
  departure: string
  hoveredIndex: number | null
  onHover: (index: number | null) => void
  onFocus: (index: number) => void
}

export const CheckpointList = memo(function CheckpointList({ route, departure, hoveredIndex, onHover, onFocus }: Props) {
  return (
    <div>
      <div className="sticky top-0 z-10 grid grid-cols-[3rem_4.75rem_1fr_2.75rem_3.25rem] gap-2 border-b bg-background/95 px-2 py-2 text-[11px] font-medium text-muted-foreground backdrop-blur">
        <span>Mile</span>
        <span>ETA</span>
        <span>Risk</span>
        <span className="text-right">Wind</span>
        <span className="text-right">Precip</span>
      </div>
      <ul onMouseLeave={() => onHover(null)}>
        {route.checkpoints.map((cp) => {
          return (
            <li key={cp.index}>
              <button
                type="button"
                onMouseEnter={() => onHover(cp.index)}
                onFocus={() => onHover(cp.index)}
                onClick={() => onFocus(cp.index)}
                title={cp.reasons.join(' · ') || undefined}
                className={cn(
                  'grid w-full grid-cols-[3rem_4.75rem_1fr_2.75rem_3.25rem] items-center gap-2 rounded-lg px-2 py-2 text-left text-xs tabular-nums transition-colors',
                  'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
                  hoveredIndex === cp.index ? 'bg-muted' : 'hover:bg-muted/60',
                )}
              >
                <span className="text-muted-foreground">{Math.round(cp.mile)}</span>
                <span>{formatEta(cp.eta, departure)}</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <LevelDot level={cp.level} />
                  <span className="truncate">{cp.reasons[0] ?? LEVELS[cp.level].label}</span>
                </span>
                <span className="text-right">{Math.round(cp.wind_mph)}</span>
                <span className="flex items-center justify-end gap-0.5 text-muted-foreground">
                  {cp.snow_in_hr > 0 ? (
                    <>
                      {cp.snow_in_hr.toFixed(1)}″
                      <SnowflakeIcon aria-label="snow" className="size-3 text-signal" />
                    </>
                  ) : (
                    `${cp.rain_in_hr.toFixed(2)}″`
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
})
