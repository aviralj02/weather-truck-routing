import { RAMP_LUT, scoreFor } from './risk'
import type { Heatmap, HeatmapMetric } from './types'

/**
 * Renders the corridor forecast as a smooth raster.
 *
 * The server samples weather on a regular lon/lat lattice clipped to the trip
 * corridor. We upsample that lattice with bilinear interpolation (in value space,
 * before coloring) into a small image that deck.gl drapes over the map as an
 * equirectangular bitmap. Interpolation weights are computed once per plan; each
 * frame only blends ~450 node values and recolors the pixels, so scrubbing the
 * forecast slider stays well under a millisecond per frame.
 */
export interface HeatmapRaster {
  width: number
  height: number
  bounds: [number, number, number, number] // west, south, east, north
  render: (metric: HeatmapMetric, hour: number) => ImageData
  /** Interpolated value of `metric` at a lattice node nearest to lon/lat, or null outside the corridor. */
  sample: (metric: HeatmapMetric, hour: number, lon: number, lat: number) => number | null
}

const MAX_WIDTH = 480

export function createHeatmapRaster(heatmap: Heatmap): HeatmapRaster {
  const { rows, cols, lon0, lat0, dlon, dlat } = heatmap.lattice
  const nodeCount = rows * cols
  const k = Math.max(2, Math.min(10, Math.floor(MAX_WIDTH / Math.max(1, cols - 1))))
  const width = (cols - 1) * k + 1
  const height = (rows - 1) * k + 1

  // node index -> point index (or -1 outside the corridor)
  const nodeToPoint = new Int32Array(nodeCount).fill(-1)
  heatmap.cells.forEach(([r, c], i) => {
    nodeToPoint[r * cols + c] = i
  })

  // Per pixel: the 4 surrounding nodes and their bilinear weights.
  const px = width * height
  const n00 = new Int32Array(px)
  const w = new Float32Array(px * 4)
  for (let y = 0; y < height; y++) {
    const gr = (height - 1 - y) / k // image row 0 is the northern edge
    const r0 = Math.min(rows - 2, Math.floor(gr))
    const ty = rows > 1 ? gr - r0 : 0
    for (let x = 0; x < width; x++) {
      const gc = x / k
      const c0 = Math.min(cols - 2, Math.floor(gc))
      const tx = cols > 1 ? gc - c0 : 0
      const p = y * width + x
      n00[p] = Math.max(0, r0) * cols + Math.max(0, c0)
      w[p * 4] = (1 - tx) * (1 - ty)
      w[p * 4 + 1] = tx * (1 - ty)
      w[p * 4 + 2] = (1 - tx) * ty
      w[p * 4 + 3] = tx * ty
    }
  }

  const nodeScore = new Float32Array(nodeCount)
  const lastHour = heatmap.hours - 1

  function valueAt(metric: HeatmapMetric, pointIdx: number, hour: number): number {
    const series = heatmap[metric][pointIdx]
    const h = Math.max(0, Math.min(lastHour, hour))
    const h0 = Math.floor(h)
    const h1 = Math.min(lastHour, h0 + 1)
    return series[h0] + (series[h1] - series[h0]) * (h - h0)
  }

  function render(metric: HeatmapMetric, hour: number): ImageData {
    for (let n = 0; n < nodeCount; n++) {
      const p = nodeToPoint[n]
      nodeScore[n] = p < 0 ? -1 : scoreFor(metric, valueAt(metric, p, hour))
    }
    const image = new ImageData(width, height)
    const data = image.data
    const right = cols > 1 ? 1 : 0
    const up = rows > 1 ? cols : 0
    const offsets = [0, right, up, up + right]
    for (let p = 0; p < px; p++) {
      const base = n00[p]
      let sum = 0
      let weight = 0
      for (let i = 0; i < 4; i++) {
        const s = nodeScore[base + offsets[i]]
        if (s >= 0) {
          const wi = w[p * 4 + i]
          sum += s * wi
          weight += wi
        }
      }
      if (weight <= 0.001) continue
      const lut = Math.round((sum / weight / 4) * 255) * 4
      const o = p * 4
      data[o] = RAMP_LUT[lut]
      data[o + 1] = RAMP_LUT[lut + 1]
      data[o + 2] = RAMP_LUT[lut + 2]
      // Fade toward the corridor edge where some neighbours are missing.
      data[o + 3] = RAMP_LUT[lut + 3] * Math.min(1, weight * 1.25)
    }
    return image
  }

  function sample(metric: HeatmapMetric, hour: number, lon: number, lat: number): number | null {
    const c = Math.round((lon - lon0) / dlon)
    const r = Math.round((lat - lat0) / dlat)
    if (r < 0 || r >= rows || c < 0 || c >= cols) return null
    const p = nodeToPoint[r * cols + c]
    return p < 0 ? null : valueAt(metric, p, hour)
  }

  const halfX = dlon / (2 * k)
  const halfY = dlat / (2 * k)
  return {
    width,
    height,
    bounds: [lon0 - halfX, lat0 - halfY, lon0 + (cols - 1) * dlon + halfX, lat0 + (rows - 1) * dlat + halfY],
    render,
    sample,
  }
}
