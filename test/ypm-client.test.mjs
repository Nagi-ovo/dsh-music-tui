import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import {
  YpmClient,
  YpmError,
  cleanExternalText,
  execFileRunner,
  parseAck,
  parseSnapshot,
  parseSpectrumFrame,
  playbackLine,
  spawnSpectrumRunner,
} from '../lib/ypm-client.js'

const snapshotJson = JSON.stringify({
  playing: true,
  title: '迷星叫',
  artist: 'MyGO!!!!!',
  album: '迷跡波',
  positionMs: 12_000,
  durationMs: 180_000,
  coverUrl: 'https://p1.music.126.net/cover.jpg',
  seekable: true,
  iconStyle: 'nerd',
  source: 'tui',
})

const spectrumBins = Array.from({ length: 32 }, (_, index) => index * 8)
const spectrumJson = JSON.stringify({
  version: 1,
  style: 'braille',
  playing: true,
  bins: spectrumBins,
})

test('YpmClient always uses the public JSON TUI CLI surface without a shell', async () => {
  const calls = []
  const runner = async (executable, argv, options) => {
    calls.push({ executable, argv, options })
    return {
      stdout: argv.at(-1) === 'status' ? snapshotJson : '{"ok":true,"source":"tui"}',
      stderr: '',
    }
  }
  const client = new YpmClient({ executable: '/opt/bin/ypm', timeoutMs: 2345, runner })

  await client.status()
  await client.control('next')
  await client.seek(90_500)

  assert.deepEqual(calls.map(({ executable, argv, options }) => ({
    executable,
    argv,
    timeoutMs: options.timeoutMs,
  })), [
    { executable: '/opt/bin/ypm', argv: ['--json', '--tui', 'status'], timeoutMs: 2345 },
    { executable: '/opt/bin/ypm', argv: ['--json', '--tui', 'next'], timeoutMs: 2345 },
    { executable: '/opt/bin/ypm', argv: ['--json', '--tui', 'seek', '90.5'], timeoutMs: 2345 },
  ])
})

test('status and acknowledgements are strictly validated', () => {
  const snapshot = parseSnapshot(snapshotJson)
  assert.equal(snapshot.title, '迷星叫')
  assert.equal(snapshot.coverUrl, 'https://p1.music.126.net/cover.jpg')
  assert.equal(snapshot.seekable, true)
  assert.equal(snapshot.iconStyle, 'nerd')
  assert.deepEqual(parseAck('{"ok":true,"source":"tui"}'), { ok: true, source: 'tui' })

  const invalid = [
    'not json',
    '[]',
    '{"playing":true}',
    JSON.stringify({ ...JSON.parse(snapshotJson), positionMs: -1 }),
    JSON.stringify({ ...JSON.parse(snapshotJson), durationMs: 1.5 }),
    JSON.stringify({ ...JSON.parse(snapshotJson), coverUrl: 42 }),
    JSON.stringify({ ...JSON.parse(snapshotJson), seekable: 'yes' }),
    JSON.stringify({ ...JSON.parse(snapshotJson), iconStyle: 'emoji' }),
    JSON.stringify({ ...JSON.parse(snapshotJson), source: 'gui' }),
  ]
  for (const source of invalid) {
    assert.throws(() => parseSnapshot(source), error => error instanceof YpmError && error.kind === 'protocol')
  }
  for (const source of ['{}', '{"ok":false,"source":"tui"}', '{"ok":true,"source":"gui"}']) {
    assert.throws(() => parseAck(source), error => error instanceof YpmError && error.kind === 'protocol')
  }
})

