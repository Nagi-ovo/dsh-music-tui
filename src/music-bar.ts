import type { Context } from '@deepseek-ai/cordis'
import { CoverArtLoader, type TerminalCover } from './cover-art.js'
import type { MusicControlResult, MusicController } from './music-controller.js'
import {
  renderSpectrum,
  resolveSpectrumStyle,
  spectrumCells,
  type MusicSpectrumStyle,
} from './music-spectrum.js'
import {
  describeYpmError,
  type YpmControlCommand,
  type YpmSnapshot,
  type YpmSpectrumFrame,
} from './ypm-client.js'

const STATUS_KEY = 'dsh-music-tui:playback'
const LOCAL_TICK_MS = 1000
const CONTROL_ERROR_MS = 4000
const PLAYBACK_STALL_MS = 6000
const CONTROL_WIDTH = 3
const PLAYER_OFFLINE_WARNING = 'YesPlayMusic TUI is not running'
const PLAYBACK_STALLED_WARNING = 'YPM playback is not advancing; restart the player'
const SPECTRUM_ROW_COLORS = [
  'rainbow_blue_shimmer',
  'rainbow_blue',
  'claude',
] as const

type MusicPendingOperation = YpmControlCommand | 'seek'
type MusicHoverTarget = YpmControlCommand | 'seek' | 'close'

interface StatusViewPointerEvent {
  readonly localCol: number
}

interface PlaybackProbe {
  readonly trackKey: string
  readonly positionMs: number
  readonly progressedAtMs: number
}

export interface MusicBarLayout {
  readonly showCover: boolean
  readonly showAlbum: boolean
  readonly showProgress: boolean
  readonly progressCells: number
  readonly spectrumCells: number
}

export interface MusicBarState {
  readonly snapshot: YpmSnapshot | undefined
  readonly observedAtMs: number
  readonly renderedAtMs: number
  readonly cover: TerminalCover | undefined
  readonly spectrum: YpmSpectrumFrame | undefined
  readonly pending: MusicPendingOperation | undefined
  readonly previewPositionMs: number | undefined
  readonly error: string | undefined
  readonly healthWarning: string | undefined
}

export interface MusicDisplay {
  show(signal?: AbortSignal): Promise<MusicDisplayShowResult>
  hide(): void
  control(command: YpmControlCommand, signal?: AbortSignal): Promise<MusicControlResult>
  seek(positionMs: number, signal?: AbortSignal): Promise<MusicControlResult>
}

export interface MusicDisplayShowResult {
  readonly snapshot: YpmSnapshot
  readonly displayed: boolean
}

interface StatusViewReact {
  createElement(type: unknown, props: Readonly<Record<string, unknown>> | null, ...children: unknown[]): unknown
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void
  useSyncExternalStore<T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
  ): T
  useState<T>(initial: T): readonly [T, (value: T) => void]
}

interface StatusViewUi {
  readonly Box: unknown
  readonly Image?: unknown
  readonly Text: unknown
  useTerminalSize(): { readonly columns: number; readonly rows: number }
}

interface StatusViewProps {
  readonly React: StatusViewReact
  readonly ui: StatusViewUi
}

export interface MusicStatusViewService {
  registerView(
    descriptor: {
      readonly key: string
      readonly maxRows?: 1 | 2 | 3
      readonly component: (props: StatusViewProps) => unknown
    },
    identity?: Context,
  ): (() => void) | undefined
}

const EMPTY_STATE: MusicBarState = Object.freeze({
  snapshot: undefined,
  observedAtMs: 0,
  renderedAtMs: 0,
  cover: undefined,
  spectrum: undefined,
  pending: undefined,
  previewPositionMs: undefined,
  error: undefined,
  healthWarning: undefined,
})

/** Mutable store whose snapshots stay referentially stable between updates. */
export class MusicBarStore {
  private readonly listeners = new Set<() => void>()
  private state: MusicBarState = EMPTY_STATE

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): MusicBarState => this.state

  replace(state: MusicBarState): void {
    this.state = Object.freeze(state)
    for (const listener of this.listeners) listener()
  }

  clear(): void {
    if (this.state === EMPTY_STATE) return
    this.state = EMPTY_STATE
    for (const listener of this.listeners) listener()
  }
}

