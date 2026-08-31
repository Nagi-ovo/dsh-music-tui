import assert from 'node:assert/strict'
import test from 'node:test'
import { MusicController } from '../lib/music-controller.js'
import { createMusicCommand, parseMusicCommand } from '../lib/music-command.js'
import { YpmError } from '../lib/ypm-client.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const snapshot = Object.freeze({
  playing: true,
  title: '春日影',
  artist: 'CRYCHIC',
  album: null,
  positionMs: 1000,
  durationMs: 2000,
  coverUrl: null,
  seekable: true,
  iconStyle: 'unicode',
  source: 'tui',
})

test('polling never overlaps and dispose aborts the active request', async () => {
  let active = 0
  let maxActive = 0
  let calls = 0
  const releases = []
  const client = {
    status: signal => new Promise((resolve, reject) => {
      calls += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      let settled = false
      const settle = callback => {
        if (settled) return
        settled = true
        active -= 1
        callback()
      }
      signal.addEventListener('abort', () => settle(() => reject(new YpmError('aborted', 'cancelled'))), { once: true })
      releases.push(() => settle(() => resolve(snapshot)))
    }),
  }
  const controller = new MusicController(client, 10)
  const stop = controller.startPolling(() => {})

  await sleep(20)
  assert.equal(calls, 1)
  releases.shift()()
  await sleep(25)
  assert.equal(calls, 2)
  assert.equal(maxActive, 1)

  controller.dispose()
  await sleep(5)
  assert.equal(active, 0)
  stop()
})

test('foreground controls are serialized and refresh status after each ack', async () => {
  const calls = []
  const client = {
    control: async command => {
      calls.push(command)
      await sleep(5)
      return { ok: true, source: 'tui' }
    },
    status: async () => {
      calls.push('status')
      return snapshot
    },
  }
  const controller = new MusicController(client, 1000)
  const [next, prev] = await Promise.all([
    controller.control('next'),
    controller.control('prev'),
  ])

  assert.deepEqual(calls, ['next', 'status', 'prev', 'status'])
  assert.equal(next.ack.ok, true)
  assert.equal(prev.snapshot.title, '春日影')
  controller.dispose()
})

test('seek is serialized with controls and refreshes the shared snapshot', async () => {
  const calls = []
  const client = {
    control: async command => {
      calls.push(command)
      return { ok: true, source: 'tui' }
    },
    seek: async positionMs => {
      calls.push(`seek:${positionMs}`)
      return { ok: true, source: 'tui' }
    },
    status: async () => {
      calls.push('status')
      return snapshot
    },
  }
  const controller = new MusicController(client, 1000)
  const [seek, next] = await Promise.all([
    controller.seek(1250),
    controller.control('next'),
  ])

  assert.deepEqual(calls, ['seek:1250', 'status', 'next', 'status'])
  assert.equal(seek.snapshot.positionMs, 1000)
  assert.equal(next.ack.ok, true)
  controller.dispose()
})

test('an accepted mutation remains accepted when its follow-up status fails', async () => {
  const client = {
    control: async () => ({ ok: true, source: 'tui' }),
    status: async () => { throw new YpmError('process', 'offline') },
  }
  const controller = new MusicController(client, 1000)
  const result = await controller.control('next')
  assert.deepEqual(result, { ack: { ok: true, source: 'tui' } })
  controller.dispose()
})

test('a rejected control does not count as a failed status read', async () => {
  const controller = new MusicController({
    control: async () => { throw new YpmError('process', 'control failed') },
  }, 1000)
  controller.failureCount = 1
  await assert.rejects(controller.control('next'), error => error?.message === 'control failed')
  assert.equal(controller.failureCount, 1)
  controller.dispose()
})

test('one failed read keeps the last snapshot and a second clears it', async () => {
  const outcomes = [
    snapshot,
    new YpmError('process', 'offline once'),
    new YpmError('process', 'offline twice'),
    { ...snapshot, title: '回復' },
  ]
  const client = {
    status: async () => {
      const outcome = outcomes.shift()
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  }
  const seen = []
  const controller = new MusicController(client, 60_000)
  controller.sink = value => seen.push(value)

  await controller.status()
  await assert.rejects(controller.status(), error => error?.message === 'offline once')
  assert.deepEqual(seen, [snapshot])
  await assert.rejects(controller.status(), error => error?.message === 'offline twice')
  assert.deepEqual(seen, [snapshot, undefined])
  await controller.status()
  assert.equal(seen.at(-1)?.title, '回復')
  controller.dispose()
})

test('offline backoff never polls faster than the configured cadence', () => {
  const controller = new MusicController({}, 30_000)
  controller.failureCount = 2
  assert.equal(controller.failureDelay(), 30_000)
  controller.failureCount = 20
  assert.equal(controller.failureDelay(), 30_000)
  controller.dispose()
})

test('music command grammar is deliberately small', () => {
  assert.equal(parseMusicCommand(''), 'show')
  assert.equal(parseMusicCommand(' show '), 'show')
  assert.equal(parseMusicCommand('hide'), 'hide')
  assert.equal(parseMusicCommand(' status '), 'status')
  assert.equal(parseMusicCommand('NEXT'), 'next')
  assert.deepEqual(parseMusicCommand('seek 90.5'), { kind: 'seek', positionMs: 90_500 })
  assert.equal(parseMusicCommand('seek -1'), 'invalid')
  assert.equal(parseMusicCommand('seek nope'), 'invalid')
  assert.equal(parseMusicCommand('pause'), 'invalid')
  assert.equal(parseMusicCommand('next extra'), 'invalid')
})

test('command results describe queued controls without claiming completion', async () => {
  const fakeController = {
    status: async () => snapshot,
    control: async () => ({ ack: { ok: true, source: 'tui' }, snapshot }),
    seek: async () => ({ ack: { ok: true, source: 'tui' }, snapshot }),
  }
  const command = createMusicCommand(fakeController)
  const signal = new AbortController().signal

  assert.deepEqual(await command.handler({ rawInput: '', signal }), {
    kind: 'success',
    text: '▶ 春日影 · CRYCHIC · 0:01/0:02',
  })
  assert.deepEqual(await command.handler({ rawInput: ' next', signal }), {
    kind: 'success',
    text: 'Sent next to YesPlayMusic TUI · ▶ 春日影 · CRYCHIC',
  })
  assert.deepEqual(await command.handler({ rawInput: 'seek 1.25', signal }), {
    kind: 'success',
    text: 'Sent seek to YesPlayMusic TUI · ▶ 春日影 · CRYCHIC',
  })
  assert.deepEqual(await command.handler({ rawInput: 'pause', signal }), {
    kind: 'error',
    text: 'Usage: /music [show|hide|status|prev|toggle|next|seek <seconds>]',
  })
})

test('a refused bar registration falls back to a detailed one-shot result', async () => {
  const fakeController = {
    status: async () => snapshot,
  }
  const display = {
    show: async () => ({ snapshot, displayed: false }),
  }
  const command = createMusicCommand(fakeController, display)

  assert.deepEqual(await command.handler({
    rawInput: 'show',
    signal: new AbortController().signal,
  }), {
    kind: 'success',
    text: '▶ 春日影 · CRYCHIC · 0:01/0:02',
  })
})
