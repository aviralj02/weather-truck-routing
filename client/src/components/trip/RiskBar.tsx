import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LEVELS } from '@/lib/risk'
import type { LevelKey } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Stacked bar of route miles per risk level. */
export function RiskBar({ miles, className }: { miles: Record<LevelKey, number>; className?: string }) {
  const total = LEVELS.reduce((sum, l) => sum + miles[l.key], 0) || 1
  return (
    <div className={cn('flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted', className)}>
      {LEVELS.filter((l) => miles[l.key] > 0).map((l) => (
        <Tooltip key={l.key}>
          <TooltipTrigger asChild>
            <div className="h-full" style={{ width: `${(miles[l.key] / total) * 100}%`, background: l.hex }} />
          </TooltipTrigger>
          <TooltipContent>
            {l.label}: {Math.round(miles[l.key])} mi
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

export function LevelDot({ level, className }: { level: number; className?: string }) {
  return (
    <span
      className={cn('inline-block size-2.5 shrink-0 rounded-full ring-2 ring-background', className)}
      style={{ background: LEVELS[level].hex }}
    />
  )
}

export function LevelBadge({ level }: { level: number }) {
  const meta = LEVELS[level]
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ background: `${meta.hex}1a`, color: `color-mix(in oklch, ${meta.hex} 78%, var(--foreground))` }}
    >
      <span className="size-1.5 rounded-full" style={{ background: meta.hex }} />
      {meta.label}
    </span>
  )
}
