import assert from 'node:assert/strict'
import test from 'node:test'
import {
  interpolatedPosition,
  MusicBarPresenter,
  MusicControlPendingError,
  musicBarLayout,
  progressLine,
} from '../lib/music-bar.js'
import { YpmError } from '../lib/ypm-client.js'

const snapshot = Object.freeze({
  playing: false,
  title: '春日影という名前の長い曲',
  artist: 'CRYCHIC',
  album: 'CRYCHIC Live at RiNG',
  positionMs: 3_723_000,
  durationMs: 45_296_000,
  coverUrl: null,
  seekable: true,
  iconStyle: 'unicode',
  source: 'tui',
})

const flush = () => new Promise(resolve => setImmediate(resolve))

test('32, 60, and 120 columns progressively reveal progress, cover, and album', () => {
  assert.deepEqual(musicBarLayout(32), {
    showCover: false,
    showAlbum: false,
    showProgress: false,
    progressCells: 0,
    spectrumCells: 0,
  })
  assert.deepEqual(musicBarLayout(60), {
    showCover: true,
    showAlbum: false,
    showProgress: true,
    progressCells: 10,
    spectrumCells: 0,
  })
  assert.deepEqual(musicBarLayout(120), {
    showCover: true,
    showAlbum: true,
    showProgress: true,
    progressCells: 20,
    spectrumCells: 24,
  })
})

test('playing position interpolates locally while paused position stays frozen', () => {
  const state = {
    snapshot: { ...snapshot, playing: true, positionMs: 5000, durationMs: 10_000 },
    observedAtMs: 1000,
    renderedAtMs: 3250,
    cover: undefined,
    pending: undefined,
    error: undefined,
  }
  assert.equal(interpolatedPosition(state), 7250)
  assert.equal(progressLine(state, 10), '0:07 ━━━━━━━●── 0:10')
  assert.equal(interpolatedPosition({
    ...state,
    snapshot: { ...state.snapshot, playing: false },
  }), 5000)
})

test('rich hosts receive a three-row responsive view with narrow controls intact', async () => {
  const fixture = await richFixture()
  assert.deepEqual(fixture.showResult, { snapshot, displayed: true })
  assert.equal(fixture.descriptor.maxRows, 3)
  assert.equal(fixture.identity, fixture.owner)

  const narrow = createRenderer(32).render(fixture.descriptor.component)
  const narrowText = textOf(narrow)
  assert.match(narrowText, /春日影/u)
  assert.match(narrowText, /CRYCHIC/u)
  assert.match(narrowText, /⏮.*▶.*⏭.*×/u)
  assert.equal(controlNode(narrow, '⏮').props.width, 3)
  assert.equal(controlNode(narrow, '▶').props.width, 3)
  assert.equal(controlNode(narrow, '⏭').props.width, 3)
  assertTrailingClose(narrow)
  assert.doesNotMatch(narrowText, /12:34:56/u)
  assert.doesNotMatch(narrowText, /┌────┐/u)

  const medium = createRenderer(60).render(fixture.descriptor.component)
  const mediumText = textOf(medium)
  assert.match(mediumText, /┌────┐/u)
  assert.match(mediumText, /1:02:03 .* 12:34:56/u)
  assert.doesNotMatch(mediumText, /Live at RiNG/u)
  assertTrailingClose(medium)

  const wide = createRenderer(120).render(fixture.descriptor.component)
  const wideText = textOf(wide)
  assert.match(wideText, /Live at RiNG/u)
  assertTrailingClose(wide)
  fixture.presenter.dispose()
})

