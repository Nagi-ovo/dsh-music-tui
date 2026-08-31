import assert from 'node:assert/strict'
import test from 'node:test'
import {
  attachLegacyCommand,
  claimStandardCommand,
} from '../lib/runtime-bridge.js'

test('standard command ownership yields and restores the legacy registration', () => {
  const events = []
  const detachLegacy = attachLegacyCommand(() => {
    events.push('mount legacy')
    return () => events.push('dispose legacy')
  })
  const releaseStandard = claimStandardCommand()
  assert.deepEqual(events, ['mount legacy', 'dispose legacy'])

  releaseStandard()
  assert.deepEqual(events, ['mount legacy', 'dispose legacy', 'mount legacy'])
  detachLegacy()
  assert.deepEqual(events, [
    'mount legacy',
    'dispose legacy',
    'mount legacy',
    'dispose legacy',
  ])
})
