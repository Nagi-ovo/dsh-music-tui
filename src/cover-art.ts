import { decode as decodeJpeg } from 'jpeg-js'

const COVER_COLUMNS = 6
const COVER_PIXEL_ROWS = 6
const COVER_IMAGE_EDGE = 96
const DOWNLOAD_TIMEOUT_MS = 2000
const MAX_DOWNLOAD_BYTES = 256 * 1024
const MAX_REDIRECTS = 3
const MAX_CACHE_ENTRIES = 16
const JPEG_CONTENT_TYPES = new Set(['image/jpeg', 'image/jpg'])

export interface CoverCell {
  readonly top: string
  readonly bottom: string
}

/** A six-column square thumbnail rendered with three rows of half blocks. */
export interface TerminalCover {
  /** Higher-resolution square used by a graphics-capable host. */
  readonly image: {
    readonly data: Uint8Array
    readonly width: number
    readonly height: number
  }
  readonly rows: readonly (readonly CoverCell[])[]
}

type Fetcher = typeof fetch
type Decoder = typeof decodeJpeg

export interface CoverArtLoaderOptions {
  readonly fetcher?: Fetcher
  readonly decoder?: Decoder
}

/** Fetch, validate, decode, and retain a bounded set of tiny cover thumbnails. */
export class CoverArtLoader {
  private readonly cache = new Map<string, TerminalCover>()
  private readonly fetcher: Fetcher
  private readonly decoder: Decoder

  constructor(options: CoverArtLoaderOptions = {}) {
    this.fetcher = options.fetcher ?? fetch
    this.decoder = options.decoder ?? decodeJpeg
  }

  async load(source: string, signal?: AbortSignal): Promise<TerminalCover | undefined> {
    const initial = allowedCoverUrl(source)
    if (initial === undefined) return undefined
    const key = initial.href
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached
    }

    try {
      const bytes = await downloadCover(initial, this.fetcher, signal)
      if (bytes === undefined) return undefined
      const decoded = this.decoder(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        tolerantDecoding: false,
        maxResolutionInMP: 4,
        maxMemoryUsageInMB: 32,
      })
      const cover = thumbnail(decoded)
      if (cover === undefined) return undefined
      this.cache.set(key, cover)
      while (this.cache.size > MAX_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.cache.delete(oldest)
      }
      return cover
    } catch {
      return undefined
    }
  }
}

/** Accept only HTTPS NetEase cover CDN hosts, with no credentials or custom port. */
export function allowedCoverUrl(source: string): URL | undefined {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    return undefined
  }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || !(host === 'music.126.net' || host.endsWith('.music.126.net'))) {
    return undefined
  }
  return url
}