test('spectra grow on wide terminals while narrow bars release the stream', async () => {
  const fixture = await richFixture({ spectrumStyle: 'blocks' })
  const frame = {
    version: 1,
    style: 'waterfall',
    playing: true,
    bins: Array.from({ length: 32 }, () => 255),
  }
  const renderer = createRenderer(79)

  const narrow = renderer.render(fixture.descriptor.component)
  assert.equal(findNode(narrow, node => node.type === 'Box' && node.props.width === 24), undefined)
  assert.equal(fixture.events.includes('start spectrum'), false)
  assertTrailingClose(narrow)

  for (const [columns, cells] of [
    [80, 12],
    [96, 18],
    [120, 24],
    [140, 34],
    [168, 48],
    [240, 48],
  ]) {
    renderer.resize(columns)
    renderer.render(fixture.descriptor.component)
    fixture.emitSpectrum(frame)
    const tree = renderer.render(fixture.descriptor.component)
    const spectrum = findNode(tree, node => node.type === 'Box'
      && node.props.width === cells
      && node.props.height === 3)
    assert(spectrum, `${columns} columns should reserve a ${cells}x3 spectrum`)
    assert.deepEqual(spectrum.children.map(textOf), [
      '█'.repeat(cells),
      '█'.repeat(cells),
      '█'.repeat(cells),
    ])
    assert.deepEqual(spectrum.children.map(node => node.props.color), [
      'rainbow_blue_shimmer',
      'rainbow_blue',
      'claude',
    ])
    assert.deepEqual(spectrum.children.map(node => node.props.dimColor), [false, false, false])
    const trailingClose = assertTrailingClose(tree)
    assert.equal(tree.children.indexOf(spectrum) < tree.children.indexOf(trailingClose), true)
    assert.match(textOf(tree), /⏮.*▶.*⏭.*×/u)
  }

  let updates = 0
  const unsubscribe = fixture.presenter.store.subscribe(() => { updates += 1 })
  fixture.emitSpectrum({ ...frame, bins: [...frame.bins] })
  assert.equal(updates, 0, 'identical frames should not redraw the status tree')
  unsubscribe()

  fixture.emitSpectrum({ ...frame, playing: false })
  const pausedTree = renderer.render(fixture.descriptor.component)
  const pausedSpectrum = findNode(pausedTree, node => node.type === 'Box'
    && node.props.width === 48
    && node.props.height === 3)
  assert(pausedSpectrum)
  assert.deepEqual(pausedSpectrum.children.map(node => node.props.dimColor), [true, true, true])

  renderer.resize(79)
  renderer.render(fixture.descriptor.component)
  assert.equal(fixture.events.at(-1), 'stop spectrum')

  renderer.resize(120)
  renderer.render(fixture.descriptor.component)
  fixture.emitSpectrum(frame)

  fixture.presenter.hide()
  assert.deepEqual(fixture.events.slice(-3), ['stop polling', 'stop spectrum', 'dispose view'])
})

test('spectrum off never opens a background stream', async () => {
  const fixture = await richFixture({ spectrumStyle: 'off' })
  createRenderer(120).render(fixture.descriptor.component)
  assert.equal(fixture.events.includes('start spectrum'), false)
  fixture.presenter.dispose()
})

test('a rejected rich-view registration returns the snapshot without polling', async () => {
  const events = []
  const presenter = new MusicBarPresenter({}, {
    set() { throw new Error('legacy status must not be used') },
    registerView() {
      events.push('register view')
      return undefined
    },
  }, {
    startPolling() {
      events.push('start polling')
      return () => events.push('stop polling')
    },
    async status() {
      events.push('read status')
      return snapshot
    },
  })

  assert.deepEqual(await presenter.show(), { snapshot, displayed: false })
  assert.deepEqual(events, ['register view', 'read status'])
  assert.equal(presenter.store.getSnapshot().snapshot, undefined)
  presenter.dispose()
})

test('mouse controls expose hover feedback, serialize pending work, and close the bar', async () => {
  let release
  const controls = []
  const fixture = await richFixture({
    control: command => new Promise(resolve => {
      controls.push(command)
      release = () => resolve({ ack: { ok: true, source: 'tui' }, snapshot })
    }),
  })
  const renderer = createRenderer(60)
  let tree = renderer.render(fixture.descriptor.component)
  let prev = controlNode(tree, '⏮')
  prev.props.onMouseEnter()
  tree = renderer.render(fixture.descriptor.component)
  prev = controlNode(tree, '⏮')
  assert.equal(prev.props.backgroundColor, 'userMessageBackgroundHover')
  assert.equal(prev.children[0].props.bold, true)

  prev.props.onClick()
  await flush()
  assert.deepEqual(controls, ['prev'])
  tree = renderer.render(fixture.descriptor.component)
  assert.match(textOf(tree), /…/u)
  assert.equal(controlNode(tree, '…').props.width, 3)
  assert.equal(controlNode(tree, '▶').props.width, 3)
  assert.equal(controlNode(tree, '⏭').props.width, 3)
  assert.equal(controlNode(tree, '▶').props.onClick, undefined)
  assert.equal(controlNode(tree, '⏭').props.onClick, undefined)
  await assert.rejects(
    fixture.presenter.control('next'),
    error => error instanceof MusicControlPendingError,
  )

  release()
  await flush()
  tree = renderer.render(fixture.descriptor.component)
  controlNode(tree, '▶').props.onClick()
  await flush()
  assert.deepEqual(controls, ['prev', 'toggle'])
  release()
  await flush()
  tree = renderer.render(fixture.descriptor.component)
  controlNode(tree, '⏭').props.onClick()
  await flush()
  assert.deepEqual(controls, ['prev', 'toggle', 'next'])
  release()
  await flush()
  tree = renderer.render(fixture.descriptor.component)
  controlNode(tree, '×').props.onClick()
  assert.deepEqual(fixture.events.slice(-2), ['stop polling', 'dispose view'])
})

