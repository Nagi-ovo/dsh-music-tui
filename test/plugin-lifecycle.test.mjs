import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import * as MusicPlugin from '../lib/index.js'
import { activeMusicRuntime } from '../lib/runtime-bridge.js'

test('Cordis activation registers and releases /music without requiring dsh-TUI internals', async () => {
  const root = new Context()
  let definition
  class Commands extends Service {
    constructor(ctx) {
      super(ctx, 'commands')
    }

    register(value) {
      definition = value
      return () => {
        if (definition === value) definition = undefined
      }
    }
  }

  const commandsFiber = root.plugin(Commands)
  await commandsFiber
  const pluginFiber = root.plugin(MusicPlugin, { showStatus: false })
  await pluginFiber

  assert.equal(definition?.name, 'music')
  assert.equal(
    definition?.input?.hint,
    'show | hide | status | prev | toggle | next | seek <seconds>',
  )
  assert.equal(Boolean(activeMusicRuntime({}).display), false)

  await pluginFiber.dispose()
  assert.equal(definition, undefined)
  await commandsFiber.dispose()
  await root.fiber.dispose()
})

test('the enabled music bar remains closed until /music opens it', async () => {
  const events = []
  const root = new Context()
  class Status extends Service {
    constructor(ctx) {
      super(ctx, 'tuiStatus')
    }

    set() {
      events.push('set')
      return () => events.push('dispose status')
    }

    registerView() {
      events.push('register view')
      return () => events.push('dispose view')
    }
  }

  const statusFiber = root.plugin(Status)
  await statusFiber
  const pluginFiber = root.plugin(MusicPlugin)
  await pluginFiber

  assert(activeMusicRuntime({}).display)
  assert.deepEqual(events, [])

  await pluginFiber.dispose()
  assert.deepEqual(events, [])
  await statusFiber.dispose()
  await root.fiber.dispose()
})

test('a legacy tuiStatus service does not create a persistent display', async () => {
  const events = []
  const root = new Context()
  class Status extends Service {
    constructor(ctx) {
      super(ctx, 'tuiStatus')
    }

    set() {
      events.push('set')
      return () => events.push('dispose status')
    }
  }

  const statusFiber = root.plugin(Status)
  await statusFiber
  const pluginFiber = root.plugin(MusicPlugin)
  await pluginFiber

  assert.equal(Boolean(activeMusicRuntime({}).display), false)
  assert.deepEqual(events, [])

  await pluginFiber.dispose()
  await statusFiber.dispose()
  await root.fiber.dispose()
})
