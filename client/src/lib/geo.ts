import type { LonLat, RouteOption } from './types'

const R_MI = 3958.7613
const rad = (d: number) => (d * Math.PI) / 180

export function haversineMi(a: LonLat, b: LonLat): number {
  const dLat = rad(b[1] - a[1])
  const dLon = rad(b[0] - a[0])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function boundsOf(coords: LonLat[]): [[number, number], [number, number]] {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const [lon, lat] of coords) {
    if (lon < w) w = lon
    if (lon > e) e = lon
    if (lat < s) s = lat
    if (lat > n) n = lat
  }
  return [
    [w, s],
    [e, n],
  ]
}

/**
 * Returns a function mapping elapsed trip time (seconds) to a position on the route.
 * Time → mile comes from the checkpoints' ETAs (which carry ORS's road-speed model);
 * mile → position walks the route geometry.
 */
export function createRoutePositioner(route: RouteOption): (elapsedS: number) => LonLat | null {
  const geom = route.geometry
  const cum = [0]
  for (let i = 1; i < geom.length; i++) cum.push(cum[i - 1] + haversineMi(geom[i - 1], geom[i]))
  const scale = cum[cum.length - 1] / (route.distance_mi || 1)
  const cps = route.checkpoints

  return (elapsedS: number) => {
    if (elapsedS < 0 || elapsedS > route.duration_s) return null
    let j = 1
    while (j < cps.length - 1 && cps[j].elapsed_s < elapsedS) j++
    const a = cps[j - 1]
    const b = cps[j]
    const span = b.elapsed_s - a.elapsed_s
    const mile = span > 0 ? a.mile + ((b.mile - a.mile) * (elapsedS - a.elapsed_s)) / span : a.mile
    const target = mile * scale

    let lo = 0
    let hi = cum.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (cum[mid] <= target) lo = mid
      else hi = mid
    }
    const seg = cum[hi] - cum[lo]
    const t = seg > 0 ? Math.min(1, Math.max(0, (target - cum[lo]) / seg)) : 0
    return [geom[lo][0] + (geom[hi][0] - geom[lo][0]) * t, geom[lo][1] + (geom[hi][1] - geom[lo][1]) * t]
  }
}

/** Points along the great circle from a to b, for a straight-line preview before routing. */
export function greatCircle(a: LonLat, b: LonLat, segments = 64): LonLat[] {
  const [l1, p1, l2, p2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])]
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2))
  if (d === 0) return [a, b]
  const deg = (r: number) => (r * 180) / Math.PI
  return Array.from({ length: segments + 1 }, (_, i) => {
    const f = i / segments
    const A = Math.sin((1 - f) * d) / Math.sin(d)
    const B = Math.sin(f * d) / Math.sin(d)
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2)
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2)
    const z = A * Math.sin(p1) + B * Math.sin(p2)
    return [deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.sqrt(x * x + y * y)))] as LonLat
  })
}
