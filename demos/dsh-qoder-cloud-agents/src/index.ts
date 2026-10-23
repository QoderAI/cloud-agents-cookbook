/**
 * Profile-named Qoder Cloud Agents subagent provider. Every accepted run
 * creates a Qoder Cloud session — mounting the delegating workspace's git
 * repository when there is one — sends the task, and returns the cloud
 * agent's final message to the parent when the turn settles.
 *
 * The environment and agent come from explicit config; otherwise the first
 * interactive delegation asks the user and saves the answer to the profile
 * (see ./target.ts), and `/qoder-cloud-agents` changes it later.
 *
 * @module dsh-qoder-cloud-agents
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  NO_START_CAPABILITIES,
  assertPositiveFinite,
  assertUsableCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-llm'
import { DEFAULT_BASE_URL, QoderCloudClient } from './client.ts'
import { CLOUD_PROVIDER, QoderCloudAdapter, type CloudTurnContext } from './cloud-mode.ts'
import { qoderCloudCommand } from './command.ts'
import { DEFAULT_TIMEOUT_MS, startQoderCloudRun } from './run.ts'
import { TargetResolver, type Asker, type Selection } from './target.ts'

export { QoderCloudClient, QoderCloudError } from './client.ts'
export { detectRepository, httpsRemote } from './git.ts'
export { SelectionRequiredError } from './target.ts'
export { CLOUD_MODEL, CLOUD_PRESET_ID, CLOUD_PROVIDER, QoderCloudAdapter } from './cloud-mode.ts'

export const name = 'qoder-cloud-agents'
export const inject = ['subagents']

const DEFAULT_PROVIDER_NAME = 'qoder-cloud-agents'
const DEFAULT_AGENT_NAME = 'dsh-qoder-cloud-delegate'
/** Row id this package's bundle patch inserts; fallback when no Loader entry is known. */
const DEFAULT_ENTRY_ID = 'qoder-cloud-agents'
const MAX_TIMER_DELAY_MS = 2_147_483_647

const DEFAULT_SYSTEM = [
  'You are a coding agent running in a Qoder Cloud sandbox on behalf of another agent (DeepSeek Harness).',
  'Work autonomously: nobody can answer questions mid-task.',
  'Your final message is returned verbatim to the delegating agent, so make it a self-contained report.',
].join(' ')

export interface Config {
  /** Provider name on `ctx.subagents` (default `qoder-cloud-agents`). */
  providerName?: string
  /** Gateway base URL (default `https://api.qoder.com/api/v1/cloud`). */
  baseURL?: string
  /** Credential / environment variable holding the Qoder PAT (default `QODER_PAT`). */
  tokenEnv?: string
  /** Literal PAT; prefer {@link tokenEnv} so no secret enters configuration files. */
  token?: string
  /** Cloud agent (`agent_…`); unset: the plugin-managed agent, or ask in an interactive UI. Live-editable. */
  agentId?: Volatile<string | undefined>
  /** Name of the plugin-managed cloud agent. */
  agentName?: string
  /** Model of the plugin-managed cloud agent (default `ultimate`). */
  model?: string
  /** System prompt of the plugin-managed cloud agent. */
  system?: string
  /** Cloud environment (`env_…`); unset: ask in an interactive UI, fail when ambiguous headless. Live-editable. */
  environmentId?: Volatile<string | undefined>
  /** `auto` mounts the cwd's git `origin` in the sandbox; `none` sends the task only. */
  repository?: 'auto' | 'none'
  /**
   * Credential / environment variable holding a git token for clone and push (default `QODER_GIT_TOKEN`):
   * a GitHub PAT, or a personal access token of the repository's Git host.
   */
  gitTokenEnv?: string
  /** Account for authenticated non-GitHub repositories (your user name on that Git host); default: the origin URL's user. */
  gitUsername?: string
  /** Prefix of the branch the cloud agent pushes its changes to. */
  branchPrefix?: string
  /** Answer to tool calls paused by the cloud agent's `always_ask` policy. */
  toolConfirmation?: 'allow' | 'deny'
  /** Extra sandbox environment variables for every session. */
  environmentVariables?: Record<string, string>
  /** Archive the cloud session after the turn settles (default keeps it for inspection). */
  archiveOnFinish?: boolean
  /** Ceiling for one delegated turn in milliseconds (default 2 h). */
  timeoutMs?: number
  /** Extra gateway headers. */
  headers?: Record<string, string>
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  baseURL: z.string().min(1).default(DEFAULT_BASE_URL),
  tokenEnv: z.string().role('credential-ref').default('QODER_PAT'),
  token: z.string().role('secret'),
  agentId: z.string().min(1).volatile(),
  agentName: z.string().min(1).default(DEFAULT_AGENT_NAME),
  model: z.string().min(1).default('ultimate'),
  system: z.string().default(DEFAULT_SYSTEM),
  environmentId: z.string().min(1).volatile(),
  repository: z.union(['auto', 'none'] as const).default('auto'),
  gitTokenEnv: z.string().role('credential-ref').default('QODER_GIT_TOKEN'),
  gitUsername: z.string().min(1),
  branchPrefix: z.string().min(1).default('qoder-cloud-agents/'),
  toolConfirmation: z.union(['allow', 'deny'] as const).default('allow'),
  environmentVariables: z.dict(z.string()).default({}),
  archiveOnFinish: z.boolean().default(false),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  headers: z.dict(z.string()).default({}),
}) as z<Config>

