import { defineFacet } from '@dsh-std/sdk'
import { executeMusicCommand } from './music-command.js'
import { MusicController } from './music-controller.js'
import {
  activeMusicRuntime,
  claimStandardCommand,
} from './runtime-bridge.js'
import { YpmClient } from './ypm-client.js'

const COMMAND_REFERENCE = Object.freeze({
  apiVersion: 'commands.dsh/v1alpha1',
  kind: 'Command',
})

const facet = defineFacet((context) => {
  const fallback = new MusicController(new YpmClient())
  context.scope.add(() => fallback.dispose())
  context.scope.add(claimStandardCommand())
  context.extensions.publish(COMMAND_REFERENCE, 'music', {
    execute(
      input: { readonly rawInput: string },
      invocation: { readonly signal: AbortSignal },
    ) {
      const runtime = activeMusicRuntime(fallback)
      return executeMusicCommand(runtime.controller, input.rawInput, invocation.signal, runtime.display)
    },
  })
})

export default facet
