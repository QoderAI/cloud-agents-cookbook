import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime, { type SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { httpsRemote, httpsRemoteUsername, type LocalRepository } from '../src/git.ts'
import { SseParser } from '../src/sse.ts'
import { cloudPrompt, repositoryResource } from '../src/run.ts'
import { startMockQoder, type StreamContext } from './mock-server.ts'

class FixtureWorkingDirectory extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workingDirectory')
  }
  get(): string { return process.cwd() }
  async ensure(): Promise<string> { return process.cwd() }
  async set(_agent: unknown, path: string): Promise<string> { return path }
}

async function mountProvider(config: plugin.Config) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(FixtureWorkingDirectory)
  await ctx.plugin(SubagentRuntime)
  const fiber = await ctx.plugin(plugin, config)
  const provider = ctx.subagents.getProvider('qoder-cloud-agents') as SubagentProvider
  return { ctx, fiber, provider }
}

function start(provider: SubagentProvider, cwd: string, text: string, signal = new AbortController().signal) {
  return provider.start!({
    cwd,
    prompt: [{ type: 'text', text }],
    parent: {} as Agent,
    signal,
  })
}

let repo: string
let plain: string
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim()

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'qoder-repo-'))
  plain = mkdtempSync(join(tmpdir(), 'qoder-plain-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 't')
  writeFileSync(join(repo, 'a.txt'), 'a')
  git('add', '.')
  git('commit', '-q', '-m', 'one')
  git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  writeFileSync(join(repo, 'b.txt'), 'b')
  git('add', '.')
  git('commit', '-q', '-m', 'two (unpushed)')
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(plain, { recursive: true, force: true })
})

/** Scripted `api.github.com/repos/:owner/:repo` answers; everything else goes to the network/mock. */
let githubAnswer: (auth: string | undefined) => Response
const realFetch = globalThis.fetch
beforeEach(() => {
  githubAnswer = () => new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('https://api.github.com/')) {
      const auth = new Headers(init?.headers).get('authorization') ?? undefined
      return githubAnswer(auth)
    }
    return realFetch(input, init)
  })
})
afterEach(() => { vi.restoreAllMocks() })

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

describe('SseParser', () => {
  it('reassembles frames across chunks, CRLF endings and heartbeats', () => {
    const parser = new SseParser()
    expect(parser.push(': heartbeat\n\nid: e1\r')).toEqual([])
    expect(parser.push('\nevent: agent.message\r\ndata: {"a":')).toEqual([])
    expect(parser.push('1}\r\n\r\ndata: x\ndata: y\n\n')).toEqual([
      { id: 'e1', event: 'agent.message', data: '{"a":1}' },
      { id: 'e1', event: 'message', data: 'x\ny' },
    ])
  })
})

describe('httpsRemote', () => {
  it('normalizes ssh, scp-like and credentialed remotes', () => {
    expect(httpsRemote('git@github.com:acme/widgets.git')).toBe('https://github.com/acme/widgets.git')
    expect(httpsRemote('ssh://git@code.example.com:2222/team/repo.git')).toBe('https://code.example.com/team/repo.git')
    expect(httpsRemote('https://user:secret@code.example.com/team/repo.git')).toBe('https://code.example.com/team/repo.git')
    expect(httpsRemote('/srv/git/repo.git')).toBeUndefined()
  })
})

describe('cloudPrompt', () => {
  it('leaves the task untouched without a repository', () => {
    expect(cloudPrompt('do it', undefined, undefined)).toBe('do it')
  })
})