async function downloadCover(
  initial: URL,
  fetcher: Fetcher,
  callerSignal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  const signal = callerSignal === undefined
    ? timeout
    : AbortSignal.any([callerSignal, timeout])
  let url = initial

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { accept: 'image/jpeg' },
    })
    if (isRedirect(response.status)) {
      await response.body?.cancel()
      if (redirects === MAX_REDIRECTS) return undefined
      const location = response.headers.get('location')
      if (location === null) return undefined
      const next = allowedCoverUrl(new URL(location, url).href)
      if (next === undefined) return undefined
      url = next
      continue
    }
    if (response.status !== 200 || response.body === null) return undefined
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType === undefined || !JPEG_CONTENT_TYPES.has(contentType)) return undefined
    const declared = response.headers.get('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_DOWNLOAD_BYTES) return undefined
    }
    return readBounded(response, MAX_DOWNLOAD_BYTES)
  }
  return undefined
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array | undefined> {
  const reader = response.body?.getReader()
  if (reader === undefined) return undefined
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const item = await reader.read()
    if (item.done) break
    length += item.value.byteLength
    if (length > limit) {
      await reader.cancel()
      return undefined
    }
    chunks.push(item.value)
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function thumbnail(decoded: {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}): TerminalCover | undefined {
  const { width, height, data } = decoded
  if (!Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
    || data.byteLength < width * height * 4) {
    return undefined
  }
  const side = Math.min(width, height)
  const left = Math.floor((width - side) / 2)
  const top = Math.floor((height - side) / 2)
  const image = resizeSquare(data, width, left, top, side)
  const pixels: string[][] = []
  for (let row = 0; row < COVER_PIXEL_ROWS; row += 1) {
    const sourceY = Math.min(
      image.height - 1,
      Math.floor(((row + 0.5) * image.height) / COVER_PIXEL_ROWS),
    )
    const colors: string[] = []
    for (let column = 0; column < COVER_COLUMNS; column += 1) {
      const sourceX = Math.min(
        image.width - 1,
        Math.floor(((column + 0.5) * image.width) / COVER_COLUMNS),
      )
      const offset = (sourceY * image.width + sourceX) * 4
      colors.push(rgb(
        image.data[offset] ?? 0,
        image.data[offset + 1] ?? 0,
        image.data[offset + 2] ?? 0,
      ))
    }
    pixels.push(colors)
  }
  const rows: CoverCell[][] = []
  for (let row = 0; row < COVER_PIXEL_ROWS; row += 2) {
    const topPixels = pixels[row]
    const bottomPixels = pixels[row + 1]
    if (topPixels === undefined || bottomPixels === undefined) return undefined
    rows.push(topPixels.map((color, column) => Object.freeze({
      top: color,
      bottom: bottomPixels[column] ?? color,
    })))
  }
  return Object.freeze({
    image: Object.freeze(image),
    rows: Object.freeze(rows.map(row => Object.freeze(row))),
  })
}

function resizeSquare(
  source: Uint8Array,
  sourceWidth: number,
  left: number,
  top: number,
  side: number,
): TerminalCover['image'] {
  const data = new Uint8Array(COVER_IMAGE_EDGE * COVER_IMAGE_EDGE * 4)
  for (let y = 0; y < COVER_IMAGE_EDGE; y += 1) {
    const sourceY = top + ((y + 0.5) * side) / COVER_IMAGE_EDGE - 0.5
    const y0 = clamp(Math.floor(sourceY), top, top + side - 1)
    const y1 = clamp(y0 + 1, top, top + side - 1)
    const yMix = Math.max(0, Math.min(1, sourceY - Math.floor(sourceY)))
    for (let x = 0; x < COVER_IMAGE_EDGE; x += 1) {
      const sourceX = left + ((x + 0.5) * side) / COVER_IMAGE_EDGE - 0.5
      const x0 = clamp(Math.floor(sourceX), left, left + side - 1)
      const x1 = clamp(x0 + 1, left, left + side - 1)
      const xMix = Math.max(0, Math.min(1, sourceX - Math.floor(sourceX)))
      const target = (y * COVER_IMAGE_EDGE + x) * 4
      for (let channel = 0; channel < 4; channel += 1) {
        const topLeft = source[(y0 * sourceWidth + x0) * 4 + channel] ?? 0
        const topRight = source[(y0 * sourceWidth + x1) * 4 + channel] ?? 0
        const bottomLeft = source[(y1 * sourceWidth + x0) * 4 + channel] ?? 0
        const bottomRight = source[(y1 * sourceWidth + x1) * 4 + channel] ?? 0
        const upper = topLeft + (topRight - topLeft) * xMix
        const lower = bottomLeft + (bottomRight - bottomLeft) * xMix
        data[target + channel] = Math.round(upper + (lower - upper) * yMix)
      }
    }
  }
  return { data, width: COVER_IMAGE_EDGE, height: COVER_IMAGE_EDGE }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function rgb(red: number, green: number, blue: number): string {
  return `#${hex(red)}${hex(green)}${hex(blue)}`
}

function hex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}
