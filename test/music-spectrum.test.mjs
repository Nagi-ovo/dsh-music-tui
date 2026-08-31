import assert from 'node:assert/strict'
import test from 'node:test'
import {
  renderSpectrum,
  resampleBins,
  resolveSpectrumStyle,
  spectrumCells,
} from '../lib/music-spectrum.js'

const bins = Object.freeze(Array.from({ length: 32 }, (_, index) => (
  index < 8 ? 0 : index < 16 ? 64 : index < 24 ? 128 : 255
)))
const frame = Object.freeze({
  version: 1,
  style: 'blocks',
  playing: true,
  bins,
})

test('spectrum width grows on wide terminals without taking over the bar', () => {
  assert.deepEqual(
    [79, 80, 95, 96, 119, 120, 121, 122, 140, 168, 240].map(spectrumCells),
    [0, 12, 12, 18, 18, 24, 24, 25, 34, 48, 48],
  )
})

test('bin resampling preserves local peaks instead of averaging them away', () => {
  assert.deepEqual(resampleBins([0, 255, 0, 128], 2), [1, 128 / 255])
  assert.deepEqual(resampleBins([], 4), [])
  assert.deepEqual(resampleBins([255], 0), [])
})

test('compact renderers produce exactly three fixed-width rows', () => {
  const expected = {
    blocks: ['      ██', '    ▄▄██', '  ▆▆████'],
    led: ['      ●●', '    ●●●●', '  ●●●●●●'],
    braille: ['      ⣿⣿', '    ⣤⣤⣿⣿', '  ⣶⣶⣿⣿⣿⣿'],
    shade: ['      ██', '    ▓▓██', '  ██████'],
  }
  for (const [style, rows] of Object.entries(expected)) {
    assert.deepEqual(renderSpectrum(frame, style, 8), rows, style)
    assert.equal(rows.length, 3)
    assert(rows.every(row => [...row].length === 8))
  }
})

test('follow honors supported YPM styles and safely falls back to blocks', () => {
  assert.equal(resolveSpectrumStyle('follow', 'braille'), 'braille')
  assert.equal(resolveSpectrumStyle('follow', 'waterfall'), 'blocks')
  assert.equal(resolveSpectrumStyle('shade', 'waterfall'), 'shade')
  assert.equal(resolveSpectrumStyle('off', 'blocks'), undefined)
})
