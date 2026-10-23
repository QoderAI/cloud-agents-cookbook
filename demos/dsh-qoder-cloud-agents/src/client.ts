/**
 * Thin `fetch` client for the Qoder Cloud Agents OpenAPI
 * (`https://api.qoder.com/api/v1/cloud`): environments, agents, sessions,
 * session events and the session SSE stream.
 *
 * @module dsh-qoder-cloud-agents/client
 */

import { randomUUID } from 'node:crypto'
import { SseParser } from './sse.ts'

/** Default public gateway. */
export const DEFAULT_BASE_URL = 'https://api.qoder.com/api/v1/cloud'

/** Built-in sandbox toolset (Bash, Read, Write, Edit, Glob, Grep, WebFetch, …). */
export const AGENT_TOOLSET = 'agent_toolset_20260401'

/** `{type, message}` from the platform error envelope. */
export class QoderCloudError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(`Qoder Cloud ${status} ${errorType}: ${message}${requestId === undefined ? '' : ` (request_id ${requestId})`}`)
    this.name = 'QoderCloudError'
  }
}

export interface CursorPage<T> {
  readonly data: T[]
  readonly has_more?: boolean
  readonly next_page?: string | null
}

export interface EnvironmentView {
  readonly id: string
  readonly name: string
  readonly archived_at?: string | null
  /** `{type: 'cloud' | 'self_hosted', networking?, packages?, setup_script?}`. */
  readonly config?: { readonly type?: string } | null
}

export interface AgentView {
  readonly id: string
  readonly name: string
  /** A model id string or `{id, effort?, speed?}`. */
  readonly model?: unknown
  readonly version?: number
  readonly archived_at?: string | null
}

export interface SessionView {
  readonly id: string
  readonly status: 'idle' | 'running' | 'rescheduling' | 'terminated' | string
  readonly title?: string | null
}

/** One public session event; only the fields this client reads are typed. */
export interface SessionEvent {
  readonly id: string
  readonly type: string
  readonly content?: unknown
  readonly stop_reason?: { readonly type?: string; readonly event_ids?: readonly string[] } | null
  readonly error?: { readonly type?: string; readonly message?: string; readonly retry_status?: { readonly type?: string } } | null
  readonly name?: string
  readonly file_id?: string
  readonly original_filename?: string
  readonly size?: number
  readonly [key: string]: unknown
}

export type SessionResource =
  | { type: 'github_repository'; url: string; authorization_token?: string; checkout?: Checkout; mount_path?: string }
  /** Authenticated clones carry the account in the URL (`https://user@host/…`) and the token as `password`. */
  | { type: 'git_repository'; url: string; password?: string; checkout?: Checkout; mount_path?: string }
  | { type: 'file'; file_id: string; mount_path?: string }

export type Checkout = { type: 'branch'; name: string } | { type: 'commit'; sha: string }

export interface CreateSessionRequest {
  agent: string | { type: 'agent'; id: string; version?: number }
  environment_id: string
  title?: string
  metadata?: Record<string, string>
  resources?: SessionResource[]
  environment_variables?: Record<string, string>
}

export interface CreateAgentRequest {
  name: string
  model: string
  system?: string
  description?: string
  tools: { type: string }[]
  metadata?: Record<string, string>
}

export interface QoderCloudClientOptions {
  baseURL: string
  token: string
  headers?: Record<string, string>
  /** Injected for tests. */
  fetch?: typeof fetch
  /** Retries for 429 / 5xx on idempotent or idempotency-keyed requests. */
  maxRetries?: number
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

export class QoderCloudClient {
  private readonly baseURL: string
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number

  constructor(private readonly options: QoderCloudClientOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? fetch
    this.maxRetries = options.maxRetries ?? 3
  }

  listEnvironments(signal?: AbortSignal): Promise<CursorPage<EnvironmentView>> {
    return this.request('GET', '/environments?limit=100', undefined, signal)
  }

  createEnvironment(name: string, signal?: AbortSignal): Promise<EnvironmentView> {
    return this.request('POST', '/environments', {
      name,
      config: { type: 'cloud', networking: { type: 'unrestricted' } },
    }, signal)
  }