test('spectrum frames are versioned, bounded, and immutable', () => {
  const frame = parseSpectrumFrame(spectrumJson)
  assert.deepEqual(frame, {
    version: 1,
    style: 'braille',
    playing: true,
    bins: spectrumBins,
  })
  assert.equal(Object.isFrozen(frame), true)
  assert.equal(Object.isFrozen(frame.bins), true)

  const valid = JSON.parse(spectrumJson)
  const invalid = [
    'not json',
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, style: 'BRAILLE' }),
    JSON.stringify({ ...valid, playing: 'yes' }),
    JSON.stringify({ ...valid, bins: spectrumBins.slice(1) }),
    JSON.stringify({ ...valid, bins: [...spectrumBins, 0] }),
    JSON.stringify({ ...valid, bins: spectrumBins.with(0, -1) }),
    JSON.stringify({ ...valid, bins: spectrumBins.with(0, 256) }),
    JSON.stringify({ ...valid, bins: spectrumBins.with(0, 0.5) }),
  ]
  for (const source of invalid) {
    assert.throws(
      () => parseSpectrumFrame(source),
      error => error instanceof YpmError && error.kind === 'protocol',
    )
  }
})

test('YpmClient opens one public spectrum stream and fails closed on malformed frames', async () => {
  const calls = []
  const seen = []
  const signal = new AbortController().signal
  const spectrumRunner = async (executable, argv, options, onLine) => {
    calls.push({ executable, argv, options })
    onLine(spectrumJson)
    onLine('not json')
  }
  const client = new YpmClient({ executable: '/opt/bin/ypm', spectrumRunner })

  await assert.rejects(
    client.watchSpectrum(frame => seen.push(frame), signal, 10),
    error => error instanceof YpmError && error.kind === 'protocol',
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].executable, '/opt/bin/ypm')
  assert.deepEqual(calls[0].argv, ['--json', '--tui', 'spectrum', '--fps', '10'])
  assert.equal(calls[0].options.signal.aborted, false)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].style, 'braille')

  for (const fps of [0, 21, 1.5, Number.NaN]) {
    await assert.rejects(
      client.watchSpectrum(() => {}, undefined, fps),
      error => error instanceof YpmError && error.kind === 'protocol',
    )
  }
  assert.equal(calls.length, 1)
})

test('spawnSpectrumRunner splits NDJSON chunks and flushes the final line', async () => {
  const lines = []
  await spawnSpectrumRunner(process.execPath, [
    '-e',
    "process.stdout.write('{\"frame\":'); process.stdout.write('1}\\n\\n{\"frame\":2}')",
  ], {}, line => lines.push(line))
  assert.deepEqual(lines, ['{"frame":1}', '{"frame":2}'])
})

test('spawnSpectrumRunner rejects an invalid unterminated final frame', async () => {
  await assert.rejects(
    spawnSpectrumRunner(process.execPath, [
      '-e',
      "process.stdout.write('not-json')",
    ], {}, line => parseSpectrumFrame(line)),
    error => error instanceof YpmError && error.kind === 'protocol',
  )
})

test('YpmClient coalesces a frame burst to the latest value at the requested cadence', async () => {
  const controller = new AbortController()
  const seen = []
  const spectrumRunner = async (_executable, _argv, options, onLine) => {
    for (let value = 0; value <= 10 && !options.signal.aborted; value += 1) {
      onLine(JSON.stringify({
        version: 1,
        style: 'blocks',
        playing: true,
        bins: spectrumBins.with(0, value),
      }))
    }
    if (options.signal.aborted) throw new YpmError('aborted', 'cancelled')
    await new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new YpmError('aborted', 'cancelled')), {
        once: true,
      })
    })
  }
  const client = new YpmClient({ spectrumRunner })

  const watching = client.watchSpectrum(frame => {
    seen.push(frame.bins[0])
    if (seen.length === 2) controller.abort()
  }, controller.signal, 20)

  await assert.rejects(watching, error => error instanceof YpmError && error.kind === 'aborted')
  assert.deepEqual(seen, [0, 10])
})

