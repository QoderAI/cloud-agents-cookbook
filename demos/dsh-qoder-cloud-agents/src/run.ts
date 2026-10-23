/**
 * One-shot Qoder Cloud run: create a cloud session (optionally mounting the
 * delegating workspace's git repository), send the task as one user message,
 * follow the session SSE stream until the turn settles, and map the outcome
 * onto the shared subagent result.
 *
 * @module dsh-qoder-cloud-agents/run
 */

import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import {
  delay,
  type QoderCloudClient,
  type SessionEvent,
  type SessionResource,
} from './client.ts'
import { detectRepository, type LocalRepository } from './git.ts'
import { checkGitHubAccess } from './github.ts'
import type { QoderCloudTarget } from './target.ts'

/** Default ceiling for one delegated turn. */
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000

/** Consecutive stream failures tolerated before the run fails. */
const MAX_STREAM_FAILURES = 6

/** Provider-owned settings for one run. */
export interface QoderCloudRunSpec {
  readonly client: QoderCloudClient
  readonly resolveTarget: (signal: AbortSignal) => Promise<QoderCloudTarget>
  /** `auto` mounts the cwd's origin repository when there is one. */
  readonly repository: 'auto' | 'none'
  /** Token the sandbox uses to clone and push the mounted repository. */
  readonly gitToken?: string | undefined
  /** Credential name of {@link gitToken}, for messages. */
  readonly gitTokenEnv?: string | undefined
  /** Account for authenticated non-GitHub clones (your user name on that Git host); else the origin URL's user. */
  readonly gitUsername?: string | undefined
  /** Prefix of the branch the cloud agent is asked to push. */
  readonly branchPrefix: string
  /** Answer for tool calls the cloud agent's permission policy pauses on. */
  readonly toolConfirmation: 'allow' | 'deny'
  readonly environmentVariables: Readonly<Record<string, string>>
  readonly archiveOnFinish: boolean
  readonly timeoutMs: number
  /** Diagnostic sink; a throw from it is contained. */
  readonly onError?: ((error: Error, stopReason: SubagentStopReason) => void) | undefined
}

/** The request fields this backend reads. */
export interface QoderCloudRunRequest {
  readonly cwd: string
  readonly prompt: readonly ContentBlock[]
  readonly label?: string | undefined
  readonly signal: AbortSignal
}

/**
 * Join the delegated task's text blocks; the cloud session receives text only.
 * @param prompt - the subagent prompt.
 * @returns the task text.
 */
export function textTask(prompt: readonly ContentBlock[]): string {
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('qoder-cloud-agents: the delegated task must contain only text blocks')
    }
    texts.push(block.text)
  }
  const text = texts.join('\n')
  if (text.trim().length === 0) throw new Error('qoder-cloud-agents: the delegated task must not be empty')
  return text
}

/**
 * Compose the cloud-side message: the task plus how to hand changes back.
 * @param task - delegated task text.
 * @param repo - mounted repository, if any.
 * @param resultBranch - branch the agent should push.
 */