describe('qoder-cloud-agents provider', () => {
  it('registers, validates config and unregisters on dispose', async () => {
    const { ctx, fiber, provider } = await mountProvider({ token: 'pt-test' })
    expect(provider).toMatchObject({
      name: 'qoder-cloud-agents',
      inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    })
    await fiber.dispose()
    expect(ctx.subagents.list()).toEqual([])
    await expect(ctx.plugin(plugin, { timeoutMs: 0 })).rejects.toThrow('timeoutMs')
    await expect(ctx.plugin(plugin, { baseURL: 'not a url' })).rejects.toThrow('baseURL')
    await ctx.fiber.dispose()
  })

  it('runs a task end to end: repo mount, resume after a dropped stream, tool confirmation', async () => {
    const mock = await startMockQoder({
      environments: [
        { id: 'env_old', name: 'Default', archived_at: '2026-01-01T00:00:00Z', config: { type: 'cloud' } },
        { id: 'env_1', name: 'Default', config: { type: 'cloud' } },
      ],
      stream: async (s) => {
        if (s.connection === 1) {
          s.heartbeat()
          s.emit({ type: 'session.status_running' })
          s.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Working on it' }] })
          s.drop()
          return
        }
        const toolUse = s.emit({ type: 'agent.tool_use', name: 'Bash', input: { command: 'git push' } })
        s.emit({ type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [toolUse] } })
        const confirmation = await s.waitFor('user.tool_confirmation')
        expect(confirmation).toMatchObject({ tool_use_id: toolUse, result: 'allow' })
        s.emit({ type: 'agent.artifact_delivered', file_id: 'file_1', original_filename: 'report.md', size: 12 })
        s.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Done. Pushed ' }, { type: 'text', text: 'branch X.' }] })
        s.emit({ type: 'session.usage', total_credits: 1 })
        s.emit({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } })
      },
    })
    cleanups.push(mock.close)
    process.env.QODER_GIT_TOKEN_E2E = 'ghp_test'
    const { fiber, provider } = await mountProvider({ token: 'pt-test', baseURL: mock.baseURL, gitTokenEnv: 'QODER_GIT_TOKEN_E2E' })
    cleanups.push(() => fiber.dispose())

    const run = await start(provider, repo, 'Fix the flaky test')
    const result = await run.result
    await run.dispose()

    expect(result.stopReason).toBe('completed')
    const text = (result.output[0] as { text: string }).text
    expect(text).toMatch(/^Done\. Pushed branch X\./)
    expect(text).toContain('[Qoder Cloud] session sess_1 · stop_reason end_turn')
    expect(text).toContain('report.md (file_1, 12 bytes)')
    expect(text).toContain('1 local commit(s) on main are not pushed')
    expect(text).toContain('Environment: Default (env_1) — the only environment')
    expect(text).toContain('Not saved to the profile')

    const calls = mock.requests.map(r => `${r.method} ${r.path}`)
    expect(calls).toContain('POST /agents')
    const agent = mock.requests.find(r => r.method === 'POST' && r.path === '/agents')!.body
    expect(agent).toMatchObject({ name: 'dsh-qoder-cloud-delegate', model: 'ultimate', tools: [{ type: 'agent_toolset_20260401' }] })
    const session = mock.requests.find(r => r.method === 'POST' && r.path === '/sessions')!
    expect(session.headers['idempotency-key']).toBeTruthy()
    expect(session.body).toMatchObject({
      agent: 'agent_new',
      environment_id: 'env_1',
      title: 'Fix the flaky test',
      resources: [{ type: 'github_repository', url: 'https://github.com/acme/widgets.git', mount_path: '/data/workspace/widgets', checkout: { type: 'branch', name: 'main' }, authorization_token: 'ghp_test' }],
    })
    const message = mock.posted.find(e => e.type === 'user.message')
    expect(message.content[0].text).toMatch(/Fix the flaky test[\s\S]*git push -u origin qoder-cloud-agents\/[0-9a-f]{8}/)
    expect(message.content[0].text).toContain('mounted in this sandbox at `/data/workspace/widgets`')
    expect(message.content[0].text).toContain('First check that the mounted repository exists')

    const streams = mock.requests.filter(r => r.path === '/sessions/sess_1/events/stream')
    expect(streams).toHaveLength(2)
    expect(streams[0]!.headers['last-event-id']).toBe(message.id)
    // Resumed after the last event delivered before the drop.
    expect(streams[1]!.headers['last-event-id']).not.toBe(message.id)
    expect(calls).not.toContain('POST /sessions/sess_1/cancel')
  })

  it('maps a platform error turn to stopReason error with the session.error message', async () => {
    const mock = await startMockQoder({
      environments: [{ id: 'env_1', name: 'default', config: { type: 'cloud' } }],
      agents: [{ id: 'agent_existing', name: 'dsh-qoder-cloud-delegate' }],
      stream: async (s) => {
        s.emit({ type: 'session.error', error: { type: 'model_error', message: 'upstream overloaded', retry_status: { type: 'exhausted' } } })
        s.emit({ type: 'session.status_idle', stop_reason: { type: 'retries_exhausted' } })
      },
    })
    cleanups.push(mock.close)
    const { fiber, provider } = await mountProvider({ token: 'pt-test', baseURL: mock.baseURL, archiveOnFinish: true })
    cleanups.push(() => fiber.dispose())

    const run = await start(provider, plain, 'Summarize')
    const result = await run.result
    await run.dispose()
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe('upstream overloaded')
    const calls = mock.requests.map(r => `${r.method} ${r.path}`)
    expect(calls).not.toContain('POST /agents')
    const session = mock.requests.find(r => r.method === 'POST' && r.path === '/sessions')!.body
    expect(session.agent).toBe('agent_existing')
    expect(session.resources).toBeUndefined()
    expect(calls).toContain('POST /sessions/sess_1/archive')
  })

  it('cancels the remote turn when the parent aborts', async () => {
    const mock = await startMockQoder({
      environments: [{ id: 'env_1', name: 'default', config: { type: 'cloud' } }],
      stream: async (s) => {
        s.emit({ type: 'agent.message', content: [{ type: 'text', text: 'partial' }] })
        await new Promise(() => {})
      },
    })
    cleanups.push(mock.close)
    const { fiber, provider } = await mountProvider({ token: 'pt-test', baseURL: mock.baseURL })
    cleanups.push(() => fiber.dispose())

    const controller = new AbortController()
    const run = await start(provider, plain, 'Long task', controller.signal)
    await new Promise(resolve => setTimeout(resolve, 100))
    controller.abort()
    const result = await run.result
    await run.dispose()
    expect(result.stopReason).toBe('aborted')
    expect((result.output[0] as { text: string }).text).toContain('partial')
    expect(mock.requests.map(r => `${r.method} ${r.path}`)).toContain('POST /sessions/sess_1/cancel')
  })

  it('fails the delegation call itself on a rejected PAT', async () => {
    const mock = await startMockQoder({ stream: async () => {} })
    cleanups.push(mock.close)
    const { fiber, provider } = await mountProvider({ token: 'pt-wrong', baseURL: mock.baseURL })
    cleanups.push(() => fiber.dispose())
    await expect(start(provider, plain, 'x')).rejects.toThrow('401 authentication_error: bad token')
  })

  it('reports a missing PAT before any request', async () => {
    const { fiber, provider } = await mountProvider({ tokenEnv: 'QODER_PAT_DEFINITELY_UNSET' })
    cleanups.push(() => fiber.dispose())
    await expect(start(provider, plain, 'x')).rejects.toThrow('no Qoder PAT')
  })
})