export class MusicControlPendingError extends Error {
  constructor() {
    super('another music control is still pending')
    this.name = 'MusicControlPendingError'
  }
}

/** Own the prompt bar, its polling subscription, interpolation, and artwork. */
export class MusicBarPresenter implements MusicDisplay {
  readonly store = new MusicBarStore()
  private readonly lifecycle = new AbortController()
  private readonly coverLoader: CoverArtLoader
  private readonly now: () => number
  private readonly spectrumStyle: MusicSpectrumStyle
  private visible = false
  private spectrumDemand = false
  private stopPolling: (() => void) | undefined
  private stopSpectrum: (() => void) | undefined
  private stopView: (() => void) | undefined
  private tickTimer: ReturnType<typeof setInterval> | undefined
  private errorTimer: ReturnType<typeof setTimeout> | undefined
  private coverAbort: AbortController | undefined
  private coverGeneration = 0
  private coverUrl: string | null = null
  private playbackProbe: PlaybackProbe | undefined
  private disposed = false

  constructor(
    private readonly owner: Context,
    private readonly status: MusicStatusViewService,
    private readonly controller: MusicController,
    options: {
      readonly coverLoader?: CoverArtLoader
      readonly now?: () => number
      readonly spectrumStyle?: MusicSpectrumStyle
    } = {},
  ) {
    this.coverLoader = options.coverLoader ?? new CoverArtLoader()
    this.now = options.now ?? Date.now
    this.spectrumStyle = options.spectrumStyle ?? 'follow'
  }

  async show(signal?: AbortSignal): Promise<MusicDisplayShowResult> {
    const displayed = this.open()
    try {
      const snapshot = await this.controller.status(signal)
      return { snapshot, displayed }
    } catch (error) {
      if (displayed && this.store.getSnapshot().snapshot === undefined) this.receive(undefined)
      throw error
    }
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.stopPolling?.()
    this.stopPolling = undefined
    this.setSpectrumDemand(false)
    this.stopView?.()
    this.stopView = undefined
    this.stopTick()
    this.clearControlError()
    this.cancelCover()
    this.coverUrl = null
    this.playbackProbe = undefined
    this.store.clear()
  }

  async control(command: YpmControlCommand, signal?: AbortSignal): Promise<MusicControlResult> {
    return this.mutate(command, operationSignal => this.controller.control(command, operationSignal), signal)
  }

  async seek(positionMs: number, signal?: AbortSignal): Promise<MusicControlResult> {
    return this.mutate('seek', operationSignal => this.controller.seek(positionMs, operationSignal), signal)
  }

