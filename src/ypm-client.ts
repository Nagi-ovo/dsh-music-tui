import { execFile, spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_TEXT_CODE_POINTS = 96
const MAX_COVER_URL_CODE_POINTS = 2048
const SPECTRUM_PROTOCOL_VERSION = 1
const SPECTRUM_BIN_COUNT = 32
const MAX_SPECTRUM_LINE_BYTES = 2048
const MAX_STREAM_STDERR_BYTES = 4096
const MAX_SPECTRUM_FPS = 20
const MAX_SPECTRUM_BURST_FRAMES = MAX_SPECTRUM_FPS * 2

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

export interface YpmSpectrumFrame {
  readonly version: 1
  readonly style: string
  readonly playing: boolean
  readonly bins: readonly number[]
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

export type YpmSpectrumRunner = (
  executable: string,
  argv: readonly string[],
  options: { readonly signal?: AbortSignal },
  onLine: (line: string) => void,
) => Promise<void>

export interface YpmClientOptions {
  readonly executable?: string
  readonly timeoutMs?: number
  readonly runner?: YpmProcessRunner
  readonly spectrumRunner?: YpmSpectrumRunner
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

/** Spawn one bounded NDJSON stream without a shell. */
export const spawnSpectrumRunner: YpmSpectrumRunner = (executable, argv, options, onLine) => {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new YpmError('aborted', 'ypm spectrum stream was cancelled'))
      return
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(executable, [...argv], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      reject(new YpmError('process', 'ypm spectrum stream failed', cleanExternalText(errorMessage(error), 160)))
      return
    }
    const childStdout = child.stdout
    const childStderr = child.stderr
    if (childStdout === null || childStderr === null) {
      child.kill()
      reject(new YpmError('process', 'ypm spectrum stream did not expose piped output'))
      return
    }

    let settled = false
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let forcedError: YpmError | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (killTimer !== undefined) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const finish = (error?: YpmError): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error === undefined) resolve()
      else reject(error)
    }
    const stopChild = (error: YpmError): void => {
      if (settled || forcedError !== undefined) return
      forcedError = error
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 250)
      killTimer.unref()
    }
    const onAbort = (): void => {
      stopChild(new YpmError('aborted', 'ypm spectrum stream was cancelled'))
    }
    const emitLines = (): void => {
      while (true) {
        const newline = stdout.indexOf(0x0a)
        if (newline < 0) break
        if (newline > MAX_SPECTRUM_LINE_BYTES) {
          stopChild(new YpmError('protocol', 'ypm returned an oversized spectrum frame'))
          return
        }
        const line = stdout.subarray(0, newline).toString('utf8').trim()
        stdout = stdout.subarray(newline + 1)
        if (line === '') continue
        try {
          onLine(line)
        } catch (error) {
          stopChild(error instanceof YpmError
            ? error
            : new YpmError('protocol', 'ypm returned an invalid spectrum frame'))
          return
        }
      }
      if (stdout.length > MAX_SPECTRUM_LINE_BYTES) {
        stopChild(new YpmError('protocol', 'ypm returned an oversized spectrum frame'))
      }
    }

    childStdout.on('data', (chunk: Buffer) => {
      if (settled || forcedError !== undefined) return
      stdout = Buffer.concat([stdout, chunk])
      emitLines()
    })
    childStderr.on('data', (chunk: Buffer) => {
      if (stderr.length >= MAX_STREAM_STDERR_BYTES) return
      stderr = Buffer.concat([
        stderr,
        chunk.subarray(0, MAX_STREAM_STDERR_BYTES - stderr.length),
      ])
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(forcedError ?? new YpmError(
        error.code === 'ENOENT' ? 'not-found' : 'process',
        error.code === 'ENOENT'
          ? `ypm executable was not found: ${executable}`
          : 'ypm spectrum stream failed',
        cleanExternalText(error.message, 160) || undefined,
      ))
    })
    child.once('close', (code) => {
      if (forcedError !== undefined) {
        finish(forcedError)
        return
      }
      if (code === 0) {
        if (stdout.length > 0) {
          stdout = Buffer.concat([stdout, Buffer.from('\n')])
          emitLines()
        }
        finish(forcedError)
        return
      }
      finish(new YpmError(
        'process',
        'ypm spectrum stream ended unexpectedly',
        cleanExternalText(stderr.toString('utf8'), 160) || undefined,
      ))
    })
    if (options.signal !== undefined) {
      options.signal.addEventListener('abort', onAbort, { once: true })
      if (options.signal.aborted) onAbort()
    }
  })
}

export class YpmClient {
  readonly executable: string
  readonly timeoutMs: number
  private readonly runner: YpmProcessRunner
  private readonly spectrumRunner: YpmSpectrumRunner

