import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { createMusicStatus } from '../lib/music-status.js'

const snapshot = Object.freeze({
  playing: false,
  title: '雨爱',
  artist: '杨丞琳',
  album: '雨爱',
  positionMs: 12_064,
  durationMs: 260_480,
  coverUrl: null,
  source: 'tui',
})

test('a legacy tuiStatus service does not create a presenter', () => {
  const presenter = createMusicStatus({}, {
    set() { throw new Error('legacy set must not be used') },
  }, {})
  assert.equal(presenter, undefined)
})

test('a rich status presenter keeps activation identity and cleans up polling and view', async () => {
  const events = []
  let sink
  const owner = {}
  const status = {
    set() { throw new Error('scalar status must not be used') },
    registerView(descriptor, identity) {
      events.push(['register', descriptor.key, descriptor.maxRows, identity])
      return () => events.push(['dispose view', descriptor.key])
    },
  }
  const controller = {
    startPolling(value) {
      sink = value
      events.push(['start polling'])
      return () => events.push(['stop polling'])
    },
    async status() {
      sink(snapshot)
      return snapshot
    },
  }
  const presenter = createMusicStatus(owner, status, controller)
  assert(presenter)

  assert.deepEqual(await presenter.show(), { snapshot, displayed: true })
  assert.deepEqual(events[0], [
    'register',
    'dsh-music-tui:playback',
    3,
    owner,
  ])
  presenter.dispose()
  assert.deepEqual(events.slice(1), [
    ['start polling'],
    ['stop polling'],
    ['dispose view', 'dsh-music-tui:playback'],
  ])
})

test('Cordis feature detection tolerates a legacy service with no rich view', async () => {
  const root = new Context()
  class Status extends Service {
    constructor(ctx) {
      super(ctx, 'tuiStatus')
    }

    set() {
      return () => {}
    }
  }

  const statusFiber = root.plugin(Status)
  await statusFiber
  const consumerFiber = root.plugin((ctx) => {
    const status = ctx.get('tuiStatus', false)
    assert(status)
    assert.equal(createMusicStatus(ctx, status, {}), undefined)
  })
  await consumerFiber

  await consumerFiber.dispose()
  await statusFiber.dispose()
  await root.fiber.dispose()
})
