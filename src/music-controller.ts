import { performance } from 'node:perf_hooks'
import {
  YpmClient,
  type YpmAck,
  type YpmControlCommand,
  type YpmSnapshot,
  type YpmSpectrumFrame,
} from './ypm-client.js'

const OFFLINE_BACKOFF_MS = [5000, 10_000] as const
const SPECTRUM_RECONNECT_MS = [1000, 5000, 15_000, 30_000] as const
const SPECTRUM_HEALTHY_FRAME_COUNT = 24
const SPECTRUM_HEALTHY_STREAM_MS = 2000

export interface MusicControlResult {
  readonly ack: YpmAck
  readonly snapshot?: YpmSnapshot
}

export type MusicStatusSink = (snapshot: YpmSnapshot | undefined) => void
export type MusicSpectrumSink = (frame: YpmSpectrumFrame | undefined) => void

/** Serialize player operations and own the non-overlapping status poll loop. */
export class MusicController {
  private readonly lifecycle = new AbortController()
  private operationTail: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private activePoll: AbortController | undefined
  private spectrumStream: AbortController | undefined
  private generation = 0
  private failureCount = 0
  private sink: MusicStatusSink | undefined
  private disposed = false

  constructor(
    readonly client: YpmClient,
    readonly pollIntervalMs = 3000,
  ) {}