  constructor(options: YpmClientOptions = {}) {
    this.executable = options.executable?.trim() || 'ypm'
    this.timeoutMs = clampInteger(options.timeoutMs ?? 3000, 250, 30_000)
    this.runner = options.runner ?? execFileRunner
    this.spectrumRunner = options.spectrumRunner ?? spawnSpectrumRunner
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

  async watchSpectrum(
    onFrame: (frame: YpmSpectrumFrame) => void,
    signal?: AbortSignal,
    fps = 12,
  ): Promise<void> {
    if (!Number.isInteger(fps) || fps < 1 || fps > MAX_SPECTRUM_FPS) {
      throw new YpmError('protocol', `spectrum fps must be between 1 and ${MAX_SPECTRUM_FPS}`)
    }
    const streamController = new AbortController()
    const streamSignal = signal === undefined
      ? streamController.signal
      : AbortSignal.any([signal, streamController.signal])
    const frameIntervalMs = 1000 / fps
    let lastFrameAt = Number.NEGATIVE_INFINITY
    let pendingFrame: YpmSpectrumFrame | undefined
    let frameTimer: ReturnType<typeof setTimeout> | undefined
    let deliveryError: YpmError | undefined
    let rateTokens = MAX_SPECTRUM_BURST_FRAMES
    let rateCheckedAt = performance.now()

    const failDelivery = (error: unknown): YpmError => {
      const failure = error instanceof YpmError
        ? error
        : new YpmError('protocol', 'spectrum consumer rejected a frame')
      deliveryError = failure
      streamController.abort(failure)
      return failure
    }
    const deliver = (frame: YpmSpectrumFrame): void => {
      lastFrameAt = performance.now()
      try {
        onFrame(frame)
      } catch (error) {
        throw failDelivery(error)
      }
    }
    const flushPending = (): void => {
      frameTimer = undefined
      if (pendingFrame === undefined || streamSignal.aborted) return
      const remaining = frameIntervalMs - (performance.now() - lastFrameAt)
      if (remaining > 0) {
        frameTimer = setTimeout(flushPending, Math.ceil(remaining))
        return
      }
      const frame = pendingFrame
      pendingFrame = undefined
      try {
        deliver(frame)
      } catch {
        // `deliver` aborts the stream; the awaited runner carries the failure.
      }
    }
    const queue = (frame: YpmSpectrumFrame): void => {
      const now = performance.now()
      if (frameTimer === undefined && now - lastFrameAt >= frameIntervalMs) {
        deliver(frame)
        return
      }
      pendingFrame = frame
      if (frameTimer !== undefined) return
      const remaining = Math.max(0, frameIntervalMs - (now - lastFrameAt))
      frameTimer = setTimeout(flushPending, Math.ceil(remaining))
    }
    const acceptLine = (line: string): void => {
      const now = performance.now()
      const elapsed = Math.max(0, now - rateCheckedAt)
      rateCheckedAt = now
      rateTokens = Math.min(
        MAX_SPECTRUM_BURST_FRAMES,
        rateTokens + elapsed * MAX_SPECTRUM_FPS / 1000,
      )
      if (rateTokens < 1) {
        throw new YpmError('protocol', 'ypm spectrum stream exceeded the supported frame rate')
      }
      rateTokens -= 1
      queue(parseSpectrumFrame(line))
    }

    try {
      await this.spectrumRunner(
        this.executable,
        ['--json', '--tui', 'spectrum', '--fps', String(fps)],
        { signal: streamSignal },
        acceptLine,
      )
      if (deliveryError !== undefined) throw deliveryError
    } catch (error) {
      if (deliveryError !== undefined) throw deliveryError
      throw error
    } finally {
      if (frameTimer !== undefined) clearTimeout(frameTimer)
      pendingFrame = undefined
    }
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

export function parseSpectrumFrame(source: string): YpmSpectrumFrame {
  const value = parseObject(source)
  if (value.version !== SPECTRUM_PROTOCOL_VERSION
    || typeof value.style !== 'string'
    || !/^[a-z][a-z0-9-]{0,23}$/u.test(value.style)
    || typeof value.playing !== 'boolean'
    || !Array.isArray(value.bins)
    || value.bins.length !== SPECTRUM_BIN_COUNT
    || !value.bins.every(spectrumBin)) {
    throw new YpmError('protocol', 'ypm returned an invalid spectrum frame')
  }
  return Object.freeze({
    version: 1,
    style: value.style,
    playing: value.playing,
    bins: Object.freeze([...value.bins]),
  })
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

function spectrumBin(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0 && value <= 255
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
