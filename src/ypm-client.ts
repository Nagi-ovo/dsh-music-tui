import { execFile } from 'node:child_process'

const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_TEXT_CODE_POINTS = 96
const MAX_COVER_URL_CODE_POINTS = 2048

export type YpmControlCommand = 'toggle' | 'next' | 'prev'
export type YpmSource = 'tui'
export type YpmIconStyle = 'unicode' | 'nerd'

export interface YpmSnapshot {
  readonly playing: boolean
  readonly title: string | null
  readonly artist: string | null
  readonly album: string | null
  readonly positionMs: number
  readonly durationMs: number | null
  /** Optional public artwork URL added by newer YPM builds. */
  readonly coverUrl: string | null
  /** Whether this YPM build and current track accept absolute seeks. */
  readonly seekable: boolean
  /** Glyph palette selected by the running YPM TUI. */
  readonly iconStyle: YpmIconStyle
  readonly source: YpmSource
}

export interface YpmAck {
  readonly ok: true
  readonly source: YpmSource
}

export type YpmErrorKind = 'not-found' | 'timeout' | 'process' | 'protocol' | 'aborted'

export class YpmError extends Error {
  constructor(
    readonly kind: YpmErrorKind,
    message: string,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'YpmError'
  }
}

export interface YpmProcessResult {
  readonly stdout: string
  readonly stderr: string
}

export interface YpmRunOptions {
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export type YpmProcessRunner = (
  executable: string,
  argv: readonly string[],
  options: YpmRunOptions,
) => Promise<YpmProcessResult>

export interface YpmClientOptions {
  readonly executable?: string
  readonly timeoutMs?: number
  readonly runner?: YpmProcessRunner
}

/** Invoke the public ypm CLI with no shell and a bounded output buffer. */
export const execFileRunner: YpmProcessRunner = (executable, argv, options) => {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new YpmError('aborted', 'ypm request was cancelled'))
      return
    }

    const controller = new AbortController()
    let timedOut = false
    const onAbort = (): void => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, options.timeoutMs)
    timeout.unref()
    const cleanup = (): void => {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
    }

    try {
      execFile(executable, [...argv], {
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        signal: controller.signal,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        cleanup()
        if (error === null) {
          resolve({ stdout, stderr })
          return
        }

        const code = 'code' in error ? error.code : undefined
        if (options.signal?.aborted) {
          reject(new YpmError('aborted', 'ypm request was cancelled'))
        } else if (timedOut) {
          reject(new YpmError('timeout', `ypm did not respond within ${options.timeoutMs} ms`))
        } else if (code === 'ENOENT') {
          reject(new YpmError('not-found', `ypm executable was not found: ${executable}`))
        } else {
          const detail = cleanExternalText(stderr, 160)
          reject(new YpmError('process', 'ypm exited without completing the request', detail || undefined))
        }
      })
    } catch (error) {
      cleanup()
      reject(new YpmError(
        'process',
        'ypm request failed',
        cleanExternalText(errorMessage(error), 160) || undefined,
      ))
    }
  })
}

export class YpmClient {
  readonly executable: string
  readonly timeoutMs: number
  private readonly runner: YpmProcessRunner

  constructor(options: YpmClientOptions = {}) {
    this.executable = options.executable?.trim() || 'ypm'
    this.timeoutMs = clampInteger(options.timeoutMs ?? 3000, 250, 30_000)
    this.runner = options.runner ?? execFileRunner
  }

  async status(signal?: AbortSignal): Promise<YpmSnapshot> {
    const output = await this.run('status', [], signal)
    return parseSnapshot(output)
  }

  async control(command: YpmControlCommand, signal?: AbortSignal): Promise<YpmAck> {
    const output = await this.run(command, [], signal)
    return parseAck(output)
  }

  async seek(positionMs: number, signal?: AbortSignal): Promise<YpmAck> {
    if (!nonNegativeInteger(positionMs)) {
      throw new YpmError('protocol', 'seek position must be a non-negative integer in milliseconds')
    }
    const output = await this.run('seek', [formatSeekSeconds(positionMs)], signal)
    return parseAck(output)
  }

