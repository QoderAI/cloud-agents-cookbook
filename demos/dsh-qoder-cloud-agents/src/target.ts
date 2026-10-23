/**
 * Which Qoder Cloud environment and agent a delegation runs on.
 *
 * Order: explicit profile config (`environmentId` / `agentId`, including a
 * choice saved by an earlier prompt) → this process's earlier choice →
 * an unambiguous default → asking the user through `ctx.userQuestions`.
 * Without anyone to ask (headless, or a nested delegation) an ambiguous
 * environment fails the delegation and names the candidates instead of
 * guessing.
 *
 * @module dsh-qoder-cloud-agents/target
 */

import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import {
  AGENT_TOOLSET,
  type AgentView,
  type CreateSessionRequest,
  type EnvironmentView,
  type QoderCloudClient,
} from './client.ts'

/** Name of the environment created when the account has no managed-cloud one. */
export const DEFAULT_ENVIRONMENT_NAME = 'dsh-default'

const ENVIRONMENT_QUESTION = 'qoder-cloud-agents-environment'
const AGENT_QUESTION = 'qoder-cloud-agents-agent'
const MAX_AGENT_OPTIONS = 20

/** Where a run is bound on the platform. */
export interface QoderCloudTarget {
  readonly agent: CreateSessionRequest['agent']
  readonly environmentId: string
  /** How the binding was chosen, surfaced in the run result. */
  readonly notes: readonly string[]
}

/** Ask the human; rejects with a `code`-carrying error when nobody can answer. */
export type Asker = (questions: AskUserQuestionItem[], signal: AbortSignal) => Promise<AskUserQuestionAnswer>

/** Fields persisted into this plugin's profile entry. */
export type Selection = { environmentId?: string | undefined; agentId?: string | undefined }

export interface TargetResolverOptions {
  /** Current explicit config (volatile: reflects saved choices live). */
  readonly configured: () => Selection
  readonly agentName: string
  readonly model: string
  readonly system: string
  /** Profile entry id, for configuration snippets in errors. */
  readonly entryId: string
  /** Save a choice to the profile; resolves false when it could not be saved. */
  readonly persist: (selection: Selection) => Promise<boolean>
}

/** User-question failures that mean "nobody can answer here". */
const UNANSWERABLE = new Set(['NO_PROVIDER', 'DELEGATED_CALLER', 'CALLER_NOT_LIVE'])

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

/** Usable environment: not archived. */
function active<T extends { archived_at?: string | null }>(items: readonly T[]): T[] {
  return items.filter(item => !item.archived_at)
}

/** The Qoder Cloud API defaults an environment's config to `{type: 'cloud'}`; only an explicit `self_hosted` is BYOC. */
function isManagedCloud(env: EnvironmentView): boolean {
  return env.config?.type !== 'self_hosted'
}

/** One-line summary of what an environment carries (packages, networking). */
export function describeEnvironment(env: EnvironmentView): string {
  const config = (env.config ?? {}) as {
    type?: string
    networking?: { type?: string }
    packages?: Record<string, unknown>
    setup_script?: unknown
  }
  if (config.type === 'self_hosted') {
    return `self-hosted (BYOC) · runs on your own workers, one must be online${config.setup_script !== undefined ? ' · setup script' : ''}`
  }
  const parts: string[] = [config.type ?? 'unknown type']
  const packages = Object.entries(config.packages ?? {})
    .filter(([, list]) => Array.isArray(list) && list.length > 0)
    .map(([manager, list]) => `${manager}: ${(list as unknown[]).slice(0, 4).join(', ')}${(list as unknown[]).length > 4 ? ', …' : ''}`)
  parts.push(packages.length > 0 ? packages.join('; ') : 'no extra packages')
  if (config.networking?.type !== undefined) parts.push(`network ${config.networking.type}`)
  if (config.setup_script !== undefined) parts.push('setup script')
  return parts.join(' · ')
}

