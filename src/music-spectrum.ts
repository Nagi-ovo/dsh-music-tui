import type { YpmSpectrumFrame } from './ypm-client.js'

export type MusicSpectrumStyle = 'off' | 'follow' | 'blocks' | 'led' | 'braille' | 'shade'
export type RenderedSpectrumStyle = Exclude<MusicSpectrumStyle, 'off' | 'follow'>

const SUPPORTED_STYLES = new Set<RenderedSpectrumStyle>([
  'blocks',
  'led',
  'braille',
  'shade',
])
const EIGHTHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
const SHADES = [' ', '░', '▒', '▓', '█'] as const
const BRAILLE_LEFT = [0x01, 0x02, 0x04, 0x40] as const
const BRAILLE_RIGHT = [0x08, 0x10, 0x20, 0x80] as const
const WIDE_BASE_COLUMNS = 120
const WIDE_BASE_CELLS = 24
const MAX_SPECTRUM_CELLS = 48

export function spectrumCells(columns: number): number {
  if (columns >= WIDE_BASE_COLUMNS) {
    return Math.min(
      MAX_SPECTRUM_CELLS,
      WIDE_BASE_CELLS + Math.floor((columns - WIDE_BASE_COLUMNS) / 2),
    )
  }
  if (columns >= 96) return 18
  if (columns >= 80) return 12
  return 0
}

export function resolveSpectrumStyle(
  preference: MusicSpectrumStyle,
  ypmStyle: string,
): RenderedSpectrumStyle | undefined {
  if (preference === 'off') return undefined
  if (preference !== 'follow') return preference
  return SUPPORTED_STYLES.has(ypmStyle as RenderedSpectrumStyle)
    ? ypmStyle as RenderedSpectrumStyle
    : 'blocks'
}

export function renderSpectrum(
  frame: YpmSpectrumFrame,
  style: RenderedSpectrumStyle,
  cells: number,
  rows = 3,
): readonly string[] {
  if (cells <= 0 || rows <= 0) return []
  if (style === 'braille') return renderBraille(frame.bins, cells, rows)
  const levels = resampleBins(frame.bins, cells)
  return Array.from({ length: rows }, (_, row) => levels
    .map(value => spectrumGlyph(style, value, row, rows))
    .join(''))
}

export function resampleBins(bins: readonly number[], cells: number): readonly number[] {
  if (cells <= 0 || bins.length === 0) return []
  return Array.from({ length: cells }, (_, index) => {
    const start = Math.floor(index * bins.length / cells)
    const end = Math.max(start + 1, Math.floor((index + 1) * bins.length / cells))
    let peak = 0
    for (let source = start; source < Math.min(end, bins.length); source += 1) {
      peak = Math.max(peak, bins[source] ?? 0)
    }
    return peak / 255
  })
}

function spectrumGlyph(
  style: Exclude<RenderedSpectrumStyle, 'braille'>,
  value: number,
  row: number,
  rows: number,
): string {
  const fromBottom = rows - 1 - row
  if (style === 'blocks') {
    const local = Math.round(value * rows * 8) - fromBottom * 8
    return EIGHTHS[Math.max(0, Math.min(8, local))]!
  }
  if (style === 'led') {
    const filled = Math.ceil(value * rows)
    return filled > fromBottom ? '●' : ' '
  }
  const local = value * rows - fromBottom
  const shade = Math.max(0, Math.min(4, Math.ceil(local * 4)))
  return SHADES[shade]!
}

function renderBraille(
  bins: readonly number[],
  cells: number,
  rows: number,
): readonly string[] {
  const levels = resampleBins(bins, cells * 2)
    .map(value => Math.round(value * rows * 4))
  return Array.from({ length: rows }, (_, row) => {
    let line = ''
    for (let column = 0; column < cells; column += 1) {
      const left = levels[column * 2] ?? 0
      const right = levels[column * 2 + 1] ?? 0
      let dots = 0
      for (let dot = 0; dot < 4; dot += 1) {
        const global = row * 4 + dot
        if (global >= rows * 4 - left) dots |= BRAILLE_LEFT[dot]!
        if (global >= rows * 4 - right) dots |= BRAILLE_RIGHT[dot]!
      }
      line += dots === 0 ? ' ' : String.fromCodePoint(0x2800 + dots)
    }
    return line
  })
}
