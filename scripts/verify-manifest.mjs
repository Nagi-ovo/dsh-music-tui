import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineManifest, projectManifest } from '@dsh-std/manifest'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const manifest = defineManifest(JSON.parse(await readFile(resolve(root, 'dsh-plugin.json'), 'utf8')))
const bundlePatch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')

assert.equal(manifest.version, packageJson.version, 'manifest and package versions must match')
const projected = projectManifest(manifest)
const host = projected.spec.facets.find(candidate => candidate.name === 'host')
assert(host, 'manifest must project a host facet')
assert(host.extensions?.some(extension =>
  extension.apiVersion === 'commands.dsh/v1alpha1'
  && extension.kind === 'Command'
  && extension.metadata.name === 'music'
), 'manifest must project the /music command')

const namespace = await import(pathToFileURL(resolve(root, manifest.facets.host.entry)).href)
const facet = namespace.default ?? namespace.facet
assert(facet && typeof facet.activate === 'function', 'host entry must export a FacetModule as default')
assert.match(
  bundlePatch,
  /- id: dsh-music-tui\n\s+name: '@dsh-tui-ecosystem\/music'\n\s+inject: \[tuiStatus\]/u,
  'Cordis mount must wait for tuiStatus before taking its optional service snapshot',
)

process.stdout.write(`manifest ok: ${manifest.id}@${manifest.version} · /music · ${manifest.facets.host.entry}\n`)