  listAgents(signal?: AbortSignal): Promise<CursorPage<AgentView>> {
    return this.request('GET', '/agents?limit=100', undefined, signal)
  }

  createAgent(body: CreateAgentRequest, signal?: AbortSignal): Promise<AgentView> {
    return this.request('POST', '/agents', body, signal)
  }

  createSession(body: CreateSessionRequest, signal?: AbortSignal): Promise<SessionView> {
    return this.request('POST', '/sessions', body, signal)
  }

  getSession(id: string, signal?: AbortSignal): Promise<SessionView> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}`, undefined, signal)
  }

  sendEvents(id: string, events: readonly Record<string, unknown>[], signal?: AbortSignal): Promise<{ data: SessionEvent[] }> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/events`, { events }, signal)
  }

  cancelSession(id: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/cancel`, {}, signal)
  }

  archiveSession(id: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/archive`, {}, signal)
  }

  /**
   * Open the session event stream once. Without `lastEventId` the server
   * replays the whole history first; with it, delivery resumes strictly after
   * that event. The stream never ends on idle: the caller stops reading.
   * @param id - session id.
   * @param lastEventId - resume point (`Last-Event-ID`).
   * @param signal - aborts the underlying request.
   */
  async *streamEvents(id: string, lastEventId: string | undefined, signal: AbortSignal): AsyncGenerator<SessionEvent> {
    const response = await this.fetchImpl(`${this.baseURL}/sessions/${encodeURIComponent(id)}/events/stream`, {
      method: 'GET',
      headers: {
        ...this.options.headers,
        Authorization: `Bearer ${this.options.token}`,
        Accept: 'text/event-stream',
        ...lastEventId === undefined ? {} : { 'Last-Event-ID': lastEventId },
      },
      signal,
    })
    if (!response.ok) throw await errorOf(response)
    if (response.body === null) throw new Error('Qoder Cloud stream returned no body')
    const parser = new SseParser()
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          let event: SessionEvent
          try {
            event = JSON.parse(frame.data) as SessionEvent
          } catch {
            continue
          }
          yield { ...event, id: event.id ?? frame.id, type: event.type ?? frame.event }
        }
      }
    } finally {
      reader.releaseLock()
      void response.body.cancel().catch(() => {})
    }
  }

  private async request<T>(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    // One key per logical request, reused across retries, so a retried POST
    // whose first attempt did land is not applied twice.
    const idempotencyKey = method === 'POST' ? randomUUID() : undefined
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()
      let response: Response
      try {
        response = await this.fetchImpl(`${this.baseURL}${path}`, {
          method,
          headers: {
            ...this.options.headers,
            Authorization: `Bearer ${this.options.token}`,
            Accept: 'application/json',
            ...body === undefined ? {} : { 'Content-Type': 'application/json' },
            ...idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey },
          },
          ...body === undefined ? {} : { body: JSON.stringify(body) },
          ...signal === undefined ? {} : { signal },
        })
      } catch (error: unknown) {
        if (signal?.aborted || attempt >= this.maxRetries) throw error
        await delay(backoff(attempt), signal)
        continue
      }
      if (response.ok) {
        const text = await response.text()
        return (text.length === 0 ? {} : JSON.parse(text)) as T
      }
      if (RETRYABLE.has(response.status) && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after'))
        await response.body?.cancel().catch(() => {})
        await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt), signal)
        continue
      }
      throw await errorOf(response)
    }
  }
}

async function errorOf(response: Response): Promise<QoderCloudError> {
  const text = await response.text().catch(() => '')
  try {
    const body = JSON.parse(text) as { request_id?: string; error?: { type?: string; message?: string } }
    return new QoderCloudError(
      response.status,
      body.error?.type ?? 'api_error',
      body.error?.message ?? response.statusText,
      body.request_id,
    )
  } catch {
    return new QoderCloudError(response.status, 'api_error', text.slice(0, 500) || response.statusText)
  }
}

function backoff(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8_000)
}

/** Abortable sleep. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
