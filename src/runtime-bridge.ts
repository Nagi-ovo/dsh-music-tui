import type { MusicDisplay } from './music-bar.js'
import type { MusicController } from './music-controller.js'

type Dispose = () => void
type LegacyCommandFactory = () => Dispose | undefined

interface LegacyCommandBinding {
  readonly mount: LegacyCommandFactory
  dispose: Dispose | undefined
}

export interface MusicRuntime {
  readonly controller: MusicController
  readonly display?: MusicDisplay
}

const runtimes: MusicRuntime[] = []
const legacyCommands = new Set<LegacyCommandBinding>()
let standardCommandClaims = 0

/** Share the configured Cordis controller with the portable facet when both loaders are present. */
export function exposeMusicController(controller: MusicController, display?: MusicDisplay): Dispose {
  const runtime: MusicRuntime = { controller, ...(display === undefined ? {} : { display }) }
  runtimes.push(runtime)
  return () => {
    const index = runtimes.lastIndexOf(runtime)
    if (index >= 0) runtimes.splice(index, 1)
  }
}

export function activeMusicController(fallback: MusicController): MusicController {
  return activeMusicRuntime(fallback).controller
}

export function activeMusicRuntime(fallback: MusicController): MusicRuntime {
  return runtimes.at(-1) ?? { controller: fallback }
}

/** Keep the legacy command live only while no standard facet owns the same contribution. */
export function attachLegacyCommand(mount: LegacyCommandFactory): Dispose {
  const binding: LegacyCommandBinding = { mount, dispose: undefined }
  legacyCommands.add(binding)
  reconcileLegacyCommand(binding)
  return () => {
    legacyCommands.delete(binding)
    binding.dispose?.()
    binding.dispose = undefined
  }
}

/** Atomically yield legacy command registrations before adapter-dsh publishes the standard one. */
export function claimStandardCommand(): Dispose {
  standardCommandClaims += 1
  if (standardCommandClaims === 1) {
    for (const binding of legacyCommands) {
      binding.dispose?.()
      binding.dispose = undefined
    }
  }
  let active = true
  return () => {
    if (!active) return
    active = false
    standardCommandClaims -= 1
    if (standardCommandClaims === 0) {
      for (const binding of legacyCommands) reconcileLegacyCommand(binding)
    }
  }
}

function reconcileLegacyCommand(binding: LegacyCommandBinding): void {
  if (standardCommandClaims > 0 || binding.dispose !== undefined) return
  binding.dispose = binding.mount()
}
