import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import {
  formatDuration,
  MusicControlPendingError,
  type MusicDisplay,
} from './music-bar.js'
import type { MusicController } from './music-controller.js'
import {
  describeYpmError,
  playbackLine,
  type YpmControlCommand,
  type YpmSnapshot,
} from './ypm-client.js'

export function createMusicCommand(
  controller: MusicController,
  display?: MusicDisplay,
): CommandDefinition {
  return {
    name: 'music',
    description: 'Show or control YesPlayMusic TUI playback',
    input: { hint: 'show | hide | status | prev | toggle | next | seek <seconds>' },
    handler: ({ rawInput, signal }) => executeMusicCommand(controller, rawInput, signal, display),
  }
}

export async function executeMusicCommand(
  controller: MusicController,
  rawInput: string,
  signal: AbortSignal,
  display?: MusicDisplay,
): Promise<CommandResult> {
  const command = parseMusicCommand(rawInput)
  if (command === 'invalid') {
    return { kind: 'error', text: 'Usage: /music [show|hide|status|prev|toggle|next|seek <seconds>]' }
  }
  try {
    if (command === 'show') {
      if (display === undefined) {
        return { kind: 'success', text: describeSnapshot(await controller.status(signal)) }
      }
      const result = await display.show(signal)
      return result.displayed
        ? { kind: 'success', text: '' }
        : { kind: 'success', text: describeSnapshot(result.snapshot) }
    }
    if (command === 'hide') {
      if (display === undefined) {
        return { kind: 'error', text: 'The music bar is unavailable in this host' }
      }
      display.hide()
      return { kind: 'success', text: '' }
    }
    if (command === 'status') {
      return { kind: 'success', text: describeSnapshot(await controller.status(signal)) }
    }
    const result = typeof command === 'object'
      ? display === undefined
        ? await controller.seek(command.positionMs, signal)
        : await display.seek(command.positionMs, signal)
      : display === undefined
        ? await controller.control(command, signal)
        : await display.control(command, signal)
    const current = result.snapshot === undefined ? undefined : playbackLine(result.snapshot)
    return {
      kind: 'success',
      text: `Sent ${typeof command === 'object' ? 'seek' : command} to YesPlayMusic TUI${current === undefined ? '' : ` · ${current}`}`,
    }
  } catch (error) {
    if (error instanceof MusicControlPendingError) {
      return { kind: 'error', text: 'A music control is already in progress' }
    }
    return { kind: 'error', text: describeYpmError(error) }
  }
}

export type MusicCommand =
  | 'show'
  | 'hide'
  | 'status'
  | YpmControlCommand
  | { readonly kind: 'seek'; readonly positionMs: number }
  | 'invalid'

export function parseMusicCommand(rawInput: string): MusicCommand {
  const input = rawInput.trim()
  if (input === '') return 'show'
  const words = input.split(/\s+/u)
  if (words.length === 2 && words[0]?.toLowerCase() === 'seek') {
    const seconds = Number(words[1])
    const positionMs = seconds * 1000
    return Number.isFinite(positionMs) && Number.isSafeInteger(positionMs) && positionMs >= 0
      ? { kind: 'seek', positionMs }
      : 'invalid'
  }
  if (words.length !== 1) return 'invalid'
  const command = words[0]?.toLowerCase()
  return command === 'show'
    || command === 'hide'
    || command === 'status'
    || command === 'toggle'
    || command === 'next'
    || command === 'prev'
    ? command
    : 'invalid'
}

function describeSnapshot(snapshot: YpmSnapshot): string {
  const basic = playbackLine(snapshot)
  if (basic === undefined) return 'YesPlayMusic TUI is connected with no current track'
  const details = [snapshot.album]
  if (snapshot.durationMs === null) {
    details.push(formatDuration(snapshot.positionMs))
  } else {
    details.push(`${formatDuration(snapshot.positionMs)}/${formatDuration(snapshot.durationMs)}`)
  }
  return `${basic} · ${details.filter((value): value is string => Boolean(value)).join(' · ')}`
}
