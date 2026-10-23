/**
 * Cloud mode: a `qoder-cloud-agents` LLM route whose "model" is a Qoder Cloud agent.
 * Each dsh turn posts the user's new message to one Qoder Cloud session (one
 * per dsh session) and streams the remote agent's messages and tool activity
 * back as the assistant reply, so the ordinary agent loop logs and renders it
 * and follow-ups continue the same remote session.
 *
 * The remote session id travels on each reply's `replayState`, so it survives
 * restarts and forks without extra storage.
 *
 * @module dsh-qoder-cloud-agents/cloud-mode
 */

import { randomUUID } from 'node:crypto'
import {
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type RequestMessage,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { delay, type QoderCloudClient, type SessionEvent, type SessionResource } from './client.ts'
import { detectRepository, type LocalRepository } from './git.ts'
import { checkGitHubAccess } from './github.ts'
import { repositoryResource } from './run.ts'
import type { Asker, TargetResolver } from './target.ts'

import { CLOUD_MODEL, CLOUD_PROVIDER } from './cloud-constants.ts'

export { CLOUD_MODEL, CLOUD_PRESET_ID, CLOUD_PROVIDER } from './cloud-constants.ts'

/** Consecutive stream failures tolerated within one turn. */
const MAX_STREAM_FAILURES = 6

/** What a successful reply records for the next turn. */
interface CloudReplay {
  readonly remoteSessionId: string
}

/** Session-scoped facts the adapter needs from the host, resolved per turn. */
export interface CloudTurnContext {
  /** Working directory of the dsh session, for repository detection. */
  readonly cwd: string | undefined
  /** Human answerer for the environment / agent picker, when one is attached. */
  readonly asker: Asker | undefined
}

export interface CloudModeOptions {
  readonly client: () => Promise<QoderCloudClient | string>
  readonly resolver: TargetResolver
  /** Session cwd and answerer for a dsh session id. */
  readonly turnContext: (sessionId: string | undefined) => CloudTurnContext
  readonly repository: 'auto' | 'none'
  readonly gitToken: () => Promise<string | undefined>
  readonly gitTokenEnv: string
  readonly gitUsername: string | undefined
  readonly branchPrefix: string
  readonly toolConfirmation: 'allow' | 'deny'
  readonly environmentVariables: Readonly<Record<string, string>>
  readonly onWarn?: (message: string, error?: unknown) => void
}

/** Join the visible text of request content blocks; attachments become placeholders. */
function blocksText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push('[an image was attached locally; it is not available in the cloud]')
    else if (block.type === 'file') parts.push(`[a file was attached locally: ${(block as { attachment?: { name?: string } }).attachment?.name ?? 'file'}; it is not available in the cloud]`)
  }
  return parts.join('\n')
}

function isUserInput(message: RequestMessage): boolean {
  if (message.role !== 'user') return false
  // Identity-free one-shot input, or a message the user typed. Other user-role
  // sources (context notices, relays) are local harness plumbing.
  return message.source === undefined || message.source.kind === 'user'
}

/**
 * Find the remote session of the latest cloud reply and the user text typed since.
 * @param messages - the request history.
 * @returns the replay (if any) and the new user text.
 */
export function splitHistory(messages: readonly RequestMessage[]): { replay: CloudReplay | undefined; input: string } {
  let lastAssistant = -1
  let replay: CloudReplay | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'assistant') continue
    if (lastAssistant < 0) lastAssistant = index
    const source = message.source
    const state = source.provider === CLOUD_PROVIDER ? (source.replayState as { response?: unknown } | undefined) : undefined
    const response = state?.response as Partial<CloudReplay> | undefined
    if (typeof response?.remoteSessionId === 'string') {
      replay = { remoteSessionId: response.remoteSessionId }
      break
    }
  }
  const input = messages
    .slice(lastAssistant + 1)
    .filter(isUserInput)
    .map(message => blocksText(message.content))
    .filter(text => text.trim().length > 0)
    .join('\n\n')
  return { replay, input }
}

