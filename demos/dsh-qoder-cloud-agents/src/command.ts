/**
 * `/qoder-cloud-agents` — inspect and change the saved Qoder Cloud environment and
 * agent from an interactive dsh UI without involving the model.
 *
 *   /qoder-cloud-agents                  show the current binding
 *   /qoder-cloud-agents env              list environments
 *   /qoder-cloud-agents env <id|name>    use an environment (saved to the profile)
 *   /qoder-cloud-agents agent            list agents
 *   /qoder-cloud-agents agent <id|name>  use an agent; `new` uses the plugin-managed one
 *   /qoder-cloud-agents reset            forget both; the next delegation asks again
 *
 * @module dsh-qoder-cloud-agents/command
 */

import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { QoderCloudClient } from './client.ts'
import {
  describeEnvironment,
  matchByIdOrName,
  type Selection,
  type TargetResolver,
} from './target.ts'

export const COMMAND_NAME = 'qoder-cloud-agents'

type CommandResult = Awaited<ReturnType<CommandDefinition['handler']>>

export interface CommandDeps {
  readonly configured: () => Selection
  readonly baseURL: string
  /** Authenticated client, or an error message when no PAT resolves. */
  readonly client: () => Promise<QoderCloudClient | string>
  readonly resolver: TargetResolver
  /** Save (or with `undefined` values, clear) fields; false when not saved. */
  readonly persist: (selection: Selection) => Promise<boolean>
  readonly managedAgentName: string
}

const USAGE = [
  'Usage:',
  '  /qoder-cloud-agents                  show the current environment and agent',
  '  /qoder-cloud-agents env              list environments',
  '  /qoder-cloud-agents env <id|name>    use an environment',
  '  /qoder-cloud-agents agent            list agents',
  '  /qoder-cloud-agents agent <id|name>  use an agent (`new`: the plugin-managed agent)',
  '  /qoder-cloud-agents reset            forget both; the next delegation asks again',
].join('\n')

const saved = (ok: boolean): string => ok
  ? 'Saved to this profile.'
  : 'Applied for this process only: no settings service is available to save it; set it in the profile patch to keep it.'

/**
 * Build the command definition.
 * @param deps - configuration readers, client factory, resolver and persistence.
 */
