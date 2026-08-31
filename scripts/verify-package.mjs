import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
})
const report = JSON.parse(output)[0]
const files = new Set(report.files.map(file => file.path))

for (const required of [
  'package.json',
  'LICENSE',
  'README.md',
  'README_EN.md',
  'cordis.patch.yml',
  'dsh-plugin.json',
  'lib/index.js',
  'lib/index.d.ts',
  'lib/facet.js',
  'lib/music-command.js',
  'lib/music-bar.js',
  'lib/music-status.js',
  'lib/cover-art.js',
  'lib/runtime-bridge.js',
  'lib/ypm-client.js',
]) {
  assert(files.has(required), `package is missing ${required}`)
}
for (const file of files) {
  assert(!file.startsWith('src/'), `source file leaked into package: ${file}`)
  assert(!file.startsWith('test/'), `test file leaked into package: ${file}`)
  assert(!file.startsWith('node_modules/'), `dependency leaked into package: ${file}`)
}

const plugin = await import('../lib/index.js')
assert.equal(plugin.name, 'dsh-music-tui')
assert.equal(typeof plugin.apply, 'function')
assert.equal(typeof plugin.Config, 'function')
assert.deepEqual(Object.keys(plugin).sort(), ['Config', 'apply', 'name'])

const facet = await import('../lib/facet.js')
assert.equal(typeof facet.default?.activate, 'function')

const sourceMap = JSON.parse(await readFile(new URL('../lib/index.js.map', import.meta.url), 'utf8'))
assert(sourceMap.sourcesContent?.every(source => typeof source === 'string'), 'source maps must embed their sources')

process.stdout.write(`package ok: ${report.filename} · ${files.size} files\n`)