test('YpmClient rejects a producer that exceeds its bounded input burst', async () => {
  const spectrumRunner = async (_executable, _argv, _options, onLine) => {
    for (let index = 0; index < 100; index += 1) onLine(spectrumJson)
  }
  const client = new YpmClient({ spectrumRunner })

  await assert.rejects(
    client.watchSpectrum(() => {}, undefined, 20),
    error => error instanceof YpmError
      && error.kind === 'protocol'
      && /frame rate/u.test(error.message),
  )
})

test('spawnSpectrumRunner aborts children and rejects oversized frames', async () => {
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  await assert.rejects(
    spawnSpectrumRunner(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      signal: alreadyAborted.signal,
    }, () => {}),
    error => error instanceof YpmError && error.kind === 'aborted',
  )
  assert.equal(getEventListeners(alreadyAborted.signal, 'abort').length, 0)

  const controller = new AbortController()
  const active = spawnSpectrumRunner(process.execPath, [
    '-e',
    'setInterval(() => {}, 1000)',
  ], { signal: controller.signal }, () => {})
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(active, error => error instanceof YpmError && error.kind === 'aborted')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)

  await assert.rejects(
    spawnSpectrumRunner(process.execPath, [
      '-e',
      "process.stdout.write('x'.repeat(2049)); setInterval(() => {}, 1000)",
    ], {}, () => {}),
    error => error instanceof YpmError && error.kind === 'protocol',
  )
})

test('external metadata cannot inject terminal controls', () => {
  const snapshot = parseSnapshot(JSON.stringify({
    ...JSON.parse(snapshotJson),
    title: '\u001b[31mRed\u001b[0m\nSong',
    artist: 'Artist\u0007',
  }))
  assert.equal(snapshot.title, 'Red Song')
  assert.equal(snapshot.artist, 'Artist')
  assert.equal(playbackLine(snapshot), '▶ Red Song · Artist')
  assert.equal(cleanExternalText('\u001b]0;owned\u0007hello\tworld'), 'hello world')
})

test('idle and paused snapshots format without inventing metadata', () => {
  const idle = parseSnapshot(JSON.stringify({
    playing: false,
    title: null,
    artist: null,
    album: null,
    positionMs: 0,
    durationMs: null,
    source: 'tui',
  }))
  assert.equal(idle.coverUrl, null)
  assert.equal(idle.seekable, false)
  assert.equal(idle.iconStyle, 'unicode')
  assert.equal(playbackLine(idle), undefined)
  assert.equal(playbackLine({ ...idle, title: 'Silhouette' }), '⏸ Silhouette')
})

test('seek rejects invalid positions before spawning ypm', async () => {
  let calls = 0
  const client = new YpmClient({
    runner: async () => {
      calls += 1
      return { stdout: '{"ok":true,"source":"tui"}', stderr: '' }
    },
  })

  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      client.seek(value),
      error => error instanceof YpmError && error.kind === 'protocol',
    )
  }
  assert.equal(calls, 0)
})

test('execFileRunner classifies missing executables and hard timeouts', async () => {
  await assert.rejects(
    execFileRunner('/definitely/missing/dsh-music-tui-ypm', [], { timeoutMs: 100 }),
    error => error instanceof YpmError && error.kind === 'not-found',
  )
  await assert.rejects(
    execFileRunner(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { timeoutMs: 20 }),
    error => error instanceof YpmError && error.kind === 'timeout',
  )
})

test('execFileRunner aborts an active child process', async () => {
  const controller = new AbortController()
  const operation = execFileRunner(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 1000)'],
    { timeoutMs: 2000, signal: controller.signal },
  )
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(operation, error => error instanceof YpmError && error.kind === 'aborted')
})

test('execFileRunner cleans up after a synchronous spawn error', async () => {
  const signal = new AbortController().signal
  for (let index = 0; index < 12; index += 1) {
    await assert.rejects(
      execFileRunner('\0', [], { timeoutMs: 1000, signal }),
      error => error instanceof YpmError && error.kind === 'process',
    )
  }
  assert.equal(getEventListeners(signal, 'abort').length, 0)
})
