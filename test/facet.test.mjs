import assert from 'node:assert/strict'
import test from 'node:test'
import facet from '../lib/facet.js'
import { exposeMusicController } from '../lib/runtime-bridge.js'

const snapshot = Object.freeze({
  playing: true,
  title: '迷星叫',
  artist: 'MyGO!!!!!',
  album: '迷跡波',
  positionMs: 12_000,
  durationMs: 180_000,
  coverUrl: null,
  source: 'tui',
})

test('standard facet publishes an executable /music command', async () => {
  const cleanups = []
  let publication
  const hideController = exposeMusicController({
    status: async () => snapshot,
    control: async () => ({ ack: { ok: true, source: 'tui' }, snapshot }),
  })
  const context = {
    scope: {
      signal: new AbortController().signal,
      add(dispose) {
        cleanups.push(dispose)
        return dispose
      },
    },
    extensions: {
      publish(reference, name, handler) {
        publication = { reference, name, handler }
        return () => {}
      },
    },
  }

  try {
    await facet.activate(context)
    assert.deepEqual(publication.reference, {
      apiVersion: 'commands.dsh/v1alpha1',
      kind: 'Command',
    })
    assert.equal(publication.name, 'music')
    assert.deepEqual(await publication.handler.execute(
      { rawInput: '' },
      { signal: new AbortController().signal },
    ), { kind: 'success', text: '▶ 迷星叫 · MyGO!!!!! · 迷跡波 · 0:12/3:00' })
  } finally {
    for (const dispose of cleanups.reverse()) await dispose()
    hideController()
  }
})
