import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmError, type GenerateOptions, type RequestMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { QoderCloudClient } from '../src/client.ts'
import { QoderCloudAdapter, splitHistory, type CloudModeOptions } from '../src/cloud-mode.ts'
import * as route from '../src/cloud-route.ts'
import { TargetResolver } from '../src/target.ts'
import { startMockQoder, type StreamContext } from './mock-server.ts'

const user = (id: string, text: string, kind = 'user'): RequestMessage =>
  ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind } }) as unknown as RequestMessage
const reply = (id: string, text: string, remoteSessionId?: string): RequestMessage => ({
  id,
  role: 'assistant',
  content: [{ type: 'text', text }],
  source: {
    kind: 'model',
    provider: 'qoder-cloud-agents',
    model: 'agent',
    ...remoteSessionId === undefined ? {} : { replayState: { response: { remoteSessionId } } },
  },
}) as unknown as RequestMessage
const system: RequestMessage = { id: 's', role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' } } as unknown as RequestMessage

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
const texts = (chunks: StreamChunk[], kind: 'text' | 'reasoning') => chunks
  .filter((c): c is Extract<StreamChunk, { type: 'block-end' }> => c.type === 'block-end' && c.block.type === kind)
  .map(c => (c.block as { text: string }).text)

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.restoreAllMocks()
})

let repo: string
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'qoder-cloudmode-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't')
  writeFileSync(join(repo, 'a.txt'), 'a'); git('add', '.'); git('commit', '-q', '-m', 'one')
  git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
})
afterAll(() => rmSync(repo, { recursive: true, force: true }))

function adapterFor(baseURL: string, overrides: Partial<CloudModeOptions> = {}) {
  const resolver = new TargetResolver({
    configured: () => ({ environmentId: 'env_1', agentId: 'agent_1' }),
    agentName: 'dsh-qoder-cloud-delegate',
    model: 'ultimate',
    system: '',
    entryId: 'qoder-cloud-agents',
    persist: async () => true,
  })
  return new QoderCloudAdapter({
    client: async () => new QoderCloudClient({ baseURL, token: 'pt-test' }),
    resolver,
    turnContext: () => ({ cwd: repo, asker: undefined }),
    repository: 'auto',
    gitToken: async () => 'ghp_test',
    gitTokenEnv: 'QODER_GIT_TOKEN',
    gitUsername: undefined,
    branchPrefix: 'qoder-cloud-agents/',
    toolConfirmation: 'allow',
    environmentVariables: {},
    ...overrides,
  })
}

function stubGitHub() {
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 })
    return realFetch(input, init)
  })
}

const options = (messages: RequestMessage[], extra: Partial<GenerateOptions> = {}): GenerateOptions => ({
  provider: 'qoder-cloud-agents',
  model: 'agent',
  messages,
  sessionId: 'session-1' as GenerateOptions['sessionId'],
  ...extra,
})

describe('splitHistory', () => {
  it('sends only what the user typed since the last reply and finds the remote session', () => {
    expect(splitHistory([system, user('u1', 'hello')])).toEqual({ replay: undefined, input: 'hello' })
    const followUp = splitHistory([
      system,
      user('u1', 'hello'),
      reply('a1', 'hi', 'sess_9'),
      user('n1', 'local notice', 'subagent-settled'),
      user('u2', 'and then?'),
    ])
    expect(followUp).toEqual({ replay: { remoteSessionId: 'sess_9' }, input: 'and then?' })
  })
})