test('click failures appear in the bar and recover on the next control', async () => {
  let fail = true
  const fixture = await richFixture({
    control: async () => {
      if (fail) throw new YpmError('process', 'failed', 'YesPlayMusic rejected the action')
      return { ack: { ok: true, source: 'tui' }, snapshot }
    },
  })
  const renderer = createRenderer(60)
  controlNode(renderer.render(fixture.descriptor.component), '⏭').props.onClick()
  await flush()
  assert.match(
    textOf(renderer.render(fixture.descriptor.component)),
    /! YesPlayMusic rejected the action/u,
  )

  fail = false
  controlNode(renderer.render(fixture.descriptor.component), '⏭').props.onClick()
  assert.equal(fixture.presenter.store.getSnapshot().error, undefined)
  await flush()
  fixture.presenter.dispose()
})

test('progress click seeks immediately while drag previews and commits only on release', async () => {
  const seeks = []
  const fixture = await richFixture({
    seek: async positionMs => {
      seeks.push(positionMs)
      return { ack: { ok: true, source: 'tui' }, snapshot }
    },
  })
  const renderer = createRenderer(60)
  let tree = renderer.render(fixture.descriptor.component)
  let progress = progressNode(tree)

  progress.props.onClick({ localCol: 9 })
  await flush()
  assert.deepEqual(seeks, [snapshot.durationMs])

  tree = renderer.render(fixture.descriptor.component)
  progress = progressNode(tree)
  progress.props.onDragStart({ localCol: 2 })
  progress.props.onDragMove({ localCol: 7 })
  assert.deepEqual(seeks, [snapshot.durationMs])
  tree = renderer.render(fixture.descriptor.component)
  assert.match(textOf(tree), /9:47:10/u)

  progressNode(tree).props.onDragEnd({ localCol: 4 })
  await flush()
  assert.deepEqual(seeks, [snapshot.durationMs, 20_131_556])
  fixture.presenter.dispose()
})

test('a late drag release is ignored after the music bar closes', async () => {
  const seeks = []
  const fixture = await richFixture({
    seek: async positionMs => {
      seeks.push(positionMs)
      return { ack: { ok: true, source: 'tui' }, snapshot }
    },
  })
  const tree = createRenderer(60).render(fixture.descriptor.component)
  const progress = progressNode(tree)

  controlNode(tree, '×').props.onClick()
  progress.props.onDragEnd({ localCol: 7 })
  await flush()

  assert.deepEqual(seeks, [])
  fixture.presenter.dispose()
})

test('old YPM snapshots keep progress readable but non-interactive', async () => {
  const fixture = await richFixture({
    snapshot: { ...snapshot, seekable: false },
  })
  const tree = createRenderer(60).render(fixture.descriptor.component)
  assert.equal(progressNode(tree).props.onClick, undefined)
  assert.equal(progressNode(tree).props.onDragStart, undefined)
  fixture.presenter.dispose()
})

test('Nerd Font mode swaps controls without changing their cell geometry', async () => {
  const fixture = await richFixture({
    snapshot: { ...snapshot, iconStyle: 'nerd' },
  })
  const tree = createRenderer(60).render(fixture.descriptor.component)
  for (const glyph of ['\uf048', '\uf04b', '\uf051', '\uf00d']) {
    assert.equal(controlNode(tree, glyph).props.width, 3)
  }
  fixture.presenter.dispose()
})

test('graphics-capable hosts receive RGBA artwork with the cell thumbnail as fallback', async () => {
  const cover = {
    image: { data: new Uint8Array(96 * 96 * 4), width: 96, height: 96 },
    rows: Array.from({ length: 3 }, () =>
      Array.from({ length: 6 }, () => ({ top: '#112233', bottom: '#445566' }))),
  }
  const fixture = await richFixture({
    snapshot: {
      ...snapshot,
      coverUrl: 'https://p1.music.126.net/cover.jpg',
    },
    coverLoader: { load: async () => cover },
  })
  await flush()
  const tree = createRenderer(60, { image: true }).render(fixture.descriptor.component)
  const image = findNode(tree, node => node.type === 'Image')
  assert(image, 'host Image node should be used when available')
  assert.equal(image.props.source, cover.image)
  assert.equal(image.props.width, 6)
  assert.equal(image.props.height, 3)
  assert.equal(image.props.alt, '')
  assert.equal((textOf(image).match(/▀/gu) ?? []).length, 18)
  fixture.presenter.dispose()
})