export function qoderCloudCommand(deps: CommandDeps): CommandDefinition {
  return {
    name: COMMAND_NAME,
    description: 'Show or change the Qoder Cloud environment and agent used for delegated tasks',
    input: { hint: '[env|agent [<id|name>]|reset]' },
    handler: async ({ rawInput, signal }): Promise<CommandResult> => {
      const [sub = 'status', ...rest] = rawInput.trim().split(/\s+/).filter(Boolean)
      const argument = rest.join(' ')
      try {
        switch (sub) {
          case 'status':
            return await status(deps, signal)
          case 'env':
          case 'environment':
            return argument === '' ? await listEnvironments(deps, signal) : await useEnvironment(deps, argument, signal)
          case 'agent':
            return argument === '' ? await listAgents(deps, signal) : await useAgent(deps, argument, signal)
          case 'reset': {
            deps.resolver.forget()
            const ok = await deps.persist({ environmentId: undefined, agentId: undefined })
            return { kind: 'success', text: `Cleared the saved environment and agent; the next delegation will choose again.\n${saved(ok)}` }
          }
          case 'help':
            return { kind: 'success', text: USAGE }
          default:
            return { kind: 'error', text: `Unknown subcommand "${sub}".\n${USAGE}` }
        }
      } catch (error: unknown) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

async function clientOrError(deps: CommandDeps): Promise<QoderCloudClient> {
  const client = await deps.client()
  if (typeof client === 'string') throw new Error(client)
  return client
}

async function status(deps: CommandDeps, signal: AbortSignal): Promise<CommandResult> {
  const { environmentId, agentId } = deps.configured()
  const lines = [`Gateway: ${deps.baseURL}`]
  const client = await deps.client()
  if (typeof client === 'string') {
    lines.push(`Token: ${client}`)
  } else {
    const [envs, agents] = await Promise.all([client.listEnvironments(signal), client.listAgents(signal)])
    const env = envs.data.find(item => item.id === environmentId)
    const agent = agents.data.find(item => item.id === agentId)
    lines.push(environmentId === undefined
      ? 'Environment: not chosen (the next delegation asks, or uses the only environment)'
      : `Environment: ${env === undefined ? `${environmentId} (not found on the platform)` : `${env.name} (${env.id}) — ${describeEnvironment(env)}`}`)
    lines.push(agentId === undefined
      ? `Agent: not chosen (the next delegation uses "${deps.managedAgentName}" or asks)`
      : `Agent: ${agent === undefined ? `${agentId} (not found on the platform)` : `${agent.name} (${agent.id})`}`)
  }
  lines.push('', USAGE)
  return { kind: 'success', text: lines.join('\n') }
}

async function listEnvironments(deps: CommandDeps, signal: AbortSignal): Promise<CommandResult> {
  const client = await clientOrError(deps)
  const current = deps.configured().environmentId
  const envs = (await client.listEnvironments(signal)).data.filter(env => !env.archived_at)
  if (envs.length === 0) return { kind: 'success', text: 'No environments yet; the next delegation creates "dsh-default".' }
  const rows = envs.map(env => `${env.id === current ? '*' : ' '} ${env.id}  ${env.name}  (${describeEnvironment(env)})`)
  return { kind: 'success', text: ['Environments (* = current):', ...rows, '', 'Use one with /qoder-cloud-agents env <id>'].join('\n') }
}

async function useEnvironment(deps: CommandDeps, text: string, signal: AbortSignal): Promise<CommandResult> {
  const client = await clientOrError(deps)
  const envs = (await client.listEnvironments(signal)).data.filter(env => !env.archived_at)
  const match = matchByIdOrName(envs, text, 'environment')
  if (typeof match === 'string') return { kind: 'error', text: match }
  deps.resolver.remember({ environmentId: match.id })
  const ok = await deps.persist({ environmentId: match.id })
  const warning = match.config?.type === 'self_hosted'
    ? '\nNote: this is a self-hosted environment; delegations wait until one of its workers is online.'
    : ''
  return { kind: 'success', text: `Environment set to ${match.name} (${match.id}).${warning}\n${saved(ok)}` }
}

async function listAgents(deps: CommandDeps, signal: AbortSignal): Promise<CommandResult> {
  const client = await clientOrError(deps)
  const current = deps.configured().agentId
  const agents = (await client.listAgents(signal)).data.filter(agent => !agent.archived_at)
  const rows = agents.map(agent => `${agent.id === current ? '*' : ' '} ${agent.id}  ${agent.name}${typeof agent.model === 'string' ? `  (model ${agent.model})` : ''}`)
  return {
    kind: 'success',
    text: ['Agents (* = current):', ...rows, '', `Use one with /qoder-cloud-agents agent <id>, or /qoder-cloud-agents agent new for "${deps.managedAgentName}"`].join('\n'),
  }
}

async function useAgent(deps: CommandDeps, text: string, signal: AbortSignal): Promise<CommandResult> {
  const client = await clientOrError(deps)
  let agent
  if (text === 'new') {
    agent = await deps.resolver.createManagedAgent(client, signal)
  } else {
    const agents = (await client.listAgents(signal)).data.filter(item => !item.archived_at)
    const match = matchByIdOrName(agents, text, 'agent')
    if (typeof match === 'string') return { kind: 'error', text: match }
    agent = match
  }
  deps.resolver.remember({ agentId: agent.id })
  const ok = await deps.persist({ agentId: agent.id })
  return { kind: 'success', text: `Agent set to ${agent.name} (${agent.id}).\n${saved(ok)}` }
}