/** First-turn preamble: how the workspace reached the sandbox and how to hand changes back. */
export function cloudModePreamble(repo: LocalRepository | undefined, resultBranch: string | undefined): string {
  const lines = [
    'You are working in a Qoder Cloud sandbox for a user of DeepSeek Harness. Your messages are shown to them as your replies; they may follow up in later turns.',
  ]
  if (repo !== undefined && resultBranch !== undefined) {
    const at = repo.checkout.type === 'branch'
      ? `checked out at branch \`${repo.checkout.name}\``
      : `checked out at its default branch; before working, run \`git fetch origin ${repo.checkout.sha} && git checkout ${repo.checkout.sha}\` there`
    lines.push(
      `The user's git repository ${repo.url} is mounted at \`${repo.mountPath}\` (in a self-hosted environment: \`workspace/${repo.name}\` under your working directory), ${at}.`,
      'First check that the mounted repository exists. If it does not, the platform failed to mount it (unreachable host or missing/invalid token): say so and stop, without cloning it yourself.',
      `When you change files, commit them on the branch \`${resultBranch}\` and \`git push -u origin ${resultBranch}\`; keep using that branch for later turns and never push to any other branch. Say which branch you pushed.`,
    )
  } else {
    lines.push('No local repository was shared with this sandbox.')
  }
  return lines.join('\n')
}

function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value.length > 160 ? `${value.slice(0, 157)}…` : value
  }
  const json = JSON.stringify(record)
  return json.length > 160 ? `${json.slice(0, 157)}…` : json
}

function eventText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** Emits well-formed block sequences with increasing indexes. */
class ChunkWriter {
  private index = 0
  text(text: string): StreamChunk[] { return this.block('text', text) }
  reasoning(text: string): StreamChunk[] { return this.block('reasoning', text) }
  private block(type: 'text' | 'reasoning', text: string): StreamChunk[] {
    const index = this.index++
    return [
      { type: 'block-start', index, blockType: type },
      type === 'text' ? { type: 'text-delta', index, text } : { type: 'reasoning-delta', index, text },
      { type: 'block-end', index, block: { type, text } },
    ]
  }
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 } as const

/** Model-picker group of the cloud route. */
const CLOUD_GROUP_NAME = 'Qoder Cloud Agents'
/** Model-picker entry: marks the route as cloud mode's, not a general model. */
const CLOUD_MODEL_NAME = '云端模式（Qoder Cloud Agents）'
const CLOUD_MODEL_DESCRIPTION = '仅供云端模式使用：请在新会话打开「云端模式」开关，不要在普通会话里切换到它'

/** The `qoder-cloud-agents` route. */
export class QoderCloudAdapter extends LlmAdapter {
  /** Same-process fallback when a turn failed before recording its replay state. */
  private readonly remoteByDshSession = new Map<string, string>()