const environmentLabel = (env: EnvironmentView): string => `${env.name} · ${env.id}`
const agentLabel = (agent: AgentView): string => `${agent.name} · ${agent.id}`

/**
 * Match free text (an id or an exact, unique name) against items.
 * @returns the match, or an error message.
 */
function matchByIdOrName<T extends { id: string; name: string }>(items: readonly T[], text: string, kind: string): T | string {
  const needle = text.trim()
  const byId = items.find(item => item.id === needle)
  if (byId !== undefined) return byId
  const byName = items.filter(item => item.name === needle)
  if (byName.length === 1) return byName[0]!
  if (byName.length > 1) return `several ${kind}s are named "${needle}"; use the id (${byName.map(item => item.id).join(', ')})`
  return `no active ${kind} matches "${needle}"`
}

/** Failure naming what to configure when the choice cannot be made here. */
export class SelectionRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SelectionRequiredError'
  }
}

function ambiguousEnvironment(candidates: readonly EnvironmentView[], entryId: string, reason: string): SelectionRequiredError {
  const lines = [
    candidates.length === 1
      ? `qoder-cloud-agents: the only Qoder Cloud environment is self-hosted (BYOC) and ${reason}.`
      : `qoder-cloud-agents: ${candidates.length} Qoder Cloud environments are available and ${reason}.`,
    'Choose one with `/qoder-cloud-agents env <id>` in an interactive dsh session, or set it in the profile patch:',
    '',
    `- id: ${entryId}`,
    '  config:',
    `    environmentId: ${candidates[0]?.id ?? 'env_…'}`,
    '',
    'Candidates:',
    ...candidates.map(env => `  ${env.id}  ${env.name}  (${describeEnvironment(env)})`),
  ]
  return new SelectionRequiredError(lines.join('\n'))
}

type EnvironmentPlan =
  | { kind: 'use'; env: EnvironmentView; why: string }
  | { kind: 'create' }
  | { kind: 'ask'; candidates: EnvironmentView[]; all: EnvironmentView[] }

type AgentPlan =
  | { kind: 'use'; agent: AgentView; why: string }
  | { kind: 'create' }
  | { kind: 'ask'; candidates: AgentView[]; all: AgentView[] }