const ENVIRONMENTS = [
  { id: 'env_byoc', name: 'team byoc', config: { type: 'self_hosted' } },
  { id: 'env_cli', name: 'CLI tools', config: { type: 'cloud' } },
  { id: 'env_a', name: 'Default', config: { type: 'cloud' } },
  { id: 'env_b', name: 'Default', config: { type: 'cloud' } },
]
const idleStream = async (s: StreamContext) => {
  s.emit({ type: 'agent.message', content: [{ type: 'text', text: 'ok' }] })
  s.emit({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } })
}

class StubSettings extends Service {
  readonly writes: { ns: string; ops: unknown[] }[] = []
  constructor(ctx: Context) { super(ctx, 'settings') }
  describe() { return [{ ns: 'qoder-cloud-agents', revision: 0 }] }
  async mutate(ns: string, ops: unknown[]) { this.writes.push({ ns, ops }) }
}

function stubQuestions(answer: (questions: any[]) => any) {
  return class StubQuestions extends Service {
    readonly asked: any[][] = []
    constructor(ctx: Context) { super(ctx, 'userQuestions') }
    async ask(request: { questions: any[] }) {
      this.asked.push(request.questions)
      return answer(request.questions)
    }
  }
}

class StubCommands extends Service {
  readonly definitions: any[] = []
  constructor(ctx: Context) { super(ctx, 'commands') }
  register(definition: any) {
    this.definitions.push(definition)
    return () => {}
  }
}