  constructor(private readonly options: CloudModeOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: CLOUD_GROUP_NAME }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    // A retry would post the user's message to the cloud agent a second time.
    return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, provider)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // Listed only so a cloud-mode session's picker can name its route; the name
    // says it belongs to cloud mode rather than offering it as a general model.
    return [{ provider, id: CLOUD_MODEL, name: CLOUD_MODEL_NAME, description: CLOUD_MODEL_DESCRIPTION }]
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    // The remote agent keeps its own context; dsh only sends each new turn.
    return { provider, id: model, name: CLOUD_MODEL_NAME, context: { contextWindow: 1_000_000 } }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose !== undefined) {
      yield* this.auxiliary(options)
      return
    }
    const signal = options.signal ?? new AbortController().signal
    const { replay, input } = splitHistory(options.messages)
    if (input.trim().length === 0) {
      throw new LlmError('Cloud mode received no user text to send', 'EMPTY_REQUEST')
    }
    const client = await this.options.client()
    if (typeof client === 'string') throw new LlmError(`Qoder Cloud: ${client}`, 'AUTH')

    const sessionKey = options.sessionId as string | undefined
    let remoteSessionId = replay?.remoteSessionId ?? (sessionKey === undefined ? undefined : this.remoteByDshSession.get(sessionKey))
    const writer = new ChunkWriter()
    let text = input
    if (remoteSessionId === undefined) {
      const created = await this.createRemoteSession(client, sessionKey, signal)
      remoteSessionId = created.id
      text = `${created.preamble}\n\n---\n\n${input}`
      if (created.notes.length > 0) yield* writer.reasoning(created.notes.join('\n'))
    }
    if (sessionKey !== undefined) this.remoteByDshSession.set(sessionKey, remoteSessionId)

    let posted
    try {
      posted = await client.sendEvents(remoteSessionId, [{ type: 'user.message', content: [{ type: 'text', text }] }], signal)
    } catch (error: unknown) {
      throw toLlmError(error, 'Qoder Cloud refused the message')
    }
    const id = remoteSessionId
    const onAbort = (): void => { void client.cancelSession(id, AbortSignal.timeout(10_000)).catch(() => {}) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      yield* this.follow(client, id, posted.data.at(-1)?.id, writer, signal)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** Session titles and compaction never reach the cloud agent. */
  private async *auxiliary(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const writer = new ChunkWriter()
    const text = options.purpose === 'session-title'
      ? localTitle(options.messages)
      : 'The conversation continues in the same Qoder Cloud session, which keeps the full history.'
    yield* writer.text(text)
    yield { type: 'usage', usage: ZERO_USAGE }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  private async createRemoteSession(
    client: QoderCloudClient,
    sessionKey: string | undefined,
    signal: AbortSignal,
  ): Promise<{ id: string; preamble: string; notes: string[] }> {
    const { options } = this
    const context = options.turnContext(sessionKey)
    const notes: string[] = []
    let repo: LocalRepository | undefined
    let resultBranch: string | undefined
    const resources: SessionResource[] = []
    if (options.repository === 'auto' && context.cwd !== undefined) {
      repo = await detectRepository(context.cwd, signal)
    }
    if (repo !== undefined) {
      const gitToken = await options.gitToken()
      if (repo.github) {
        const access = await checkGitHubAccess(repo.url, gitToken, options.gitTokenEnv, signal)
        if (access.error !== undefined) throw new LlmError(`Qoder Cloud: ${access.error}`, 'REPOSITORY_ACCESS')
        notes.push(...access.warnings)
      }
      try {
        resources.push(repositoryResource(repo, { gitToken, gitTokenEnv: options.gitTokenEnv, gitUsername: options.gitUsername }))
      } catch (error: unknown) {
        throw toLlmError(error, 'Qoder Cloud repository configuration')
      }
      resultBranch = `${options.branchPrefix}${randomUUID().slice(0, 8)}`
      notes.push(...repo.warnings)
    }
    let target
    try {
      target = await options.resolver.resolve(client, context.asker, signal)
    } catch (error: unknown) {
      throw toLlmError(error, 'Qoder Cloud environment selection')
    }
    let session
    try {
      session = await client.createSession({
        agent: target.agent,
        environment_id: target.environmentId,
        title: 'DeepSeek Harness cloud mode',
        metadata: { source: 'deepseek-harness', mode: 'cloud' },
        ...resources.length === 0 ? {} : { resources },
        ...Object.keys(options.environmentVariables).length === 0
          ? {}
          : { environment_variables: { ...options.environmentVariables } },
      }, signal)
    } catch (error: unknown) {
      throw toLlmError(error, 'Qoder Cloud could not create a session')
    }
    notes.unshift(
      `Qoder Cloud session ${session.id}`
      + (repo === undefined ? '' : ` · repository ${repo.url} → branch ${resultBranch}`),
      ...target.notes,
    )
    return { id: session.id, preamble: cloudModePreamble(repo, resultBranch), notes }
  }

  /** Stream one remote turn as chunks until it settles. */
  private async *follow(
    client: QoderCloudClient,
    remoteSessionId: string,
    lastPosted: string | undefined,
    writer: ChunkWriter,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    let lastEventId = lastPosted
    let failures = 0
    let errorMessage: string | undefined
    let wroteText = false
    const pendingTools = new Map<string, string>()
    for (;;) {
      try {
        for await (const event of client.streamEvents(remoteSessionId, lastEventId, signal)) {
          failures = 0
          if (event.id !== undefined) lastEventId = event.id
          const chunks = this.render(event, writer, pendingTools)
          if (event.type === 'agent.message' && chunks.length > 0) wroteText = true
          yield* chunks
          if (event.type === 'session.error') errorMessage = event.error?.message ?? errorMessage
          if (event.type === 'session.status_idle') {
            const reason = event.stop_reason?.type ?? 'end_turn'
            if (reason === 'requires_action') {
              await this.answerPause(client, remoteSessionId, event.stop_reason?.event_ids ?? [], pendingTools, signal)
              continue
            }
            if (reason === 'end_turn' || reason === 'max_tokens') {
              if (!wroteText) yield* writer.text('(the cloud agent ended the turn without a message)')
              yield { type: 'usage', usage: ZERO_USAGE }
              yield {
                type: 'finish',
                reason: reason === 'max_tokens' ? { kind: 'max-tokens' } : { kind: 'stop' },
                replayState: { response: { remoteSessionId } satisfies CloudReplay },
              }
              return
            }
            throw new LlmError(
              errorMessage ?? `Qoder Cloud turn ended with ${reason} (session ${remoteSessionId})`,
              reason === 'cancelled' ? 'REMOTE_CANCELLED' : 'REMOTE_AGENT_ERROR',
            )
          }
          if (event.type === 'session.status_terminated' || event.type === 'session.deleted') {
            throw new LlmError(errorMessage ?? `Qoder Cloud session ${remoteSessionId} was terminated`, 'REMOTE_TERMINATED')
          }
        }
      } catch (error: unknown) {
        if (error instanceof LlmError || signal.aborted) throw error
        if (++failures >= MAX_STREAM_FAILURES) throw toLlmError(error, 'Qoder Cloud stream failed')
      }
      await delay(Math.min(1_000 * 2 ** failures, 15_000), signal)
    }
  }

  /** Map one remote event onto visible blocks: messages as text, activity as reasoning. */
  private render(event: SessionEvent, writer: ChunkWriter, pendingTools: Map<string, string>): StreamChunk[] {
    switch (event.type) {
      case 'agent.message': {
        const text = eventText(event.content)
        return text.trim().length > 0 ? writer.text(text) : []
      }
      case 'agent.thinking': {
        const text = typeof event.thinking === 'string' ? event.thinking : typeof event.text === 'string' ? event.text : ''
        return text.trim().length > 0 ? writer.reasoning(text) : []
      }
      case 'agent.tool_use':
      case 'agent.mcp_tool_use':
      case 'agent.custom_tool_use': {
        pendingTools.set(event.id, event.type)
        const server = typeof event.mcp_server_name === 'string' ? `${event.mcp_server_name}/` : ''
        const detail = summarizeInput(event.input)
        return writer.reasoning(`› ${server}${event.name ?? 'tool'}${detail.length > 0 ? `: ${detail}` : ''}`)
      }
      case 'agent.tool_result':
      case 'agent.mcp_tool_result':
        return event.is_error === true ? writer.reasoning(`  ✗ ${eventText(event.content).slice(0, 300) || 'tool failed'}`) : []
      case 'agent.artifact_delivered':
        return writer.reasoning(`Delivered file ${event.original_filename ?? event.file_id} (${event.file_id})`)
      case 'session.error':
        return event.error?.retry_status?.type === 'retrying'
          ? writer.reasoning(`Qoder Cloud is retrying: ${event.error.message ?? 'transient error'}`)
          : []
      default:
        return []
    }
  }

  private async answerPause(
    client: QoderCloudClient,
    remoteSessionId: string,
    eventIds: readonly string[],
    pendingTools: Map<string, string>,
    signal: AbortSignal,
  ): Promise<void> {
    for (const eventId of eventIds) {
      const event = pendingTools.get(eventId) === 'agent.custom_tool_use'
        ? {
            type: 'user.custom_tool_result',
            custom_tool_use_id: eventId,
            content: [{ type: 'text', text: 'Custom tools are unavailable in DeepSeek Harness cloud mode.' }],
            is_error: true,
          }
        : {
            type: 'user.tool_confirmation',
            tool_use_id: eventId,
            result: this.options.toolConfirmation,
            ...this.options.toolConfirmation === 'deny'
              ? { deny_message: 'Denied by the DeepSeek Harness cloud-mode policy.' }
              : {},
          }
      await client.sendEvents(remoteSessionId, [event], signal)
    }
  }
}

/**
 * A session title without a model call: the first human message. The title
 * plugin frames human messages as a JSON array after one instruction line.
 * @param messages - the title request's messages.
 */
export function localTitle(messages: readonly RequestMessage[]): string {
  const raw = messages
    .filter(message => message.role === 'user')
    .map(message => blocksText(message.content))
    .join('\n')
  const framed = raw.indexOf('[')
  let candidate: string | undefined
  if (framed >= 0) {
    try {
      candidate = firstString(JSON.parse(raw.slice(framed)))
    } catch {
      // Not a framed array; fall back to the raw text.
    }
  }
  const line = (candidate ?? raw).split(/\r?\n/).map(item => item.trim()).find(item => item.length > 0)
  return (line ?? 'Qoder Cloud').slice(0, 40)
}

/** First string found depth-first, preferring a `text` field. */
function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim().length > 0 ? value : undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string' && record.text.trim().length > 0) return record.text
    for (const item of Object.values(record)) {
      const found = firstString(item)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function toLlmError(error: unknown, context: string): LlmError {
  if (error instanceof LlmError) return error
  const message = error instanceof Error ? error.message.replace(/^qoder-cloud-agents: /, '') : String(error)
  const status = (error as { status?: unknown }).status
  return new LlmError(`${context}: ${message}`, 'REMOTE_AGENT_ERROR', {
    cause: error,
    ...typeof status === 'number' && status >= 100 && status <= 599 ? { status } : {},
  })
}