  private async run(
    command: 'status' | 'seek' | YpmControlCommand,
    args: readonly string[] = [],
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const result = await this.runner(
        this.executable,
        ['--json', '--tui', command, ...args],
        { timeoutMs: this.timeoutMs, ...(signal === undefined ? {} : { signal }) },
      )
      return result.stdout
    } catch (error) {
      if (error instanceof YpmError) throw error
      if (signal?.aborted) throw new YpmError('aborted', 'ypm request was cancelled')
      throw new YpmError('process', 'ypm request failed', cleanExternalText(errorMessage(error), 160) || undefined)
    }
  }
}

export function parseSnapshot(source: string): YpmSnapshot {
  const value = parseObject(source)
  if (typeof value.playing !== 'boolean'
    || !nullableString(value.title)
    || !nullableString(value.artist)
    || !nullableString(value.album)
    || !nonNegativeInteger(value.positionMs)
    || !(value.durationMs === null || nonNegativeInteger(value.durationMs))
    || !optionalNullableString(value.coverUrl)
    || !optionalBoolean(value.seekable)
    || !optionalIconStyle(value.iconStyle)
    || value.source !== 'tui') {
    throw new YpmError('protocol', 'ypm returned an invalid status response')
  }
  return Object.freeze({
    playing: value.playing,
    title: value.title === null ? null : cleanExternalText(value.title, MAX_TEXT_CODE_POINTS) || null,
    artist: value.artist === null ? null : cleanExternalText(value.artist, MAX_TEXT_CODE_POINTS) || null,
    album: value.album === null ? null : cleanExternalText(value.album, MAX_TEXT_CODE_POINTS) || null,
    positionMs: value.positionMs,
    durationMs: value.durationMs,
    coverUrl: value.coverUrl === undefined || value.coverUrl === null
      ? null
      : cleanExternalText(value.coverUrl, MAX_COVER_URL_CODE_POINTS) || null,
    seekable: value.seekable ?? false,
    iconStyle: value.iconStyle ?? 'unicode',
    source: 'tui',
  })
}

export function parseAck(source: string): YpmAck {
  const value = parseObject(source)
  if (value.ok !== true || value.source !== 'tui') {
    throw new YpmError('protocol', 'ypm returned an invalid control response')
  }
  return Object.freeze({ ok: true, source: 'tui' })
}

export function playbackLine(snapshot: YpmSnapshot): string | undefined {
  const metadata = [snapshot.title, snapshot.artist].filter((value): value is string => Boolean(value))
  if (metadata.length === 0) return undefined
  return `${snapshot.playing ? '▶' : '⏸'} ${metadata.join(' · ')}`
}

export function cleanExternalText(value: string, maxCodePoints = MAX_TEXT_CODE_POINTS): string {
  const withoutOsc = value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
  const withoutCsi = withoutOsc.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
  const scalar = withoutCsi
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return [...scalar].slice(0, Math.max(0, maxCodePoints)).join('')
}

export function describeYpmError(error: unknown): string {
  if (!(error instanceof YpmError)) return 'Music control failed'
  switch (error.kind) {
    case 'not-found':
      return 'ypm was not found; install the YesPlayMusic CLI or configure executable'
    case 'timeout':
      return error.message
    case 'process':
      return error.detail || 'YesPlayMusic TUI is not running'
    case 'protocol':
      return error.message
    case 'aborted':
      return 'Music request was cancelled'
  }
}

function parseObject(source: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new YpmError('protocol', 'ypm returned malformed JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new YpmError('protocol', 'ypm returned an invalid JSON value')
  }
  return value as Record<string, unknown>
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function optionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || nullableString(value)
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean'
}

function optionalIconStyle(value: unknown): value is YpmIconStyle | undefined {
  return value === undefined || value === 'unicode' || value === 'nerd'
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function formatSeekSeconds(positionMs: number): string {
  const seconds = Math.floor(positionMs / 1000)
  const milliseconds = positionMs % 1000
  if (milliseconds === 0) return String(seconds)
  return `${seconds}.${String(milliseconds).padStart(3, '0').replace(/0+$/u, '')}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