export function cloudPrompt(task: string, repo: LocalRepository | undefined, resultBranch: string | undefined): string {
  if (repo === undefined || resultBranch === undefined) return task
  const at = repo.checkout.type === 'branch'
    ? `checked out at branch \`${repo.checkout.name}\``
    : `checked out at its default branch; before working, run \`git fetch origin ${repo.checkout.sha} && git checkout ${repo.checkout.sha}\` there`
  return [
    task,
    '',
    '---',
    'Workspace handed over from the delegating DeepSeek Harness session:',
    `- The git repository ${repo.url} is mounted in this sandbox at \`${repo.mountPath}\` (in a self-hosted environment: \`workspace/${repo.name}\` under your working directory), ${at}.`,
    `- First check that the mounted repository exists. If it does not, the platform failed to mount it (unreachable host or missing/invalid token): stop immediately and report that, without cloning it yourself or doing any other work.`,
    `- If you change files, commit them on a new branch named \`${resultBranch}\` and \`git push -u origin ${resultBranch}\`. Do not push to any other branch.`,
    '- Your final message is returned to the delegating agent verbatim: summarize what you did, and state the pushed branch name (or that nothing was pushed).',
  ].join('\n')
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** What the stream observed, folded for the final answer. */
class TurnFold {
  finalText: string | undefined
  errorMessage: string | undefined
  stopReason: string | undefined
  readonly artifacts: { name: string; fileId: string; size?: number }[] = []
  readonly pendingTools = new Map<string, string>()

  push(event: SessionEvent): void {
    switch (event.type) {
      case 'agent.message': {
        const text = messageText(event.content)
        if (text.trim().length > 0) this.finalText = text
        break
      }
      case 'agent.tool_use':
      case 'agent.mcp_tool_use':
      case 'agent.custom_tool_use':
        this.pendingTools.set(event.id, event.type)
        break
      case 'agent.artifact_delivered':
        if (typeof event.file_id === 'string') {
          this.artifacts.push({
            name: event.original_filename ?? event.file_id,
            fileId: event.file_id,
            ...typeof event.size === 'number' ? { size: event.size } : {},
          })
        }
        break
      case 'session.error':
        if (event.error?.message !== undefined) this.errorMessage = event.error.message
        break
      default:
        break
    }
  }
}

/**
 * Map the workspace repository onto a session resource the way the Qoder
 * console does: GitHub takes a bare URL plus an optional token; any other
 * host authenticates with the account in the URL and the token as password,
 * both or neither (the Qoder Cloud API rejects one without the other).
 */
export function repositoryResource(
  repo: LocalRepository,
  spec: Pick<QoderCloudRunSpec, 'gitToken' | 'gitTokenEnv' | 'gitUsername'>,
): SessionResource {
  // The platform drops commit checkouts; the prompt has the agent fetch the commit instead.
  const checkout = repo.checkout.type === 'branch' ? { checkout: repo.checkout } : {}
  if (repo.github) {
    return {
      type: 'github_repository',
      url: repo.url,
      mount_path: repo.mountPath,
      ...checkout,
      ...spec.gitToken === undefined ? {} : { authorization_token: spec.gitToken },
    }
  }
  if (spec.gitToken === undefined) {
    return { type: 'git_repository', url: repo.url, mount_path: repo.mountPath, ...checkout }
  }
  const username = spec.gitUsername ?? repo.remoteUsername
  if (username === undefined) {
    const host = new URL(repo.url).host
    throw new Error(
      `qoder-cloud-agents: ${host} needs an account name with ${spec.gitTokenEnv ?? 'the git token'}; `
      + 'set gitUsername in the plugin config '
      + `or use an origin like https://<account>@${host}/…`,
    )
  }
  const url = new URL(repo.url)
  url.username = encodeURIComponent(username)
  const token = spec.gitToken
  return { type: 'git_repository', url: url.toString(), password: token, mount_path: repo.mountPath, ...checkout }
}

const STOP_REASONS: Readonly<Record<string, SubagentStopReason>> = {
  end_turn: 'completed',
  cancelled: 'aborted',
  max_tokens: 'max-tokens',
  refusal: 'refusal',
  error: 'error',
  retries_exhausted: 'error',
  terminated: 'error',
}

/**
 * Start one Qoder Cloud session and publish its one-shot run. Session creation
 * and the first message happen before publication, so a platform rejection
 * (auth, quota, bad repository) fails the delegation call itself.
 * @param request - resolved subagent request.
 * @param spec - client, binding and run policy.
 * @returns the published run.
 */
export async function startQoderCloudRun(
  request: QoderCloudRunRequest,
  spec: QoderCloudRunSpec,
): Promise<SubagentRun> {
  const task = textTask(request.prompt)
  if (request.signal.aborted) throw new Error('qoder-cloud-agents: request was aborted before session start')

  const controller = new AbortController()
  const requestCancel = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error('qoder-cloud-agents: run cancelled locally'))
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })
  const { client } = spec

  let sessionId: string | undefined
  let lastEventId: string | undefined
  let repo: LocalRepository | undefined
  let resultBranch: string | undefined
  let target: QoderCloudTarget | undefined
  const preflightNotes: string[] = []
  try {
    repo = spec.repository === 'auto' ? await detectRepository(request.cwd, controller.signal) : undefined
    if (repo?.github) {
      // The platform clones silently and lazily; catch an unusable token here.
      const access = await checkGitHubAccess(repo.url, spec.gitToken, spec.gitTokenEnv ?? 'QODER_GIT_TOKEN', controller.signal)
      if (access.error !== undefined) throw new Error(`qoder-cloud-agents: ${access.error}`)
      preflightNotes.push(...access.warnings)
    }
    // Build resources before resolving the target so a credential mistake fails before any prompt.
    const resources: SessionResource[] = []
    if (repo !== undefined) {
      resultBranch = `${spec.branchPrefix}${randomUUID().slice(0, 8)}`
      resources.push(repositoryResource(repo, spec))
    }
    target = await spec.resolveTarget(controller.signal)
    const title = (request.label ?? task.split('\n')[0] ?? 'DeepSeek Harness task').slice(0, 120)
    const session = await client.createSession({
      agent: target.agent,
      environment_id: target.environmentId,
      title,
      metadata: { source: 'deepseek-harness' },
      ...resources.length === 0 ? {} : { resources },
      ...Object.keys(spec.environmentVariables).length === 0
        ? {}
        : { environment_variables: { ...spec.environmentVariables } },
    }, controller.signal)
    sessionId = session.id
    const posted = await client.sendEvents(session.id, [{
      type: 'user.message',
      content: [{ type: 'text', text: cloudPrompt(task, repo, resultBranch) }],
    }], controller.signal)
    lastEventId = posted.data.at(-1)?.id
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    if (sessionId !== undefined) await bestEffort(() => client.archiveSession(sessionId!, AbortSignal.timeout(10_000)))
    if (controller.signal.aborted) throw new Error('qoder-cloud-agents: request was aborted before session start')
    throw error instanceof Error ? error : new Error(String(error))
  }

  const id = sessionId
  const fold = new TurnFold()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('qoder-cloud-agents: turn timed out'))
  }, spec.timeoutMs)

  const footer = (stopReason: string): string => {
    const lines = [`[Qoder Cloud] session ${id} · stop_reason ${stopReason}`]
    if (repo !== undefined) {
      lines.push(`Repository: this workspace's origin ${repo.url} (${repo.checkout.type === 'branch' ? repo.checkout.name : repo.checkout.sha.slice(0, 12)}); requested result branch: ${resultBranch}`)
    }
    if (fold.artifacts.length > 0) {
      lines.push(`Artifacts: ${fold.artifacts.map(a => `${a.name} (${a.fileId}${a.size === undefined ? '' : `, ${a.size} bytes`})`).join(', ')}`)
    }
    for (const note of target?.notes ?? []) lines.push(note)
    for (const warning of [...repo?.warnings ?? [], ...preflightNotes]) lines.push(`Note: ${warning}`)
    return lines.join('\n')
  }
  const output = (stopReason: string): ContentBlock[] => {
    const body = fold.finalText ?? '(the cloud agent produced no final message)'
    return [{ type: 'text', text: `${body}\n\n${footer(stopReason)}` }]
  }

  const answerPause = async (eventIds: readonly string[]): Promise<void> => {
    for (const eventId of eventIds) {
      const kind = fold.pendingTools.get(eventId)
      const event = kind === 'agent.custom_tool_use'
        ? {
            type: 'user.custom_tool_result',
            custom_tool_use_id: eventId,
            content: [{ type: 'text', text: 'Custom tools are unavailable in an unattended DeepSeek Harness delegation.' }],
            is_error: true,
          }
        : {
            type: 'user.tool_confirmation',
            tool_use_id: eventId,
            result: spec.toolConfirmation,
            ...spec.toolConfirmation === 'deny'
              ? { deny_message: 'Denied by the unattended DeepSeek Harness delegation policy.' }
              : {},
          }
      await client.sendEvents(id, [event], controller.signal)
    }
  }

  const follow = async (): Promise<SubagentResult> => {
    let failures = 0
    for (;;) {
      try {
        for await (const event of client.streamEvents(id, lastEventId, controller.signal)) {
          failures = 0
          if (event.id !== undefined) lastEventId = event.id
          fold.push(event)
          if (event.type === 'session.status_idle') {
            const reason = event.stop_reason?.type ?? 'end_turn'
            if (reason === 'requires_action') {
              await answerPause(event.stop_reason?.event_ids ?? [])
              continue
            }
            fold.stopReason = reason
            const stopReason = STOP_REASONS[reason] ?? 'completed'
            return {
              output: output(reason),
              ...stopReason === 'error' ? { diagnostic: fold.errorMessage ?? `Qoder Cloud turn ended with ${reason}` } : {},
              stopReason,
            }
          }
          if (event.type === 'session.status_terminated' || event.type === 'session.deleted') {
            fold.stopReason = 'terminated'
            return {
              output: output('terminated'),
              diagnostic: fold.errorMessage ?? `Qoder Cloud session ${id} was terminated`,
              stopReason: 'error',
            }
          }
        }
      } catch (error: unknown) {
        if (controller.signal.aborted) throw error
        if (++failures >= MAX_STREAM_FAILURES) throw error
      }
      // The stream never closes on idle; an end or error is transport loss.
      await delay(Math.min(1_000 * 2 ** failures, 15_000), controller.signal)
    }
  }

  const following = follow()
  const result = settleRunResult({
    attempt: async () => {
      try {
        return await following
      } catch (error: unknown) {
        if (timedOut) throw new Error(`qoder-cloud-agents: turn exceeded ${spec.timeoutMs} ms`)
        throw error
      } finally {
        clearTimeout(timer)
        if (fold.stopReason !== undefined && spec.archiveOnFinish) {
          await bestEffort(() => client.archiveSession(id, AbortSignal.timeout(10_000)))
        }
      }
    },
    collectOutput: () => fold.finalText === undefined ? [] : output('cancelled'),
    collectDiagnostic: () => timedOut
      ? `Qoder Cloud session ${id} exceeded ${spec.timeoutMs} ms and was cancelled`
      : fold.errorMessage ?? `Qoder Cloud session ${id}: stream failed`,
    cancelled: () => controller.signal.aborted && !timedOut,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })
  // A turn that did not settle remotely (local cancel, timeout, lost stream)
  // is cancelled on the platform so the sandbox stops spending credits.
  const remoteCleanup = result.then(async () => {
    if (fold.stopReason !== undefined) return
    await bestEffort(() => client.cancelSession(id, AbortSignal.timeout(10_000)))
    if (spec.archiveOnFinish) await bestEffort(() => client.archiveSession(id, AbortSignal.timeout(10_000)))
  })

  return subprocessRunHandle({
    // Provider-minted run id; SessionId is a branded string.
    id: randomUUID() as string as SessionId,
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: async () => {
      clearTimeout(timer)
      await following.catch(() => {})
      await result
      await remoteCleanup
    },
  })
}

async function bestEffort(action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch {
    // Remote cleanup is advisory; the local run already settled.
  }
}