describe('qoder-cloud-agents adapter', () => {
  it('creates a session on the first turn and streams messages, activity and the replay state', async () => {
    stubGitHub()
    const mock = await startMockQoder({
      stream: async (s: StreamContext) => {
        s.emit({ type: 'session.status_running' })
        const tool = s.emit({ type: 'agent.tool_use', name: 'Bash', input: { command: 'npm test' } })
        s.emit({ type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [tool] } })
        await s.waitFor('user.tool_confirmation')
        s.emit({ type: 'agent.tool_result', tool_use_id: tool, is_error: true, content: [{ type: 'text', text: '1 failing' }] })
        s.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Fixed it and pushed.' }] })
        s.emit({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } })
      },
    })
    cleanups.push(mock.close)
    const chunks = await collect(adapterFor(mock.baseURL).stream(options([system, user('u1', 'fix the tests')])))

    const created = mock.requests.find(r => r.path === '/sessions')!.body
    expect(created).toMatchObject({
      agent: 'agent_1',
      environment_id: 'env_1',
      metadata: { mode: 'cloud' },
      resources: [{ type: 'github_repository', url: 'https://github.com/acme/widgets.git', mount_path: '/data/workspace/widgets', authorization_token: 'ghp_test' }],
    })
    const message = mock.posted.find(e => e.type === 'user.message')!.content[0].text as string
    expect(message).toMatch(/^You are working in a Qoder Cloud sandbox[\s\S]*mounted at `\/data\/workspace\/widgets`[\s\S]*---\n\nfix the tests$/)

    expect(texts(chunks, 'reasoning')).toEqual([
      expect.stringMatching(/^Qoder Cloud session sess_1 · repository https:\/\/github.com\/acme\/widgets.git → branch qoder-cloud-agents\/[0-9a-f]{8}$/),
      '› Bash: npm test',
      '  ✗ 1 failing',
    ])
    expect(texts(chunks, 'text')).toEqual(['Fixed it and pushed.'])
    expect(chunks.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' }, replayState: { response: { remoteSessionId: 'sess_1' } } })
    // Block indexes are unique and each block is closed before the next opens.
    const starts = chunks.filter(c => c.type === 'block-start').map(c => (c as { index: number }).index)
    expect(new Set(starts).size).toBe(starts.length)
  })

  it('continues the same remote session on a follow-up without the preamble', async () => {
    const mock = await startMockQoder({
      stream: async (s) => {
        s.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Sure.' }] })
        s.emit({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } })
      },
    })
    cleanups.push(mock.close)
    const chunks = await collect(adapterFor(mock.baseURL).stream(options([
      system, user('u1', 'fix the tests'), reply('a1', 'done', 'sess_1'), user('u2', 'also update the README'),
    ])))
    expect(mock.requests.map(r => r.path)).not.toContain('/sessions')
    expect(mock.posted.find(e => e.type === 'user.message')!.content[0].text).toBe('also update the README')
    expect(texts(chunks, 'text')).toEqual(['Sure.'])
  })

  it('titles a session from the framed first human message', async () => {
    const mock = await startMockQoder({ stream: async () => {} })
    cleanups.push(mock.close)
    const framed = user('t', 'Generate the session title from this JSON array of human messages:\n'
      + JSON.stringify([{ seq: 3, text: '帮我看看这个仓库的状态' }]), 'dsh-session-title-llm')
    const chunks = await collect(adapterFor(mock.baseURL).stream(options([framed], { purpose: 'session-title' })))
    expect(texts(chunks, 'text')).toEqual(['帮我看看这个仓库的状态'])
    expect(mock.requests).toEqual([])
  })

  it('answers session titles locally', async () => {
    const mock = await startMockQoder({ stream: async () => {} })
    cleanups.push(mock.close)
    const chunks = await collect(adapterFor(mock.baseURL).stream(options([user('u1', 'Refactor the payment module\nand more')], { purpose: 'session-title' })))
    expect(texts(chunks, 'text')).toEqual(['Refactor the payment module'])
    expect(mock.requests).toEqual([])
  })

  it('turns a failed remote turn into an LlmError carrying the platform message', async () => {
    const mock = await startMockQoder({
      stream: async (s) => {
        s.emit({ type: 'session.error', error: { type: 'model_error', message: 'upstream overloaded', retry_status: { type: 'exhausted' } } })
        s.emit({ type: 'session.status_idle', stop_reason: { type: 'retries_exhausted' } })
      },
    })
    cleanups.push(mock.close)
    const failure = collect(adapterFor(mock.baseURL, { repository: 'none' }).stream(options([user('u1', 'x')])))
    await expect(failure).rejects.toBeInstanceOf(LlmError)
    await expect(failure).rejects.toThrow('upstream overloaded')
  })

  it('never retries a turn and advertises one model', async () => {
    const adapter = adapterFor('https://qoder.invalid')
    expect(adapter.providerRetryPolicy('qoder-cloud-agents')).toMatchObject({ mode: 'normal', maxRetries: 0 })
    expect(await adapter.listModels('qoder-cloud-agents')).toEqual([expect.objectContaining({
      provider: 'qoder-cloud-agents', id: 'agent', name: '云端模式（Qoder Cloud Agents）',
    })])
    expect(adapter.providerInfo('qoder-cloud-agents')).toEqual({ id: 'qoder-cloud-agents', name: 'Qoder Cloud Agents' })
  })
})

describe('cloud-route preset plugin', () => {
  it('pins the request route to qoder-cloud-agents and drops local-model controls', async () => {
    const ctx = new Context()
    await ctx.plugin(route)
    // A later, inner listener (e.g. a manual model pick) cannot win over the prepended route.
    ctx.on('agent/request' as never, (async (_payload: unknown, next: () => Promise<unknown>) => ({ ...await next() as object, provider: 'deepseek-official', model: 'deepseek-flash' })) as never)
    const resolved = await (ctx as any).waterfall('agent/request', { agent: {}, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'high', maxTokens: 8000, temperature: 0.2 }))
    expect(resolved).toEqual({ provider: 'qoder-cloud-agents', model: 'agent', temperature: 0.2 })
    await ctx.fiber.dispose()
  })

  it('pins the {{provider}} / {{model}} prompt variables so the persona line stays stable across turns', async () => {
    const ctx = new Context()
    await ctx.plugin(route)
    const assembly = { sections: [], contexts: [], tools: [], variables: { provider: 'deepseek', model: 'deepseek-flash', cwd: '/w' } }
    const resolved = await (ctx as any).waterfall('system-prompt/assemble', assembly, {}, async () => assembly)
    expect(resolved.variables).toEqual({ provider: 'qoder-cloud-agents', model: 'agent', cwd: '/w' })
    await ctx.fiber.dispose()
  })
})