/** Config after Cordis applied the schema defaults. */
type ResolvedConfig = Required<Omit<Config, 'token' | 'agentId' | 'environmentId' | 'gitUsername'>>
  & Pick<Config, 'token' | 'agentId' | 'environmentId' | 'gitUsername'>

/**
 * Resolve a secret by credential name: the credential seam when mounted, else
 * the launch environment. Resolved per run so rotation applies immediately.
 */
async function resolveSecret(ctx: Context, name: string): Promise<string | undefined> {
  const ref = credentialRef(name)
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = (await credentials.resolve(ref))?.value
    if (hit !== undefined && hit.length > 0) return hit
  }
  // Without a mounted launch environment this falls back to process.env.
  const ambient = launchEnvironmentOf(ctx).get(ref)?.value
  return ambient !== undefined && ambient.length > 0 ? ambient : undefined
}

/** Read a volatile field whether Cordis wrapped it or a caller passed a plain value. */
function live(value: Volatile<string | undefined> | string | undefined): string | undefined {
  if (value === undefined || typeof value === 'string') return value
  return value.get()
}

/**
 * The delegating workspace. dsh 0.2.1+ resolves `request.cwd`; 0.2.0 has no
 * such field, so fall back to the parent session's working directory.
 */
function requestCwd(ctx: Context, request: ResolvedSubagentStartRequest): string {
  const explicit = (request as { cwd?: unknown }).cwd
  if (typeof explicit === 'string') return explicit
  const session = (request.parent as { session?: unknown } | undefined)?.session
  return (session === undefined ? undefined : sessionCwd(ctx, session)) ?? process.cwd()
}

/** A session's working directory: the workingDirectory service, else its header. */
function sessionCwd(ctx: Context, session: unknown): string | undefined {
  const service = (ctx as unknown as { get(name: string): unknown }).get('workingDirectory') as
    { get?(session: unknown): unknown } | undefined
  const fromService = service?.get?.(session)
  if (typeof fromService === 'string') return fromService
  const header = (session as { header?: { cwd?: unknown } }).header
  return typeof header?.cwd === 'string' ? header.cwd : undefined
}

/** Live root agent of a dsh session, the one user questions must be addressed to. */
function rootAgentOf(ctx: Context, sessionId: string): { session: unknown } | undefined {
  const agents = (ctx as unknown as { get(name: string): unknown }).get('agents') as
    { roots?(): readonly { session: { id: unknown } }[] } | undefined
  return agents?.roots?.().find(agent => agent.session.id === sessionId)
}

class QoderCloudProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly resolver: TargetResolver,
    private readonly client: () => Promise<QoderCloudClient | string>,
  ) {}

  async start(request: ResolvedSubagentStartRequest) {
    const cwd = assertUsableCwd('qoder-cloud-agents', 'child cwd', requestCwd(this.ctx, request))
    const client = await this.client()
    if (typeof client === 'string') throw new Error(`qoder-cloud-agents: ${client}`)
    const questions = this.ctx.get('userQuestions')
    const asker: Asker | undefined = questions === undefined
      ? undefined
      : (items, signal) => questions.ask({ agent: request.parent, signal, questions: items })
    const gitToken = this.config.repository === 'auto'
      ? await resolveSecret(this.ctx, this.config.gitTokenEnv)
      : undefined
    return startQoderCloudRun({
      cwd,
      prompt: request.prompt,
      label: request.label,
      signal: request.signal,
    }, {
      client,
      resolveTarget: signal => this.resolver.resolve(client, asker, signal),
      repository: this.config.repository,
      gitToken,
      gitTokenEnv: this.config.gitTokenEnv,
      gitUsername: this.config.gitUsername,
      branchPrefix: this.config.branchPrefix,
      toolConfirmation: this.config.toolConfirmation,
      environmentVariables: this.config.environmentVariables,
      archiveOnFinish: this.config.archiveOnFinish,
      timeoutMs: this.config.timeoutMs,
      onError: (error, stopReason) => {
        this.ctx.logger.warn(`qoder-cloud-agents "${this.name}": run failed (${stopReason}): %o`, error)
      },
    })
  }
}

