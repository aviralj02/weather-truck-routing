import { format, isSameDay } from 'date-fns'

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

export const formatMiles = (mi: number) => `${Math.round(mi).toLocaleString()} mi`

/** "3:40 PM" when on the reference day, otherwise "Tue 3:40 PM". */
export function formatEta(iso: string | Date, reference?: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (reference && isSameDay(d, typeof reference === 'string' ? new Date(reference) : reference)) {
    return format(d, 'h:mm a')
  }
  return format(d, 'EEE h:mm a')
}

export const formatDateTime = (iso: string | Date) => format(typeof iso === 'string' ? new Date(iso) : iso, 'EEE, MMM d · h:mm a')

export const formatWeight = (lb: number) => `${Math.round(lb).toLocaleString()} lb`
