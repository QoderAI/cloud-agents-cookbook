import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: any
}

type Script = (ctx: StreamContext) => Promise<void>

export interface StreamContext {
  /** Write one event frame (also appended to the session history). */
  emit(event: Record<string, unknown>): string
  heartbeat(): void
  /** Drop the connection without a terminating frame. */
  drop(): void
  /** Resolve when the client posts an event of `type`. */
  waitFor(type: string): Promise<any>
  readonly lastEventId: string | undefined
  readonly connection: number
}

/** Scriptable stand-in for the Qoder Cloud Agents gateway. */
export async function startMockQoder(options: {
  environments?: { id: string; name: string; archived_at?: string | null; config?: { type: string } }[]
  agents?: { id: string; name: string }[]
  stream: Script
  /** Fixed port for standalone use; default picks a free one. */
  port?: number
  /** Session id returned by POST /sessions (default `sess_1`). */
  sessionId?: string
}) {
  const sid = options.sessionId ?? 'sess_1'
  const requests: RecordedRequest[] = []
  const posted: any[] = []
  const waiters: { type: string; resolve: (event: any) => void }[] = []
  let seq = 0
  let connections = 0
  const nextId = () => `sevt_${String(++seq).padStart(4, '0')}`

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname.replace(/^\/api\/v1\/cloud/, '')
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw.length > 0 ? JSON.parse(raw) : undefined
    requests.push({ method: req.method ?? 'GET', path: `${path}${url.search}`, headers: req.headers, body })
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.headers.authorization !== 'Bearer pt-test') {
      json(401, { type: 'error', request_id: 'req_1', error: { type: 'authentication_error', message: 'bad token' } })
      return
    }
    if (req.method === 'GET' && path === '/environments') return json(200, { data: options.environments ?? [] })
    if (req.method === 'POST' && path === '/environments') return json(200, { id: 'env_new', name: body.name })
    if (req.method === 'GET' && path === '/agents') return json(200, { data: options.agents ?? [] })
    if (req.method === 'POST' && path === '/agents') return json(200, { id: 'agent_new', name: body.name, version: 1 })
    if (req.method === 'POST' && path === '/sessions') return json(200, { id: sid, status: 'idle' })
    if (req.method === 'POST' && path === `/sessions/${sid}/events`) {
      const data = body.events.map((event: any) => ({ ...event, id: nextId() }))
      posted.push(...data)
      for (const event of data) {
        for (const waiter of waiters.filter(w => w.type === event.type)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(event)
        }
      }
      return json(200, { data })
    }
    if (req.method === 'POST' && path === `/sessions/${sid}/cancel`) return json(202, { id: sid, type: 'session', status: 'canceling' })
    if (req.method === 'POST' && path === `/sessions/${sid}/archive`) return json(200, { id: sid, status: 'terminated' })
    if (req.method === 'GET' && path === `/sessions/${sid}/events/stream`) return stream(req, res)
    json(404, { type: 'error', error: { type: 'not_found_error', message: path } })
  })

  const stream = async (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.flushHeaders()
    const header = req.headers['last-event-id']
    const ctx: StreamContext = {
      emit(event) {
        const id = nextId()
        const frame = JSON.stringify({ id, processed_at: new Date().toISOString(), ...event })
        res.write(`id: ${id}\r\nevent: ${String(event.type)}\r\ndata: ${frame}\r\n\r\n`)
        return id
      },
      heartbeat() { res.write(': heartbeat\n\n') },
      drop() { setTimeout(() => res.destroy(), 50) },
      waitFor(type) {
        const seen = posted.find(e => e.type === type && !e.consumed)
        if (seen !== undefined) {
          seen.consumed = true
          return Promise.resolve(seen)
        }
        return new Promise(resolve => waiters.push({ type, resolve }))
      },
      lastEventId: Array.isArray(header) ? header[0] : header,
      connection: ++connections,
    }
    try {
      await options.stream(ctx)
    } catch {
      // client went away
    }
  }

  // Bind the default address and connect back through whatever the OS reports.
  await new Promise<void>(resolve => server.listen(options.port ?? 0, resolve))
  const { address, port } = server.address() as AddressInfo
  const host = address.includes(':') ? `[${address}]` : address
  return {
    baseURL: `http://${host}:${port}/api/v1/cloud`,
    requests,
    posted,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