test('artwork loads only when its URL changes and hiding aborts the active load', async () => {
  const calls = []
  let sink
  const loader = {
    load(url, signal) {
      calls.push({ url, signal })
      return new Promise(() => {})
    },
  }
  const first = { ...snapshot, coverUrl: 'https://p1.music.126.net/a.jpg' }
  const controller = {
    startPolling(value) {
      sink = value
      return () => {}
    },
    startSpectrum() {
      return () => {}
    },
    async status() {
      sink(first)
      return first
    },
  }
  const status = {
    set() { return () => {} },
    registerView() { return () => {} },
  }
  const presenter = new MusicBarPresenter({}, status, controller, { coverLoader: loader })
  await presenter.show()
  sink({ ...first })
  sink({ ...first, coverUrl: 'https://p1.music.126.net/b.jpg' })
  assert.deepEqual(calls.map(call => call.url), [
    'https://p1.music.126.net/a.jpg',
    'https://p1.music.126.net/b.jpg',
  ])
  assert.equal(calls[0].signal.aborted, true)
  presenter.hide()
  assert.equal(calls[1].signal.aborted, true)
})

async function richFixture(options = {}) {
  const events = []
  const owner = {}
  let sink
  let spectrumSink
  let descriptor
  let identity
  const fixtureSnapshot = options.snapshot ?? snapshot
  const controller = {
    startPolling(value) {
      sink = value
      events.push('start polling')
      return () => events.push('stop polling')
    },
    startSpectrum(value) {
      spectrumSink = value
      events.push('start spectrum')
      return () => events.push('stop spectrum')
    },
    async status() {
      sink(fixtureSnapshot)
      return fixtureSnapshot
    },
    control: options.control ?? (async () => ({ ack: { ok: true, source: 'tui' }, snapshot: fixtureSnapshot })),
    seek: options.seek ?? (async () => ({ ack: { ok: true, source: 'tui' }, snapshot: fixtureSnapshot })),
  }
  const status = {
    set() { return () => {} },
    registerView(value, valueIdentity) {
      descriptor = value
      identity = valueIdentity
      events.push('register view')
      return () => events.push('dispose view')
    },
  }
  const presenter = new MusicBarPresenter(owner, status, controller, {
    ...(options.coverLoader === undefined ? {} : { coverLoader: options.coverLoader }),
    ...(options.spectrumStyle === undefined ? {} : { spectrumStyle: options.spectrumStyle }),
  })
  const showResult = await presenter.show()
  return {
    descriptor,
    identity,
    owner,
    presenter,
    events,
    showResult,
    emitSpectrum(frame) {
      assert(spectrumSink, 'spectrum stream should be active')
      spectrumSink(frame)
    },
  }
}

function createRenderer(columns, options = {}) {
  const state = []
  const effects = []
  let cursor = 0
  let effectCursor = 0
  let currentColumns = columns
  let pendingEffects = []
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
    useEffect(effect, dependencies) {
      const index = effectCursor
      effectCursor += 1
      const previous = effects[index]
      const changed = previous === undefined
        || dependencies.length !== previous.dependencies.length
        || dependencies.some((value, dependency) => !Object.is(value, previous.dependencies[dependency]))
      if (!changed) return
      pendingEffects.push(() => {
        previous?.cleanup?.()
        effects[index] = {
          dependencies: [...dependencies],
          cleanup: effect(),
        }
      })
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in state)) state[index] = initial
      return [state[index], value => { state[index] = value }]
    },
  }
  const ui = {
    Box: 'Box',
    ...(options.image ? { Image: 'Image' } : {}),
    Text: 'Text',
    useTerminalSize: () => ({ columns: currentColumns, rows: 40 }),
  }
  return {
    render(component) {
      cursor = 0
      effectCursor = 0
      pendingEffects = []
      const tree = component({ React, ui })
      for (const commit of pendingEffects) commit()
      return tree
    },
    resize(nextColumns) {
      currentColumns = nextColumns
    },
  }
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}

function controlNode(tree, label) {
  const found = findNode(tree, node => node.type === 'Box'
    && (node.children ?? []).some(child => child?.type === 'Text' && textOf(child) === label))
  assert(found, `control ${label} should exist`)
  return found
}

function assertTrailingClose(tree) {
  const close = tree.children.at(-1)
  assert(close, 'music bar should end with a close column')
  assert.equal(close.type, 'Box')
  assert.equal(close.props.width, 3)
  assert.equal(close.props.height, 3)
  assert.equal(textOf(close), '×')
  return close
}

function progressNode(tree) {
  const found = findNode(tree, node => node.type === 'Box'
    && node.props.width === 10
    && /^[━●─]+$/u.test(textOf(node)))
  assert(found, 'interactive progress gauge should exist')
  return found
}

function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}
