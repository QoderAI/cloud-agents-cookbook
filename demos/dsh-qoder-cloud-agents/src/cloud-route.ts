/**
 * Child plugin of the 「云端模式」 agent preset: pins every model request of
 * the preset's agent to the `qoder-cloud-agents` route. Registered with `prepend` so
 * it stays the outermost `agent/request` listener and a manual model pick
 * cannot route a cloud-mode session back to a local model.
 *
 * It also pins the `{{provider}}` / `{{model}}` prompt variables of the
 * agent's system prompt to the route. They otherwise follow the session's
 * selected model, which is still the pre-toggle model on the first turn and the
 * cloud route afterwards, so the persona line ("powered by the {{model}} model")
 * changed between turns and the trace logged a spurious 「系统提示词已更新」.
 *
 * @module dsh-qoder-cloud-agents/cloud-route
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { CLOUD_MODEL, CLOUD_PROVIDER } from './cloud-constants.ts'

export const name = 'qoder-cloud-agents-route'

/**
 * Route the preset's agent to Qoder Cloud.
 * @param ctx - the preset's agent-scoped context.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/request', async (_payload, next): Promise<LlmCallConfig> => {
    // The cloud route has no reasoning levels or output cap of its own.
    const { reasoningEffort: _effort, maxTokens: _maxTokens, ...rest } = await next()
    return { ...rest, provider: CLOUD_PROVIDER, model: CLOUD_MODEL }
  }, { prepend: true })

  // The assembly waterfall's result is what gets rendered, so overriding the
  // variables here wins over every registered provider on every turn.
  ctx.on('system-prompt/assemble', async (_assembly, _context, next): Promise<PromptAssembly> => {
    const assembly = await next()
    return { ...assembly, variables: { ...assembly.variables, provider: CLOUD_PROVIDER, model: CLOUD_MODEL } }
  }, { prepend: true })
}