  private async mutate(
    operation: MusicPendingOperation,
    run: (signal?: AbortSignal) => Promise<MusicControlResult>,
    signal?: AbortSignal,
  ): Promise<MusicControlResult> {
    const current = this.store.getSnapshot()
    if (current.pending !== undefined) throw new MusicControlPendingError()
    this.clearControlError()
    this.replace({ ...this.store.getSnapshot(), pending: operation })
    try {
      return await run(signal)
    } finally {
      const latest = this.store.getSnapshot()
      if (latest.pending === operation) this.replace({ ...latest, pending: undefined })
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.hide()
    this.lifecycle.abort()
  }

  private open(): boolean {
    if (this.disposed) return false
    if (this.visible) return true
    const stopView = this.status.registerView({
      key: STATUS_KEY,
      maxRows: 3,
      component: createMusicBarView(this.store, {
        control: command => { void this.controlFromView(command) },
        previewSeek: positionMs => this.previewSeek(positionMs),
        seek: positionMs => { void this.seekFromView(positionMs) },
        close: () => this.hide(),
        spectrumDemand: demand => this.setSpectrumDemand(demand),
      }, this.spectrumStyle),
    }, this.owner)
    if (stopView === undefined) return false
    this.stopView = stopView
    this.visible = true
    try {
      this.stopPolling = this.controller.startPolling(snapshot => this.receive(snapshot))
    } catch (error) {
      this.visible = false
      this.stopView = undefined
      this.stopPolling?.()
      this.stopPolling = undefined
      this.stopSpectrum?.()
      this.stopSpectrum = undefined
      stopView()
      throw error
    }
    return true
  }

  private receive(snapshot: YpmSnapshot | undefined): void {
    if (!this.visible) return
    if (snapshot === undefined) {
      this.stopTick()
      this.cancelCover()
      this.coverUrl = null
      this.playbackProbe = undefined
      this.replace({ ...EMPTY_STATE, healthWarning: PLAYER_OFFLINE_WARNING })
      return
    }
    const time = this.now()
    const previous = this.store.getSnapshot()
    const healthWarning = this.observePlayback(snapshot, time)
    this.replace({
      snapshot,
      observedAtMs: time,
      renderedAtMs: time,
      cover: (snapshot.coverUrl ?? null) === this.coverUrl ? previous.cover : undefined,
      spectrum: healthWarning === undefined ? previous.spectrum : undefined,
      pending: previous.pending,
      previewPositionMs: undefined,
      error: previous.error,
      healthWarning,
    })
    if (healthWarning === undefined) this.startTick(snapshot)
    else this.stopTick()
    this.loadCover(snapshot.coverUrl ?? null)
  }

  private observePlayback(snapshot: YpmSnapshot, observedAtMs: number): string | undefined {
    if (!snapshot.playing || snapshot.title === null) {
      this.playbackProbe = undefined
      return undefined
    }
    const trackKey = JSON.stringify([
      snapshot.title,
      snapshot.artist,
      snapshot.album,
      snapshot.durationMs,
    ])
    const previous = this.playbackProbe
    if (previous === undefined
      || previous.trackKey !== trackKey
      || previous.positionMs !== snapshot.positionMs) {
      this.playbackProbe = { trackKey, positionMs: snapshot.positionMs, progressedAtMs: observedAtMs }
      return undefined
    }
    return observedAtMs - previous.progressedAtMs >= PLAYBACK_STALL_MS
      ? PLAYBACK_STALLED_WARNING
      : undefined
  }

  private receiveSpectrum(spectrum: YpmSpectrumFrame | undefined): void {
    if (!this.visible || this.disposed) return
    const current = this.store.getSnapshot()
    if (current.healthWarning !== undefined) return
    if (sameSpectrumFrame(current.spectrum, spectrum)) return
    this.replace({ ...current, spectrum })
  }

  private setSpectrumDemand(demand: boolean): void {
    const next = demand && this.spectrumStyle !== 'off' && this.visible && !this.disposed
    if (this.spectrumDemand === next) return
    this.spectrumDemand = next
    this.stopSpectrum?.()
    this.stopSpectrum = undefined
    if (next) {
      this.stopSpectrum = this.controller.startSpectrum(frame => this.receiveSpectrum(frame))
      return
    }
    const current = this.store.getSnapshot()
    if (current.spectrum !== undefined) this.replace({ ...current, spectrum: undefined })
  }

  private startTick(snapshot: YpmSnapshot): void {
    this.stopTick()
    if (!snapshot.playing) return
    this.tickTimer = setInterval(() => {
      const current = this.store.getSnapshot()
      if (current.snapshot === undefined || !current.snapshot.playing) {
        this.stopTick()
        return
      }
      this.replace({ ...current, renderedAtMs: this.now() })
    }, LOCAL_TICK_MS)
    this.tickTimer.unref()
  }

  private stopTick(): void {
    if (this.tickTimer === undefined) return
    clearInterval(this.tickTimer)
    this.tickTimer = undefined
  }

  private async controlFromView(command: YpmControlCommand): Promise<void> {
    try {
      await this.control(command)
    } catch (error) {
      if (error instanceof MusicControlPendingError || !this.visible || this.disposed) return
      this.showControlError(describeYpmError(error))
    }
  }

  private previewSeek(positionMs: number | undefined): void {
    if (!this.visible || this.disposed) return
    const current = this.store.getSnapshot()
    if (current.previewPositionMs === positionMs) return
    this.replace({ ...current, previewPositionMs: positionMs })
  }

  private async seekFromView(positionMs: number): Promise<void> {
    if (!this.visible || this.disposed) return
    this.previewSeek(undefined)
    try {
      await this.seek(positionMs)
    } catch (error) {
      if (error instanceof MusicControlPendingError || !this.visible || this.disposed) return
      this.showControlError(describeYpmError(error))
    }
  }

  private showControlError(message: string): void {
    this.clearControlError()
    this.replace({ ...this.store.getSnapshot(), error: message })
    this.errorTimer = setTimeout(() => {
      this.errorTimer = undefined
      if (!this.visible || this.disposed) return
      const current = this.store.getSnapshot()
      if (current.error !== undefined) this.replace({ ...current, error: undefined })
    }, CONTROL_ERROR_MS)
    this.errorTimer.unref()
  }

  private clearControlError(): void {
    if (this.errorTimer !== undefined) {
      clearTimeout(this.errorTimer)
      this.errorTimer = undefined
    }
    const current = this.store.getSnapshot()
    if (current.error !== undefined) this.replace({ ...current, error: undefined })
  }

  private loadCover(url: string | null): void {
    if (url === this.coverUrl) return
    this.cancelCover()
    this.coverUrl = url
    const generation = ++this.coverGeneration
    if (url === null) return
    const controller = new AbortController()
    this.coverAbort = controller
    const signal = AbortSignal.any([this.lifecycle.signal, controller.signal])
    void this.coverLoader.load(url, signal).then((cover) => {
      if (this.disposed
        || !this.visible
        || controller.signal.aborted
        || generation !== this.coverGeneration
        || this.coverUrl !== url) return
      const current = this.store.getSnapshot()
      if (current.snapshot?.coverUrl !== url) return
      this.replace({ ...current, cover })
    })
  }

  private cancelCover(): void {
    this.coverGeneration += 1
    this.coverAbort?.abort()
    this.coverAbort = undefined
  }

  private replace(state: MusicBarState): void {
    this.store.replace(state)
  }
}

export function musicBarLayout(columns: number): MusicBarLayout {
  return Object.freeze({
    showCover: columns >= 60,
    showAlbum: columns >= 80,
    showProgress: columns >= 44,
    progressCells: columns >= 100 ? 20 : columns >= 52 ? 10 : 0,
    spectrumCells: spectrumCells(columns),
  })
}

export function interpolatedPosition(state: MusicBarState): number {
  const snapshot = state.snapshot
  if (snapshot === undefined) return 0
  if (state.previewPositionMs !== undefined) {
    return snapshot.durationMs === null
      ? state.previewPositionMs
      : Math.min(snapshot.durationMs, state.previewPositionMs)
  }
  const elapsed = snapshot.playing
    ? Math.max(0, state.renderedAtMs - state.observedAtMs)
    : 0
  const value = snapshot.positionMs + elapsed
  return snapshot.durationMs === null ? value : Math.min(snapshot.durationMs, value)
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`
}

export function progressLine(state: MusicBarState, cells: number): string {
  const snapshot = state.snapshot
  if (snapshot === undefined) return ''
  const position = interpolatedPosition(state)
  if (snapshot.durationMs === null || snapshot.durationMs <= 0) return formatDuration(position)
  const elapsed = formatDuration(position)
  const total = formatDuration(snapshot.durationMs)
  if (cells <= 0) return `${elapsed}/${total}`
  const ratio = Math.max(0, Math.min(1, position / snapshot.durationMs))
  const head = Math.round((cells - 1) * ratio)
  const gauge = `${'━'.repeat(head)}●${'─'.repeat(Math.max(0, cells - head - 1))}`
  return `${elapsed} ${gauge} ${total}`
}

export function positionForProgressCell(durationMs: number, cells: number, localCol: number): number {
  if (durationMs <= 0 || cells <= 1) return 0
  const cell = Math.max(0, Math.min(cells - 1, Math.round(localCol)))
  return Math.round(durationMs * cell / (cells - 1))
}

function createMusicBarView(
  store: MusicBarStore,
  actions: {
    readonly control: (command: YpmControlCommand) => void
    readonly previewSeek: (positionMs: number | undefined) => void
    readonly seek: (positionMs: number) => void
    readonly close: () => void
    readonly spectrumDemand: (demand: boolean) => void
  },
  spectrumPreference: MusicSpectrumStyle,
): (props: StatusViewProps) => unknown {
  return ({ React, ui }) => {
    const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
    const [hovered, setHovered] = React.useState<MusicHoverTarget | undefined>(undefined)
    const { columns } = ui.useTerminalSize()
    const layout = musicBarLayout(columns)
    const snapshot = state.snapshot
    const wantsSpectrum = spectrumPreference !== 'off'
      && layout.spectrumCells > 0
      && snapshot?.title != null
      && state.healthWarning === undefined
    React.useEffect(() => {
      actions.spectrumDemand(wantsSpectrum)
      return () => actions.spectrumDemand(false)
    }, [wantsSpectrum])
    if (snapshot === undefined) {
      if (state.healthWarning === undefined) return null
      return React.createElement(
        ui.Box,
        { flexDirection: 'row', width: '100%', height: 3 },
        React.createElement(
          ui.Box,
          { flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, height: 3 },
          React.createElement(ui.Text, { bold: true, wrap: 'truncate' }, 'YesPlayMusic'),
          React.createElement(ui.Text, { color: 'error', wrap: 'truncate' }, `! ${state.healthWarning}`),
          React.createElement(
            ui.Text,
            { dimColor: true, wrap: 'truncate' },
            'Start ypm; this bar will reconnect automatically',
          ),
        ),
        closeNode(React, ui, 'unicode', hovered, setHovered, actions.close),
      )
    }
    if (snapshot.title === null) return null
    const spectrumFrame = state.spectrum
    const spectrumStyle = spectrumFrame === undefined
      ? undefined
      : resolveSpectrumStyle(spectrumPreference, spectrumFrame.style)
    const spectrum = spectrumFrame === undefined
      || spectrumStyle === undefined
      || layout.spectrumCells === 0
      || state.healthWarning !== undefined
      ? null
      : spectrumNode(React, ui, spectrumFrame, spectrumStyle, layout.spectrumCells)
    const statusMessage = state.error ?? state.healthWarning
    const body = React.createElement(
      ui.Box,
      { flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, height: 3 },
      React.createElement(ui.Text, { bold: true, wrap: 'truncate' }, snapshot.title),
      statusMessage === undefined
        ? React.createElement(
            ui.Text,
            { dimColor: true, wrap: 'truncate' },
            metadataLine(snapshot, layout.showAlbum),
          )
        : React.createElement(
            ui.Text,
            { color: 'error', wrap: 'truncate' },
            `! ${statusMessage}`,
          ),
      React.createElement(
        ui.Box,
        { flexDirection: 'row', flexShrink: 0, minWidth: 0 },
        controlButton(React, ui, 'prev', controlGlyph(snapshot.iconStyle, 'prev'), state.pending, hovered, setHovered, actions),
        controlButton(
          React,
          ui,
          'toggle',
          controlGlyph(snapshot.iconStyle, snapshot.playing ? 'pause' : 'play'),
          state.pending,
          hovered,
          setHovered,
          actions,
        ),
        controlButton(React, ui, 'next', controlGlyph(snapshot.iconStyle, 'next'), state.pending, hovered, setHovered, actions),
        layout.showProgress
          ? progressNode(React, ui, state, layout.progressCells, hovered, setHovered, actions)
          : null,
        React.createElement(ui.Box, { flexGrow: 1, minWidth: 0 }),
      ),
    )
    return React.createElement(
      ui.Box,
      { flexDirection: 'row', width: '100%', height: 3 },
      layout.showCover ? coverNode(React, ui, state.cover) : null,
      layout.showCover ? React.createElement(ui.Box, { width: 1, flexShrink: 0 }) : null,
      body,
      spectrum === null ? null : React.createElement(ui.Box, { width: 1, flexShrink: 0 }),
      spectrum,
      spectrum === null ? null : React.createElement(ui.Box, { width: 1, flexShrink: 0 }),
      closeNode(React, ui, snapshot.iconStyle, hovered, setHovered, actions.close),
    )
  }
}

function sameSpectrumFrame(
  left: YpmSpectrumFrame | undefined,
  right: YpmSpectrumFrame | undefined,
): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  return left.version === right.version
    && left.style === right.style
    && left.playing === right.playing
    && left.bins.length === right.bins.length
    && left.bins.every((value, index) => value === right.bins[index])
}

function spectrumNode(
  React: StatusViewReact,
  ui: StatusViewUi,
  frame: YpmSpectrumFrame,
  style: Exclude<MusicSpectrumStyle, 'off' | 'follow'>,
  cells: number,
): unknown {
  const rows = renderSpectrum(frame, style, cells)
  return React.createElement(
    ui.Box,
    { flexDirection: 'column', width: cells, height: 3, flexShrink: 0 },
    ...rows.map((row, index) => React.createElement(
      ui.Text,
      {
        key: `spectrum-${index}`,
        color: SPECTRUM_ROW_COLORS[index] ?? 'claude',
        dimColor: !frame.playing,
        wrap: 'truncate',
      },
      row,
    )),
  )
}

function closeNode(
  React: StatusViewReact,
  ui: StatusViewUi,
  iconStyle: YpmSnapshot['iconStyle'],
  hovered: MusicHoverTarget | undefined,
  setHovered: (value: MusicHoverTarget | undefined) => void,
  close: () => void,
): unknown {
  return React.createElement(
    ui.Box,
    {
      flexDirection: 'column',
      justifyContent: 'flex-end',
      width: CONTROL_WIDTH,
      height: 3,
      flexShrink: 0,
    },
    React.createElement(
      ui.Box,
      {
        onClick: close,
        onMouseEnter: () => setHovered('close'),
        onMouseLeave: () => setHovered(undefined),
        backgroundColor: hovered === 'close' ? 'userMessageBackgroundHover' : undefined,
        width: CONTROL_WIDTH,
        height: 1,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
      },
      React.createElement(
        ui.Text,
        { dimColor: hovered !== 'close', bold: hovered === 'close' },
        controlGlyph(iconStyle, 'close'),
      ),
    ),
  )
}

function coverNode(React: StatusViewReact, ui: StatusViewUi, cover: TerminalCover | undefined): unknown {
  if (cover === undefined) {
    return React.createElement(
      ui.Box,
      { flexDirection: 'column', width: 6, height: 3, flexShrink: 0 },
      React.createElement(ui.Text, { dimColor: true }, '┌────┐'),
      React.createElement(ui.Text, { dimColor: true }, '│ ♪  │'),
      React.createElement(ui.Text, { dimColor: true }, '└────┘'),
    )
  }
  const fallback = React.createElement(
    ui.Box,
    { flexDirection: 'column', width: 6, height: 3, flexShrink: 0 },
    ...cover.rows.map((row, rowIndex) => React.createElement(
      ui.Box,
      { key: `cover-row-${rowIndex}`, flexDirection: 'row', height: 1 },
      ...row.map((cell, column) => React.createElement(
        ui.Text,
        {
          key: `cover-${rowIndex}-${column}`,
          color: cell.top,
          backgroundColor: cell.bottom,
        },
        '▀',
      )),
    )),
  )
  if (ui.Image === undefined) return fallback
  return React.createElement(
    ui.Image,
    {
      source: cover.image,
      width: 6,
      height: 3,
      alt: '',
    },
    fallback,
  )
}

function controlButton(
  React: StatusViewReact,
  ui: StatusViewUi,
  command: YpmControlCommand,
  label: string,
  pending: MusicPendingOperation | undefined,
  hovered: MusicHoverTarget | undefined,
  setHovered: (value: MusicHoverTarget | undefined) => void,
  actions: { readonly control: (command: YpmControlCommand) => void },
): unknown {
  const active = pending === undefined
  const isHovered = active && hovered === command
  const shown = pending === command ? '…' : label
  return React.createElement(
    ui.Box,
    {
      flexShrink: 0,
      width: CONTROL_WIDTH,
      marginRight: 1,
      alignItems: 'center',
      justifyContent: 'center',
      onMouseEnter: active ? () => setHovered(command) : undefined,
      onMouseLeave: active ? () => setHovered(undefined) : undefined,
      backgroundColor: isHovered ? 'userMessageBackgroundHover' : undefined,
      ...(active ? { onClick: () => actions.control(command) } : {}),
    },
    React.createElement(ui.Text, { dimColor: !active, bold: isHovered }, shown),
  )
}

function progressNode(
  React: StatusViewReact,
  ui: StatusViewUi,
  state: MusicBarState,
  cells: number,
  hovered: MusicHoverTarget | undefined,
  setHovered: (value: MusicHoverTarget | undefined) => void,
  actions: {
    readonly previewSeek: (positionMs: number | undefined) => void
    readonly seek: (positionMs: number) => void
  },
): unknown {
  const snapshot = state.snapshot
  if (snapshot === undefined || snapshot.durationMs === null || snapshot.durationMs <= 0 || cells <= 0) {
    return React.createElement(ui.Text, { dimColor: true }, ` ${progressLine(state, 0)} `)
  }
  const durationMs = snapshot.durationMs
  const position = interpolatedPosition(state)
  const ratio = Math.max(0, Math.min(1, position / durationMs))
  const head = Math.round((cells - 1) * ratio)
  const gauge = `${'━'.repeat(head)}●${'─'.repeat(Math.max(0, cells - head - 1))}`
  const enabled = snapshot.seekable && state.pending === undefined
  const seekAt = (event: StatusViewPointerEvent): number => {
    return positionForProgressCell(durationMs, cells, event.localCol)
  }
  return React.createElement(
    ui.Box,
    { flexDirection: 'row', flexShrink: 0, minWidth: 0 },
    React.createElement(ui.Text, { dimColor: true }, ` ${formatDuration(position)} `),
    React.createElement(
      ui.Box,
      {
        width: cells,
        flexShrink: 0,
        onMouseEnter: enabled ? () => setHovered('seek') : undefined,
        onMouseLeave: enabled ? () => setHovered(undefined) : undefined,
        ...(enabled
          ? {
              onClick: (event: StatusViewPointerEvent) => actions.seek(seekAt(event)),
              onDragStart: (event: StatusViewPointerEvent) => actions.previewSeek(seekAt(event)),
              onDragMove: (event: StatusViewPointerEvent) => actions.previewSeek(seekAt(event)),
              onDragEnd: (event: StatusViewPointerEvent) => actions.seek(seekAt(event)),
            }
          : {}),
      },
      React.createElement(ui.Text, {
        dimColor: !enabled,
        bold: hovered === 'seek' || state.pending === 'seek',
      }, gauge),
    ),
    React.createElement(ui.Text, { dimColor: true }, ` ${formatDuration(durationMs)} `),
  )
}

type ControlGlyph = 'prev' | 'play' | 'pause' | 'next' | 'close'

function controlGlyph(style: YpmSnapshot['iconStyle'], glyph: ControlGlyph): string {
  const palette: Record<ControlGlyph, string> = style === 'nerd'
    ? { prev: '\uf048', play: '\uf04b', pause: '\uf04c', next: '\uf051', close: '\uf00d' }
    : { prev: '⏮', play: '▶', pause: '⏸', next: '⏭', close: '×' }
  return palette[glyph]
}

function metadataLine(snapshot: YpmSnapshot, showAlbum: boolean): string {
  return [snapshot.artist, showAlbum ? snapshot.album : null]
    .filter((value): value is string => Boolean(value))
    .join(' · ')
}