/**
 * Register one Profile-named Qoder Cloud provider and the `/qoder-cloud-agents` command.
 * @param ctx - context carrying the shared subagent service.
 * @param config - endpoint, credentials, agent / environment binding and run policy.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite('qoder-cloud-agents', 'timeoutMs', resolved.timeoutMs)
  if (resolved.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`qoder-cloud-agents: timeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  try {
    new URL(resolved.baseURL)
  } catch {
    throw new Error(`qoder-cloud-agents: baseURL is not a valid URL: ${resolved.baseURL}`)
  }

  const loaderEntryId = (ctx.fiber as { entry?: { options?: { id?: string } } }).entry?.options?.id
  const entryId = loaderEntryId ?? DEFAULT_ENTRY_ID
  const configured = (): Selection => ({
    environmentId: live(resolved.environmentId),
    agentId: live(resolved.agentId),
  })

  /** Save into this entry's profile layer through Settings (live: volatile fields). */
  const persist = async (selection: Selection): Promise<boolean> => {
    const settings = ctx.get('settings')
    if (settings === undefined) return false
    const ops = Object.entries(selection).map(([key, value]) => value === undefined
      ? { op: 'unset' as const, path: [key] }
      : { op: 'set' as const, path: [key], value })
    if (ops.length === 0) return true
    try {
      if (!settings.describe().some(form => form.ns === entryId)) return false
      await settings.mutate(entryId, ops)
      return true
    } catch (error: unknown) {
      ctx.logger.warn('qoder-cloud-agents: could not save the selection to the profile: %o', error)
      return false
    }
  }

  const client = async (): Promise<QoderCloudClient | string> => {
    const token = resolved.token ?? await resolveSecret(ctx, resolved.tokenEnv)
    if (token === undefined) {
      return `no Qoder PAT — set ${resolved.tokenEnv} (environment, .env, or dsh credentials)`
    }
    return new QoderCloudClient({ baseURL: resolved.baseURL, token, headers: resolved.headers })
  }

  const resolver = new TargetResolver({
    configured,
    agentName: resolved.agentName,
    model: resolved.model,
    system: resolved.system,
    entryId,
    persist,
  })

  ctx.subagents.registerProvider(new QoderCloudProvider(resolved.providerName, ctx, resolved, resolver, client))

  // Cloud mode: the `qoder-cloud-agents` model route the 「云端模式」 preset pins.
  const turnContext = (sessionId: string | undefined): CloudTurnContext => {
    const agent = sessionId === undefined ? undefined : rootAgentOf(ctx, sessionId)
    const questions = ctx.get('userQuestions')
    return {
      cwd: agent === undefined ? undefined : sessionCwd(ctx, agent.session),
      asker: agent === undefined || questions === undefined
        ? undefined
        : (items, signal) => questions.ask({ agent: agent as never, signal, questions: items }),
    }
  }
  ctx.inject(['llm'], (scope) => {
    scope.llm.registerAdapter([CLOUD_PROVIDER], new QoderCloudAdapter({
      client,
      resolver,
      turnContext,
      repository: resolved.repository,
      gitToken: () => resolveSecret(ctx, resolved.gitTokenEnv),
      gitTokenEnv: resolved.gitTokenEnv,
      gitUsername: resolved.gitUsername,
      branchPrefix: resolved.branchPrefix,
      toolConfirmation: resolved.toolConfirmation,
      environmentVariables: resolved.environmentVariables,
    }))
  })

  ctx.inject(['commands'], (scope) => {
    scope.commands.register(qoderCloudCommand({
      configured,
      baseURL: resolved.baseURL,
      client,
      resolver,
      persist,
      managedAgentName: resolved.agentName,
    }))
  })
}
