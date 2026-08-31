import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-harness-tui/dsh-tui/extensions'
import type {} from '@deepseek-harness-tui/dsh-tui/plugin-host'
import { createMusicCommand } from './music-command.js'
import { MusicController } from './music-controller.js'
import { createMusicStatus } from './music-status.js'
import type { MusicSpectrumStyle } from './music-spectrum.js'
import {
  attachLegacyCommand,
  exposeMusicController,
} from './runtime-bridge.js'
import { YpmClient } from './ypm-client.js'

export const name = 'dsh-music-tui'
const COMMAND_CONTRIBUTION_ID = 'com.dsh-tui-ecosystem.music.command.music'

export interface Config {
  /** ypm executable name or absolute path. */
  executable?: string
  /** Enable the now-playing bar opened by /music. */
  showStatus?: boolean
  /** Online polling cadence. */
  pollIntervalMs?: number
  /** Hard deadline for one ypm process. */
  timeoutMs?: number
  /** Compact spectrum style; follow reuses supported YPM choices. */
  spectrumStyle?: MusicSpectrumStyle
}

export const Config: Schema<Config> = Schema.object({
  executable: Schema.string().default('ypm'),
  showStatus: Schema.boolean().default(true),
  pollIntervalMs: Schema.number().min(1000).max(60_000).step(500).default(3000),
  timeoutMs: Schema.number().min(250).max(30_000).step(250).default(3000),
  spectrumStyle: Schema.union(['off', 'follow', 'blocks', 'led', 'braille', 'shade']).default('follow'),
})

export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const client = new YpmClient({
    executable: resolved.executable,
    timeoutMs: resolved.timeoutMs,
  })
  const controller = new MusicController(client, resolved.pollIntervalMs)
  const status = ctx.get('tuiStatus', false)
  const display = status === undefined || !resolved.showStatus
    ? undefined
    : createMusicStatus(ctx, status, controller, resolved.spectrumStyle)
  ctx.effect(() => {
    const hideController = exposeMusicController(controller, display)
    return () => {
      hideController()
      display?.dispose()
      controller.dispose()
    }
  }, 'dsh-music-tui controller')

  const commands = ctx.get('commands', false)
  if (commands !== undefined) {
    ctx.effect(
      () => attachLegacyCommand(() => registerMusicCommand(ctx, createMusicCommand(controller, display))),
      'dsh-music-tui command',
    )
  }
}

function registerMusicCommand(
  ctx: Context,
  definition: ReturnType<typeof createMusicCommand>,
): (() => void) | undefined {
  const host = ctx.get('tuiPluginHost', false)
  if (host !== undefined) {
    try {
      return host.registerCommand(ctx, COMMAND_CONTRIBUTION_ID, definition)
    } catch (error) {
      if (!isComponentNotAdmitted(error)) {
        ctx.logger.warn(`dsh-music-tui: managed /music registration failed: ${errorMessage(error)}`)
        return undefined
      }
    }
  }

  const commands = ctx.get('commands', false)
  if (commands === undefined) {
    ctx.logger.warn('dsh-music-tui: commands service unavailable; /music was not registered')
    return undefined
  }
  try {
    return commands.register(definition)
  } catch (error) {
    ctx.logger.warn(`dsh-music-tui: /music registration failed: ${errorMessage(error)}`)
    return undefined
  }
}

function isComponentNotAdmitted(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'COMPONENT_NOT_ADMITTED'
}

function resolveConfig(config: Config): Required<Config> {
  return {
    executable: config.executable?.trim() || 'ypm',
    showStatus: config.showStatus ?? true,
    pollIntervalMs: clamp(config.pollIntervalMs ?? 3000, 1000, 60_000),
    timeoutMs: clamp(config.timeoutMs ?? 3000, 250, 30_000),
    spectrumStyle: config.spectrumStyle ?? 'follow',
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