async function mountWith(services: (typeof Service<any>)[], config: plugin.Config) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(FixtureWorkingDirectory)
  await ctx.plugin(SubagentRuntime)
  for (const service of services) await ctx.plugin(service as any)
  const fiber = await ctx.plugin(plugin, config)
  cleanups.push(() => fiber.dispose())
  return { ctx, provider: ctx.subagents.getProvider('qoder-cloud-agents') as SubagentProvider }
}

describe('environment / agent selection', () => {
  it('uses explicit config without listing anything', async () => {
    const mock = await startMockQoder({ environments: ENVIRONMENTS, stream: idleStream })
    cleanups.push(mock.close)
    const { provider } = await mountWith([], { token: 'pt-test', baseURL: mock.baseURL, environmentId: 'env_b', agentId: 'agent_x' } as any)
    const result = await (await start(provider, plain, 'x')).result
    expect(result.stopReason).toBe('completed')
    const calls = mock.requests.map(r => `${r.method} ${r.path}`)
    expect(calls).not.toContain('GET /environments?limit=100')
    expect(calls).not.toContain('GET /agents?limit=100')
    expect(mock.requests.find(r => r.path === '/sessions')!.body).toMatchObject({ environment_id: 'env_b', agent: 'agent_x' })
  })

  it('fails headless when several cloud environments exist, naming the candidates', async () => {
    const mock = await startMockQoder({ environments: ENVIRONMENTS, stream: idleStream })
    cleanups.push(mock.close)
    const { provider } = await mountWith([], { token: 'pt-test', baseURL: mock.baseURL })
    const failure = start(provider, plain, 'x')
    await expect(failure).rejects.toThrow('4 Qoder Cloud environments are available and no one can be asked to choose')
    const message = await failure.catch((e: Error) => e.message)
    expect(message).toContain('environmentId: env_cli')
    expect(message).toContain('env_a  Default')
    expect(message).toContain('env_byoc  team byoc  (self-hosted (BYOC)')
    expect(mock.requests.map(r => r.path)).not.toContain('/sessions')
  })

  it('treats an environment without a config type as managed cloud, but never auto-picks a lone BYOC one', async () => {
    const plainEnv = await startMockQoder({ environments: [{ id: 'env_plain', name: 'old' }], stream: idleStream })
    cleanups.push(plainEnv.close)
    const first = await mountWith([], { token: 'pt-test', baseURL: plainEnv.baseURL })
    await (await start(first.provider, plain, 'x')).result
    expect(plainEnv.requests.find(r => r.path === '/sessions')!.body.environment_id).toBe('env_plain')

    const byocOnly = await startMockQoder({ environments: [{ id: 'env_byoc', name: 'byoc', config: { type: 'self_hosted' } }], stream: idleStream })
    cleanups.push(byocOnly.close)
    const second = await mountWith([], { token: 'pt-test', baseURL: byocOnly.baseURL })
    await expect(start(second.provider, plain, 'x')).rejects.toThrow('the only Qoder Cloud environment is self-hosted (BYOC) and no one can be asked')
  })

  it('treats a NO_PROVIDER answerer like headless', async () => {
    const mock = await startMockQoder({ environments: ENVIRONMENTS, stream: idleStream })
    cleanups.push(mock.close)
    const Questions = stubQuestions(() => { throw Object.assign(new Error('no answerer'), { code: 'NO_PROVIDER' }) })
    const { provider } = await mountWith([Questions], { token: 'pt-test', baseURL: mock.baseURL })
    await expect(start(provider, plain, 'x')).rejects.toThrow('no interactive UI is attached')
  })

  it('asks once, uses the answer, saves it, and does not ask again', async () => {
    const mock = await startMockQoder({ environments: ENVIRONMENTS, agents: [{ id: 'agent_cr', name: 'Code Review' }], stream: idleStream })
    cleanups.push(mock.close)
    const Questions = stubQuestions(questions => ({
      answers: questions.map(q => q.id === 'qoder-cloud-agents-environment'
        ? { id: q.id, selected: ['Default · env_b'] }
        : { id: q.id, selected: ['Code Review · agent_cr'] }),
    }))
    const { ctx, provider } = await mountWith([Questions, StubSettings], { token: 'pt-test', baseURL: mock.baseURL })
    const [first, second] = await Promise.all([start(provider, plain, 'one'), start(provider, plain, 'two')])
    const results = await Promise.all([first.result, second.result])
    const questions = (ctx as any).userQuestions.asked
    expect(questions).toHaveLength(1)
    expect(questions[0].map((q: any) => q.id)).toEqual(['qoder-cloud-agents-environment', 'qoder-cloud-agents-agent'])
    const envOptions = questions[0][0].options.map((o: any) => o.label)
    expect(envOptions).toEqual(['CLI tools · env_cli', 'Default · env_a', 'Default · env_b', 'team byoc · env_byoc', 'Create a new environment "dsh-default"'])
    const sessions = mock.requests.filter(r => r.path === '/sessions').map(r => r.body)
    expect(sessions.map(b => [b.environment_id, b.agent])).toEqual([['env_b', 'agent_cr'], ['env_b', 'agent_cr']])
    expect((ctx as any).settings.writes).toEqual([{
      ns: 'qoder-cloud-agents',
      ops: [{ op: 'set', path: ['environmentId'], value: 'env_b' }, { op: 'set', path: ['agentId'], value: 'agent_cr' }],
    }])
    // Whichever run won the selection queue reports how the binding was chosen.
    const footers = results.map(result => (result.output[0] as { text: string }).text)
    expect(footers.filter(text => text.includes('Saved to this profile; change with /qoder-cloud-agents.'))).toHaveLength(1)
  })

  it('accepts a free-text environment id, including a self-hosted one', async () => {
    const mock = await startMockQoder({ environments: ENVIRONMENTS, agents: [{ id: 'agent_m', name: 'dsh-qoder-cloud-delegate' }], stream: idleStream })
    cleanups.push(mock.close)
    const Questions = stubQuestions(questions => ({ answers: questions.map(q => ({ id: q.id, selected: [], custom: 'env_byoc' })) }))
    const { ctx, provider } = await mountWith([Questions], { token: 'pt-test', baseURL: mock.baseURL })
    await (await start(provider, plain, 'x')).result
    expect((ctx as any).userQuestions.asked[0].map((q: any) => q.id)).toEqual(['qoder-cloud-agents-environment'])
    expect(mock.requests.find(r => r.path === '/sessions')!.body).toMatchObject({ environment_id: 'env_byoc', agent: 'agent_m' })
  })
})