  startPolling(sink: MusicStatusSink): () => void {
    if (this.disposed) return () => {}
    this.sink = sink
    this.failureCount = 0
    this.restartPolling(0)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.sink === sink) {
        this.sink = undefined
        this.cancelPoll()
      }
    }
  }

  startSpectrum(sink: MusicSpectrumSink): () => void {
    if (this.disposed) return () => {}
    this.spectrumStream?.abort()
    const controller = new AbortController()
    this.spectrumStream = controller
    const signal = AbortSignal.any([this.lifecycle.signal, controller.signal])
    void this.runSpectrum(sink, controller, signal).finally(() => {
      if (this.spectrumStream === controller) this.spectrumStream = undefined
    })
    let active = true
    return () => {
      if (!active) return
      active = false
      controller.abort()
      if (this.spectrumStream === controller) this.spectrumStream = undefined
    }
  }

  private async runSpectrum(
    sink: MusicSpectrumSink,
    controller: AbortController,
    signal: AbortSignal,
  ): Promise<void> {
    let failureCount = 0
    while (!signal.aborted && !this.disposed) {
      const startedAt = performance.now()
      let receivedFrames = 0
      let healthy = false
      try {
        await this.client.watchSpectrum(frame => {
          if (controller.signal.aborted || this.disposed) return
          receivedFrames += 1
          if (!healthy
            && receivedFrames >= SPECTRUM_HEALTHY_FRAME_COUNT
            && performance.now() - startedAt >= SPECTRUM_HEALTHY_STREAM_MS) {
            healthy = true
            failureCount = 0
          }
          sink(frame)
        }, signal)
      } catch {
        // Missing, old, and restarted players all recover at this process boundary.
      }
      if (signal.aborted || this.disposed) return
      sink(undefined)
      const delay = SPECTRUM_RECONNECT_MS[
        Math.min(failureCount, SPECTRUM_RECONNECT_MS.length - 1)
      ]!
      failureCount += 1
      await abortableDelay(delay, signal)
    }
  }

  async status(signal?: AbortSignal): Promise<YpmSnapshot> {
    const token = this.beginForegroundOperation()
    try {
      const snapshot = await this.enqueue(() => this.client.status(combineSignals(this.lifecycle.signal, signal)))
      if (this.isCurrent(token)) {
        this.failureCount = 0
        this.sink?.(snapshot)
      }
      return snapshot
    } catch (error) {
      if (this.isCurrent(token)) this.noteFailure()
      throw error
    } finally {
      if (this.isCurrent(token)) this.scheduleNext(this.pollIntervalMs)
    }
  }

  async control(command: YpmControlCommand, signal?: AbortSignal): Promise<MusicControlResult> {
    return this.mutate(operationSignal => this.client.control(command, operationSignal), signal)
  }

  async seek(positionMs: number, signal?: AbortSignal): Promise<MusicControlResult> {
    return this.mutate(operationSignal => this.client.seek(positionMs, operationSignal), signal)
  }

  private async mutate(
    operation: (signal: AbortSignal) => Promise<YpmAck>,
    signal?: AbortSignal,
  ): Promise<MusicControlResult> {
    const token = this.beginForegroundOperation()
    let refreshFailed = false
    try {
      const result = await this.enqueue(async () => {
        const operationSignal = combineSignals(this.lifecycle.signal, signal)
        const ack = await operation(operationSignal)
        try {
          const snapshot = await this.client.status(operationSignal)
          return { ack, snapshot } satisfies MusicControlResult
        } catch {
          refreshFailed = true
          return { ack } satisfies MusicControlResult
        }
      })
      if (this.isCurrent(token)) {
        if (result.snapshot !== undefined) {
          this.failureCount = 0
          this.sink?.(result.snapshot)
        } else if (refreshFailed) {
          this.noteFailure()
        }
      }
      return result
    } catch (error) {
      throw error
    } finally {
      if (this.isCurrent(token)) this.scheduleNext(this.pollIntervalMs)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.cancelTimer()
    this.activePoll?.abort()
    this.activePoll = undefined
    this.spectrumStream?.abort()
    this.spectrumStream = undefined
    this.lifecycle.abort()
    this.sink = undefined
  }

  private beginForegroundOperation(): number {
    this.generation += 1
    this.cancelTimer()
    this.activePoll?.abort()
    this.activePoll = undefined
    return this.generation
  }

  private restartPolling(delayMs: number): void {
    this.generation += 1
    this.cancelTimer()
    this.activePoll?.abort()
    this.activePoll = undefined
    this.scheduleNext(delayMs)
  }

  private scheduleNext(delayMs: number): void {
    if (this.disposed || this.sink === undefined || this.timer !== undefined) return
    const token = this.generation
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.poll(token)
    }, Math.max(0, delayMs))
    this.timer.unref()
  }

  private async poll(token: number): Promise<void> {
    if (!this.isCurrent(token) || this.sink === undefined) return
    const controller = new AbortController()
    this.activePoll = controller
    try {
      const snapshot = await this.enqueue(() => this.client.status(
        combineSignals(this.lifecycle.signal, controller.signal),
      ))
      if (!this.isCurrent(token)) return
      this.failureCount = 0
      this.sink?.(snapshot)
      this.scheduleNext(this.pollIntervalMs)
    } catch {
      if (!this.isCurrent(token) || controller.signal.aborted) return
      this.noteFailure()
      this.scheduleNext(this.failureDelay())
    } finally {
      if (this.activePoll === controller) this.activePoll = undefined
    }
  }

  private noteFailure(): void {
    this.failureCount += 1
    if (this.failureCount >= 2) this.sink?.(undefined)
  }

  private failureDelay(): number {
    if (this.failureCount <= 1) return this.pollIntervalMs
    const backoff = OFFLINE_BACKOFF_MS[Math.min(this.failureCount - 2, OFFLINE_BACKOFF_MS.length - 1)]!
    return Math.max(this.pollIntervalMs, backoff)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private isCurrent(token: number): boolean {
    return !this.disposed && token === this.generation
  }

  private cancelPoll(): void {
    this.generation += 1
    this.cancelTimer()
    this.activePoll?.abort()
    this.activePoll = undefined
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }
}

function combineSignals(first: AbortSignal, second?: AbortSignal): AbortSignal {
  return second === undefined ? first : AbortSignal.any([first, second])
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(finish, delayMs)
    const onAbort = (): void => finish()
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) finish()
  })
}