/** Per-provider binding resolution; one selection at a time. */
export class TargetResolver {
  private memo: Selection = {}
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: TargetResolverOptions) {}

  /** Drop this process's remembered choice (after `/qoder-cloud-agents reset`). */
  forget(): void {
    this.memo = {}
  }

  /** Remember a choice made outside a run (the slash command). */
  remember(selection: Selection): void {
    this.memo = { ...this.memo, ...selection }
  }

  /**
   * Resolve the binding for one run. Concurrent runs queue so one prompt
   * answers them all.
   * @param client - authenticated platform client.
   * @param asker - human answerer, or `undefined` when none is mounted.
   * @param signal - run cancellation.
   */
  resolve(client: QoderCloudClient, asker: Asker | undefined, signal: AbortSignal): Promise<QoderCloudTarget> {
    const next = this.queue.then(() => this.resolveNow(client, asker, signal))
    this.queue = next.catch(() => {})
    return next
  }

  private async resolveNow(client: QoderCloudClient, asker: Asker | undefined, signal: AbortSignal): Promise<QoderCloudTarget> {
    const { options } = this
    const configured = options.configured()
    const environmentId = configured.environmentId ?? this.memo.environmentId
    const agentId = configured.agentId ?? this.memo.agentId
    if (environmentId !== undefined && agentId !== undefined) {
      return { environmentId, agent: agentId, notes: [] }
    }

    const envPlan: EnvironmentPlan | undefined = environmentId === undefined
      ? this.planEnvironment(active((await client.listEnvironments(signal)).data))
      : undefined
    const agentPlan: AgentPlan | undefined = agentId === undefined
      ? this.planAgent(active((await client.listAgents(signal)).data), asker !== undefined)
      : undefined

    const questions: AskUserQuestionItem[] = []
    if (envPlan?.kind === 'ask') {
      questions.push({
        id: ENVIRONMENT_QUESTION,
        header: 'Qoder Cloud',
        question: 'Which Qoder Cloud environment should delegated tasks run in?',
        detail: 'The environment sets where the sandbox runs, its preinstalled packages and network policy. '
          + 'Managed cloud environments run on Qoder; self-hosted (BYOC) ones run on your own workers and can reach '
          + 'networks those workers reach (e.g. an intranet Git host). '
          + 'The choice is saved to this profile; change it later with `/qoder-cloud-agents env`.',
        options: [
          ...envPlan.candidates.map(env => ({ label: environmentLabel(env), description: describeEnvironment(env) })),
          { label: `Create a new environment "${DEFAULT_ENVIRONMENT_NAME}"`, description: 'cloud · no extra packages · network unrestricted' },
        ],
      })
    }
    if (agentPlan?.kind === 'ask') {
      questions.push({
        id: AGENT_QUESTION,
        header: 'Qoder Cloud',
        question: 'Which Qoder Cloud agent should run delegated tasks?',
        detail: 'The agent sets the cloud model, system prompt and tools. '
          + 'The choice is saved to this profile; change it later with `/qoder-cloud-agents agent`.',
        options: [
          { label: `Create "${options.agentName}"`, description: `model ${options.model} · built-in sandbox toolset` },
          ...agentPlan.candidates.map(agent => ({ label: agentLabel(agent), ...typeof agent.model === 'string' ? { description: `model ${agent.model}` } : {} })),
        ],
      })
    }

    let answer: AskUserQuestionAnswer | undefined
    if (questions.length > 0) {
      let unanswerable: string | undefined = asker === undefined ? 'no one can be asked to choose (no interactive UI)' : undefined
      if (asker !== undefined) {
        try {
          answer = await asker(questions, signal)
        } catch (error: unknown) {
          const code = errorCode(error)
          if (code === undefined || !UNANSWERABLE.has(code)) throw error
          unanswerable = code === 'NO_PROVIDER'
            ? 'no one can be asked to choose (no interactive UI is attached)'
            : 'the delegating agent is itself a delegated task, which cannot ask the user'
        }
      }
      if (answer === undefined && envPlan?.kind === 'ask') {
        throw ambiguousEnvironment(envPlan.candidates, options.entryId, unanswerable ?? 'none was chosen')
      }
    }

    const notes: string[] = []
    const chosen: Selection = {}
    let resolvedEnvironment = environmentId
    if (envPlan !== undefined) {
      const env = await this.applyEnvironment(client, envPlan, answer, signal)
      resolvedEnvironment = env.id
      chosen.environmentId = env.id
      notes.push(`Environment: ${env.name} (${env.id})${envPlan.kind === 'use' ? ` — ${envPlan.why}` : ''}`)
    }
    let resolvedAgent = agentId
    if (agentPlan !== undefined) {
      const agent = await this.applyAgent(client, answer === undefined && agentPlan.kind === 'ask' ? { kind: 'create' } : agentPlan, answer, signal)
      resolvedAgent = agent.id
      chosen.agentId = agent.id
      notes.push(`Agent: ${agent.name} (${agent.id})${agentPlan.kind === 'use' ? ` — ${agentPlan.why}` : ''}`)
    }

    this.memo = { ...this.memo, ...chosen }
    const saved = await options.persist(chosen)
    notes.push(saved
      ? 'Saved to this profile; change with /qoder-cloud-agents.'
      : 'Not saved to the profile (no settings service); set environmentId / agentId in the profile patch to keep it.')
    return { environmentId: resolvedEnvironment!, agent: resolvedAgent!, notes }
  }

  private planEnvironment(envs: EnvironmentView[]): EnvironmentPlan {
    if (envs.length === 0) return { kind: 'create' }
    // A lone self-hosted environment is not a safe silent default: it needs a live worker.
    if (envs.length === 1 && isManagedCloud(envs[0]!)) return { kind: 'use', env: envs[0]!, why: 'the only environment' }
    // Managed cloud first, then self-hosted (BYOC), each in platform order.
    const ordered = [...envs.filter(isManagedCloud), ...envs.filter(env => !isManagedCloud(env))]
    return { kind: 'ask', candidates: ordered, all: envs }
  }

  private planAgent(agents: AgentView[], canAsk: boolean): AgentPlan {
    const managed = agents.find(agent => agent.name === this.options.agentName)
    if (managed !== undefined) return { kind: 'use', agent: managed, why: 'managed by this plugin' }
    // The plugin's own agent is a defined default, so headless runs create it
    // instead of failing; only an interactive run offers the account's agents.
    if (!canAsk || agents.length === 0) return { kind: 'create' }
    return { kind: 'ask', candidates: agents.slice(0, MAX_AGENT_OPTIONS), all: agents }
  }

  private async applyEnvironment(
    client: QoderCloudClient,
    plan: EnvironmentPlan,
    answer: AskUserQuestionAnswer | undefined,
    signal: AbortSignal,
  ): Promise<EnvironmentView> {
    if (plan.kind === 'use') return plan.env
    if (plan.kind === 'ask') {
      const item = answer?.answers.find(entry => entry.id === ENVIRONMENT_QUESTION)
      const label = item?.selected[0]
      const picked = plan.candidates.find(env => environmentLabel(env) === label)
      if (picked !== undefined) return picked
      const custom = item?.custom?.trim()
      if (custom !== undefined && custom.length > 0 && label === undefined) {
        const match = matchByIdOrName(plan.all, custom, 'environment')
        if (typeof match === 'string') throw new SelectionRequiredError(`qoder-cloud-agents: ${match}`)
        return match
      }
      if (label === undefined) throw new SelectionRequiredError('qoder-cloud-agents: no Qoder Cloud environment was chosen')
    }
    return client.createEnvironment(DEFAULT_ENVIRONMENT_NAME, signal)
  }

  private async applyAgent(
    client: QoderCloudClient,
    plan: AgentPlan,
    answer: AskUserQuestionAnswer | undefined,
    signal: AbortSignal,
  ): Promise<AgentView> {
    if (plan.kind === 'use') return plan.agent
    if (plan.kind === 'ask') {
      const item = answer?.answers.find(entry => entry.id === AGENT_QUESTION)
      const label = item?.selected[0]
      const picked = plan.candidates.find(agent => agentLabel(agent) === label)
      if (picked !== undefined) return picked
      const custom = item?.custom?.trim()
      if (custom !== undefined && custom.length > 0 && label === undefined) {
        const match = matchByIdOrName(plan.all, custom, 'agent')
        if (typeof match === 'string') throw new SelectionRequiredError(`qoder-cloud-agents: ${match}`)
        return match
      }
      if (label === undefined) throw new SelectionRequiredError('qoder-cloud-agents: no Qoder Cloud agent was chosen')
    }
    return this.createManagedAgent(client, signal)
  }

  /** Create (or reuse) the plugin-managed agent. */
  async createManagedAgent(client: QoderCloudClient, signal: AbortSignal): Promise<AgentView> {
    const existing = active((await client.listAgents(signal)).data).find(agent => agent.name === this.options.agentName)
    if (existing !== undefined) return existing
    return client.createAgent({
      name: this.options.agentName,
      model: this.options.model,
      system: this.options.system,
      description: 'Managed by the DeepSeek Harness dsh-qoder-cloud-agents plugin',
      tools: [{ type: AGENT_TOOLSET }],
      metadata: { source: 'deepseek-harness' },
    }, signal)
  }
}

export { matchByIdOrName }