describe('/qoder-cloud-agents command', () => {
  it('lists, sets and resets the saved binding', async () => {
    const mock = await startMockQoder({ environments: ENVIRONMENTS, agents: [{ id: 'agent_cr', name: 'Code Review' }], stream: idleStream })
    cleanups.push(mock.close)
    const { ctx, provider } = await mountWith([StubCommands, StubSettings], { token: 'pt-test', baseURL: mock.baseURL })
    const command = (ctx as any).commands.definitions[0]
    expect(command.name).toBe('qoder-cloud-agents')
    const run = (rawInput: string) => command.handler({ rawInput, signal: new AbortController().signal, agent: {}, attachments: [] })

    const list = await run(' env')
    expect(list.kind).toBe('success')
    expect(list.text).toContain('env_byoc  team byoc  (self-hosted (BYOC)')

    expect((await run(' env Default')).text).toContain('several environments are named "Default"')
    const set = await run(' env env_a')
    expect(set.text).toContain('Environment set to Default (env_a).\nSaved to this profile.')
    const agent = await run(' agent new')
    expect(agent.text).toContain('Agent set to dsh-qoder-cloud-delegate (agent_new)')

    // The command's choice is used without asking (no userQuestions mounted).
    await (await start(provider, plain, 'x')).result
    expect(mock.requests.find(r => r.path === '/sessions')!.body).toMatchObject({ environment_id: 'env_a', agent: 'agent_new' })

    expect((await run(' reset')).kind).toBe('success')
    expect((ctx as any).settings.writes.at(-1).ops).toEqual([
      { op: 'unset', path: ['environmentId'] },
      { op: 'unset', path: ['agentId'] },
    ])
    await expect(start(provider, plain, 'y')).rejects.toThrow('no one can be asked to choose')
    expect((await run(' bogus')).kind).toBe('error')
  })
})


