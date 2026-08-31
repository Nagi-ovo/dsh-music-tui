import type { Context } from '@deepseek-ai/cordis'
import { Config, apply, name } from '@dsh-tui-ecosystem/music'

Config({ showStatus: true, spectrumStyle: 'braille' })
void (name satisfies 'dsh-music-tui')
void (apply satisfies (ctx: Context, config?: Config) => void)
