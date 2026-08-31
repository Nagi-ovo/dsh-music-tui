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
  playbackLine,
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