describe('GitHub pre-flight', () => {
  let ghRepo: string
  const gitIn = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim()
  beforeAll(() => {
    ghRepo = mkdtempSync(join(tmpdir(), 'qoder-gh-'))
    gitIn(ghRepo, 'init', '-q', '-b', 'feature')
    gitIn(ghRepo, 'config', 'user.email', 't@example.com')
    gitIn(ghRepo, 'config', 'user.name', 't')
    writeFileSync(join(ghRepo, 'a.txt'), 'a')
    gitIn(ghRepo, 'add', '.')
    gitIn(ghRepo, 'commit', '-q', '-m', 'one')
    gitIn(ghRepo, 'remote', 'add', 'origin', 'https://github.com/acme/secret.git')
  })
  afterAll(() => rmSync(ghRepo, { recursive: true, force: true }))

  const ENV = [{ id: 'env_1', name: 'Default', config: { type: 'cloud' } }]

  it('refuses a private repository without a token before creating a session', async () => {
    githubAnswer = () => new Response('{"message":"Not Found"}', { status: 404 })
    const mock = await startMockQoder({ environments: ENV, stream: idleStream })
    cleanups.push(mock.close)
    const { provider } = await mountWith([], { token: 'pt-test', baseURL: mock.baseURL, gitTokenEnv: 'QODER_GIT_TOKEN_UNSET' })
    await expect(start(provider, ghRepo, 'x')).rejects.toThrow('acme/secret is private or does not exist; set QODER_GIT_TOKEN_UNSET')
    expect(mock.requests.map(r => r.path)).not.toContain('/sessions')
  })

  it('rejects a token GitHub does not accept', async () => {
    githubAnswer = () => new Response('{}', { status: 401 })
    process.env.QODER_GIT_TOKEN_BAD = 'ghp_bad'
    const mock = await startMockQoder({ environments: ENV, stream: idleStream })
    cleanups.push(mock.close)
    const { provider } = await mountWith([], { token: 'pt-test', baseURL: mock.baseURL, gitTokenEnv: 'QODER_GIT_TOKEN_BAD' })
    await expect(start(provider, ghRepo, 'x')).rejects.toThrow('token in QODER_GIT_TOKEN_BAD was rejected')
  })

  it('warns when the token cannot push, and drops the commit checkout the platform ignores', async () => {
    let seenAuth: string | undefined
    githubAnswer = (auth) => {
      seenAuth = auth
      return new Response(JSON.stringify({ permissions: { push: false } }), { status: 200 })
    }
    process.env.QODER_GIT_TOKEN_RO = 'ghp_readonly'
    const mock = await startMockQoder({ environments: ENV, stream: idleStream })
    cleanups.push(mock.close)
    const { provider } = await mountWith([], { token: 'pt-test', baseURL: mock.baseURL, gitTokenEnv: 'QODER_GIT_TOKEN_RO' })
    const result = await (await start(provider, ghRepo, 'x')).result
    expect(seenAuth).toBe('Bearer ghp_readonly')
    const text = (result.output[0] as { text: string }).text
    expect(text).toContain('Note: the token in QODER_GIT_TOKEN_RO has no push access to acme/secret')
    const resource = mock.requests.find(r => r.path === '/sessions')!.body.resources[0]
    expect(resource).toEqual({ type: 'github_repository', url: 'https://github.com/acme/secret.git', mount_path: '/data/workspace/secret', authorization_token: 'ghp_readonly' })
    const message = mock.posted.find(e => e.type === 'user.message')
    expect(message.content[0].text).toMatch(/default branch; before working, run `git fetch origin [0-9a-f]{40} && git checkout [0-9a-f]{40}`/)
  })

  it('notes that a public repository without a token cannot be pushed to', async () => {
    githubAnswer = () => new Response(JSON.stringify({}), { status: 200 })
    const mock = await startMockQoder({ environments: ENV, stream: idleStream })
    cleanups.push(mock.close)
    const { provider } = await mountWith([], { token: 'pt-test', baseURL: mock.baseURL, gitTokenEnv: 'QODER_GIT_TOKEN_UNSET' })
    const result = await (await start(provider, ghRepo, 'x')).result
    expect((result.output[0] as { text: string }).text).toContain('no QODER_GIT_TOKEN_UNSET is set: the cloud agent can read this public repository but cannot push')
    expect(mock.requests.find(r => r.path === '/sessions')!.body.resources[0].authorization_token).toBeUndefined()
  })
})


