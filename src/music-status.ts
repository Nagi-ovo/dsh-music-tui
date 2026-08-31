import type { Context } from '@deepseek-ai/cordis'
import {
  MusicBarPresenter,
  type MusicStatusViewService,
} from './music-bar.js'
import type { MusicController } from './music-controller.js'

type MusicStatusService = Pick<Context['tuiStatus'], 'set'>

export function createMusicStatus(
  owner: Context,
  status: MusicStatusService,
  controller: MusicController,
): MusicBarPresenter | undefined {
  if (!hasRegisterView(status)) return undefined
  return new MusicBarPresenter(owner, status, controller)
}

function hasRegisterView(
  status: MusicStatusService,
): status is MusicStatusService & MusicStatusViewService {
  return typeof (status as MusicStatusService & { readonly registerView?: unknown }).registerView === 'function'
}
