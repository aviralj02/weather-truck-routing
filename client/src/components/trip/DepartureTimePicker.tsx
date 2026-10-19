import { addDays, format, startOfDay } from 'date-fns'
import { CalendarIcon } from 'lucide-react'
import { useState } from 'react'

import { Calendar } from '@/components/ui/calendar'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export const MAX_DAYS_AHEAD = 10

interface Props {
  value: Date
  onChange: (date: Date) => void
}

export function DepartureTimePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [today] = useState(() => startOfDay(new Date()))

  const setDay = (day: Date | undefined) => {
    if (!day) return
    const next = new Date(day)
    next.setHours(value.getHours(), value.getMinutes(), 0, 0)
    onChange(next)
    setOpen(false)
  }

  const setTime = (time: string) => {
    const [h, m] = time.split(':').map(Number)
    if (Number.isNaN(h) || Number.isNaN(m)) return
    const next = new Date(value)
    next.setHours(h, m, 0, 0)
    onChange(next)
  }

  return (
    <div className="flex gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Departure date"
            className={cn(
              'flex h-9 flex-1 items-center gap-2 rounded-md border border-input bg-background px-3 text-left text-sm',
              'hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:bg-input/30',
            )}
          >
            <CalendarIcon className="size-4 text-muted-foreground" />
            {format(value, 'EEE, MMM d')}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={value}
            onSelect={setDay}
            disabled={{ before: today, after: addDays(today, MAX_DAYS_AHEAD) }}
            defaultMonth={value}
          />
        </PopoverContent>
      </Popover>
      <Input
        type="time"
        aria-label="Departure time"
        className="h-9 w-[7.5rem] tabular-nums"
        value={format(value, 'HH:mm')}
        onChange={(e) => setTime(e.target.value)}
        step={900}
      />
    </div>
  )
}
