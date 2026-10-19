import { useQuery } from '@tanstack/react-query'
import { Loader2Icon, MapPinIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { autocompletePlaces } from '@/lib/api'
import type { Place } from '@/lib/types'
import { cn } from '@/lib/utils'

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}

interface Props {
  id: string
  value: Place | null
  onChange: (place: Place) => void
  placeholder: string
  ariaLabel: string
  className?: string
}

export function LocationCombobox({ id, value, onChange, placeholder, ariaLabel, className }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query.trim(), 250)

  const { data, isFetching, error } = useQuery({
    queryKey: ['autocomplete', debounced],
    queryFn: ({ signal }) => autocompletePlaces(debounced, signal),
    enabled: open && debounced.length >= 2,
    staleTime: 5 * 60_000,
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={value ? `${ariaLabel}: ${value.label}` : ariaLabel}
          className={cn(
            'flex h-11 w-full items-center pr-3 pl-9 text-left text-sm transition-colors',
            'hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:outline-none aria-expanded:bg-muted/60',
            className,
          )}
        >
          <span className={cn('truncate', value ? 'font-medium' : 'text-muted-foreground')}>{value?.label ?? placeholder}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start" sideOffset={6}>
        <Command shouldFilter={false}>
          <CommandInput placeholder="City, address or place…" value={query} onValueChange={setQuery} />
          <CommandList>
            {debounced.length < 2 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">Type at least 2 characters</div>
            ) : isFetching && !data ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" /> Searching…
              </div>
            ) : error ? (
              <div className="px-3 py-6 text-center text-sm text-destructive">{(error as Error).message}</div>
            ) : (
              <>
                <CommandEmpty>No places found.</CommandEmpty>
                <CommandGroup>
                  {data?.map((place) => (
                    <CommandItem
                      key={`${place.lon},${place.lat},${place.label}`}
                      value={`${place.lon},${place.lat},${place.label}`}
                      onSelect={() => {
                        onChange(place)
                        setOpen(false)
                        setQuery('')
                      }}
                    >
                      <MapPinIcon className="text-muted-foreground" />
                      <span className="truncate">{place.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
