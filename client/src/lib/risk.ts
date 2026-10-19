import type { HeatmapMetric, LevelKey, RiskLevel } from './types'

type RGB = [number, number, number]

export interface LevelMeta {
  level: RiskLevel
  key: LevelKey
  label: string
  rgb: RGB
  hex: string
}

const toHex = ([r, g, b]: RGB) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

const LEVEL_DEFS: [LevelKey, string, RGB][] = [
  ['low', 'Low', [34, 160, 94]],
  ['moderate', 'Moderate', [234, 179, 8]],
  ['high', 'High', [249, 115, 22]],
  ['severe', 'Severe', [220, 38, 38]],
  ['no_travel', 'No Travel', [124, 58, 237]],
]

export const LEVELS: LevelMeta[] = LEVEL_DEFS.map(([key, label, rgb], level) => ({
  level: level as RiskLevel,
  key,
  label,
  rgb,
  hex: toHex(rgb),
}))

export const levelMeta = (level: RiskLevel) => LEVELS[level]

/**
 * Lower bounds for Moderate / High / Severe / No Travel — mirrors the server's
 * risk table (routing/services/risk.py). Used only for display: legends and the
 * single-variable heatmap views. Route scoring always comes from the API.
 */
export const METRICS: Record<HeatmapMetric, { label: string; unit: string; bounds: number[]; digits: number }> = {
  risk: { label: 'Risk', unit: '', bounds: [1, 2, 3, 4], digits: 1 },
  wind_mph: { label: 'Wind', unit: 'mph', bounds: [25, 35, 45, 55], digits: 0 },
  rain_in_hr: { label: 'Rain', unit: 'in/hr', bounds: [0.1, 0.25, 0.5, 1.0], digits: 2 },
  snow_in_hr: { label: 'Snow', unit: 'in/hr', bounds: [0.5, 1.0, 2.0, 3.0], digits: 1 },
}

/** Map a raw value onto the continuous 0–4 risk scale using its thresholds. */
export function scoreFor(metric: HeatmapMetric, value: number): number {
  if (metric === 'risk') return value
  const b = [0, ...METRICS[metric].bounds]
  if (value >= b[4]) return 4
  for (let lvl = 3; lvl >= 0; lvl--) {
    if (value >= b[lvl]) return lvl + Math.min(0.99, (value - b[lvl]) / (b[lvl + 1] - b[lvl]))
  }
  return 0
}

/**
 * Heatmap color ramp over the 0–4 score. Low conditions fade to transparent so
 * the basemap stays readable and only weather worth noticing draws attention.
 */
const RAMP: [number, RGB, number][] = [
  [0, [34, 160, 94], 0],
  [0.6, [34, 160, 94], 0.1],
  [1, [234, 179, 8], 0.42],
  [2, [249, 115, 22], 0.55],
  [3, [220, 38, 38], 0.65],
  [4, [124, 58, 237], 0.75],
]

/** Precomputed 256-step lookup table: index = round(score / 4 * 255). */
export const RAMP_LUT: Uint8ClampedArray = (() => {
  const lut = new Uint8ClampedArray(256 * 4)
  for (let i = 0; i < 256; i++) {
    const s = (i / 255) * 4
    let k = 0
    while (k < RAMP.length - 2 && s > RAMP[k + 1][0]) k++
    const [s0, c0, a0] = RAMP[k]
    const [s1, c1, a1] = RAMP[k + 1]
    const t = Math.max(0, Math.min(1, (s - s0) / (s1 - s0)))
    lut[i * 4] = c0[0] + (c1[0] - c0[0]) * t
    lut[i * 4 + 1] = c0[1] + (c1[1] - c0[1]) * t
    lut[i * 4 + 2] = c0[2] + (c1[2] - c0[2]) * t
    lut[i * 4 + 3] = (a0 + (a1 - a0) * t) * 255
  }
  return lut
})()

export const rampCss = (() => {
  const stops = RAMP.map(([s, [r, g, b], a]) => `rgba(${r},${g},${b},${Math.max(a, 0.08)}) ${(s / 4) * 100}%`)
  return `linear-gradient(to right, ${stops.join(', ')})`
})()