describe('repository resources (aligned with the Qoder console)', () => {
  const code: LocalRepository = {
    url: 'https://git.example.com/team/svc.git',
    github: false,
    name: 'svc',
    mountPath: '/data/workspace/svc',
    head: 'a'.repeat(40),
    checkout: { type: 'branch', name: 'master' },
    warnings: [],
  }

  it('reads the account from an https origin but not from ssh', () => {
    expect(httpsRemoteUsername('https://alice@git.example.com/team/svc.git')).toBe('alice')
    expect(httpsRemoteUsername('https://alice:secret@git.example.com/team/svc.git')).toBe('alice')
    expect(httpsRemoteUsername('git@gitlab.example.com:team/svc.git')).toBeUndefined()
    expect(httpsRemoteUsername('ssh://git@gitlab.example.com/team/svc.git')).toBeUndefined()
    expect(httpsRemoteUsername('https://git.example.com/team/svc.git')).toBeUndefined()
  })

  it('puts the account in the URL and the token in password', () => {
    expect(repositoryResource(code, { gitToken: 'pt_code', gitUsername: 'alice.w' })).toEqual({
      type: 'git_repository',
      url: 'https://alice.w@git.example.com/team/svc.git',
      password: 'pt_code',
      mount_path: '/data/workspace/svc',
      checkout: { type: 'branch', name: 'master' },
    })
  })

  it('falls back to the origin URL account', () => {
    const resource = repositoryResource({ ...code, remoteUsername: 'alice' }, { gitToken: 'pt_code' })
    expect(resource).toMatchObject({ url: 'https://alice@git.example.com/team/svc.git', password: 'pt_code' })
  })

  it('requires an account when a token is set', () => {
    expect(() => repositoryResource(code, { gitToken: 'pt_code', gitTokenEnv: 'QODER_GIT_TOKEN' }))
      .toThrow('git.example.com needs an account name with QODER_GIT_TOKEN; set gitUsername')
  })

  it('sends a public clone without account or password when no token is set', () => {
    expect(repositoryResource({ ...code, remoteUsername: 'alice' }, {})).toEqual({
      type: 'git_repository',
      url: 'https://git.example.com/team/svc.git',
      mount_path: '/data/workspace/svc',
      checkout: { type: 'branch', name: 'master' },
    })
  })

  it('fails a token-authenticated delegation before prompting or creating a session when the account is missing', async () => {
    const codeRepo = mkdtempSync(join(tmpdir(), 'qoder-code-'))
    cleanups.push(async () => rmSync(codeRepo, { recursive: true, force: true }))
    const g = (...args: string[]) => execFileSync('git', args, { cwd: codeRepo, stdio: 'pipe' })
    g('init', '-q', '-b', 'master'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 't')
    writeFileSync(join(codeRepo, 'a.txt'), 'a'); g('add', '.'); g('commit', '-q', '-m', 'one')
    g('remote', 'add', 'origin', 'git@gitlab.example.com:team/svc.git')
    process.env.QODER_GIT_TOKEN_CODE = 'pt_code'
    const mock = await startMockQoder({ environments: ENVIRONMENTS, stream: idleStream })
    cleanups.push(mock.close)
    const { provider } = await mountWith([], { token: 'pt-test', baseURL: mock.baseURL, gitTokenEnv: 'QODER_GIT_TOKEN_CODE' })
    await expect(start(provider, codeRepo, 'x')).rejects.toThrow('gitlab.example.com needs an account name')
    expect(mock.requests.map(r => r.path)).toEqual([])
  })
})
