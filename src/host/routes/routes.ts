/**
 * `/api/rdfoe-wf/*` Fetch routes (§5.1). Connection applies its trust fence
 * and browser authentication before any handler runs; routes are exact
 * paths, so identifiers travel in the query string or JSON body.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { diffSinceBase, branchLog } from '../git/git.ts'
import type { Hub, HubEvent } from '../runner/hub.ts'
import type { InboxRow, Store } from '../store/store.ts'
import { UserError, type WorkflowService } from '../workflow/service.ts'
import { NODE_LABEL, isStartTemplate, templateOf, type NodeKey } from '../workflow/template.ts'

export const API_PREFIX = '/api/rdfoe-wf'
const HEARTBEAT_MS = 15_000

interface Deps { store: Store, hub: Hub, service: WorkflowService, engage: (sessionId: string) => Promise<{ titled: boolean, engaged: boolean }>, devRoutes: boolean }

type SessionControllerLike = {
  list(r: object, s: AbortSignal): Promise<{ items: readonly { sessionId: string, origin?: string, parentSessionId?: string, running?: boolean, agentAvailable?: boolean, blank?: boolean, projections?: { values?: { title?: string } } }[] }>
  create(r: { cwd?: string }): Promise<{ sessionId: string }>
  prompt(r: { requestId: string, sessionId: string, mode: 'queue', content: { type: 'text', text: string }[] }, s: AbortSignal): Promise<unknown>
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json()
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

const parse = (text: string | null) => (text === null ? null : JSON.parse(text) as unknown)

export function inboxView(item: InboxRow, store: Store, titles: Map<string, string>) {
  const run = store.runById(item.run_id)
  const node = item.node_id ? store.nodeById(item.node_id) : undefined
  const agent = item.agent_session_id ? store.agentBySession(item.agent_session_id) : undefined
  return {
    id: item.id,
    kind: item.kind,
    blocking: item.blocking === 1,
    status: item.status,
    payload: parse(item.payload_json),
    response: parse(item.response_json),
    createdAt: item.created_at,
    resolvedAt: item.resolved_at,
    deliveredAt: item.delivered_at,
    round: item.round,
    runId: item.run_id,
    runTitle: run?.title ?? '',
    runStatus: run?.status ?? '',
    currentNode: run?.current_node ?? null,
    loopRound: run?.loop_round ?? 0,
    doneCount: run ? store.nodes(run.id).filter(n => n.status === 'SUCCEEDED' || n.status === 'APPROVED').length : 0,
    nodeCount: run ? templateOf(run).order.length : 0,
    template: run ? templateOf(run).id : 'full',
    sessionId: item.session_id,
    sessionTitle: titles.get(item.session_id) ?? null,
    nodeKey: node?.node_key ?? null,
    nodeLabel: node ? NODE_LABEL[node.node_key] : null,
    agentSessionId: item.agent_session_id,
    agentRole: agent?.role ?? null,
    agentAlive: agent?.status === 'RUNNING',
  }
}

export function registerRoutes(ctx: Context, deps: Deps): void {
  const { store, hub, service } = deps
  const controller = () => ctx.get('sessionController' as never) as SessionControllerLike | undefined

  // Host-side session titles without resuming any agent (H9); cached briefly.
  let titleCache: { at: number, map: Map<string, string> } | undefined
  const titles = async (signal: AbortSignal): Promise<Map<string, string>> => {
    if (titleCache && Date.now() - titleCache.at < 5_000) return titleCache.map
    const map = new Map<string, string>()
    try {
      const { items } = await controller()?.list({}, signal) ?? { items: [] }
      for (const i of items) if (i.projections?.values?.title) map.set(i.sessionId, i.projections.values.title)
    } catch { /* titles are decoration */ }
    titleCache = { at: Date.now(), map }
    return map
  }

  const runSnapshot = async (sessionId: string, signal: AbortSignal) => {
    let run = store.runBySession(sessionId)
    // A node agent session opens this view too (§9.1): point back to its workflow.
    const asAgent = run ? undefined : store.agentBySession(sessionId)
    if (!run && asAgent) {
      const owner = store.runById(asAgent.run_id)!
      return { run: null, nodeOf: { runId: owner.id, mainSessionId: owner.session_id, nodeKey: store.nodeById(asAgent.node_id)?.node_key, role: asAgent.role, version: asAgent.version } }
    }
    if (!run) return { run: null }
    run = store.runById(run.id)!
    const template = templateOf(run)
    const nodes = store.nodes(run.id).sort((a, b) => template.order.indexOf(a.node_key) - template.order.indexOf(b.node_key))
    const t = await titles(signal)
    return {
      run: { ...run, template: template.id },
      template: { id: template.id, label: template.label, order: template.order, loops: template.loops },
      designLoop: service.designTrend(run.id),
      nodes,
      versions: store.versionsOfRun(run.id),
      agents: store.agentsOfRun(run.id),
      reviews: store.reviewsOfRun(run.id),
      inbox: store.inbox({ runId: run.id }).map(i => inboxView(i, store, t)),
      loop: service.failTrend(run.id),
      events: store.events(run.id, 150),
      toolCalls: store.toolCalls(run.id, 600),
      pending: service.pendingCount(run.id),
    }
  }

  const inboxSnapshot = async (status: string, signal: AbortSignal) => {
    const t = await titles(signal)
    const items = store.inbox(status === 'all' ? {} : { status: status === 'done' ? 'RESOLVED' : 'OPEN' })
    const open = store.inbox({ status: 'OPEN' })
    return { openCount: open.length, blockingCount: open.filter(i => i.blocking === 1).length, items: items.map(i => inboxView(i, store, t)).reverse() }
  }

  const route = (path: string, methods: ('GET' | 'POST')[], handler: (request: Request) => Promise<Response>) =>
    ctx.connection.fetch.register({
      path: `${API_PREFIX}${path}`,
      methods,
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          return await handler(request)
        } catch (error) {
          if (error instanceof UserError) return json({ error: error.message }, error.status)
          return json({ error: String(error) }, 500)
        }
      },
    })

  /** NDJSON stream that re-sends a snapshot whenever a relevant hub event fires (debounced). */
  const stream = (request: Request, relevant: (event: HubEvent) => boolean, snapshot: () => Promise<unknown>, type: string) => {
    const encoder = new TextEncoder()
    let cleanup = () => {}
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (value: unknown) => {
          try { controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)) } catch { cleanup() }
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const push = () => {
          if (timer) return
          timer = setTimeout(() => {
            timer = undefined
            void snapshot().then(s => send({ type, at: new Date().toISOString(), ...s as object }), () => {})
          }, 80)
        }
        const unsubscribe = hub.subscribe(event => { if (relevant(event)) push() })
        const heartbeat = setInterval(() => send({ type: 'heartbeat', at: new Date().toISOString() }), HEARTBEAT_MS)
        cleanup = () => { unsubscribe(); clearInterval(heartbeat); if (timer) clearTimeout(timer) }
        request.signal.addEventListener('abort', () => {
          cleanup()
          try { controller.close() } catch { /* already closed */ }
        }, { once: true })
        send({ type, at: new Date().toISOString(), ...await snapshot() as object })
      },
      cancel() { cleanup() },
    })
    return new Response(body, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
  }

  const sessionParam = (request: Request) => {
    const sessionId = new URL(request.url).searchParams.get('sessionId')
    if (!sessionId) throw new UserError('sessionId required')
    return sessionId
  }

  route('/run', ['GET'], async request => json(await runSnapshot(sessionParam(request), request.signal)))

  route('/events', ['GET'], async (request) => {
    const sessionId = sessionParam(request)
    return stream(request, (event) => {
      const run = store.runBySession(sessionId) ?? (store.agentBySession(sessionId) ? store.runById(store.agentBySession(sessionId)!.run_id) : undefined)
      return event.type === 'run' ? (!run || event.runId === run.id) : event.runId === run?.id
    }, () => runSnapshot(sessionId, request.signal), 'run')
  })

  route('/inbox', ['GET'], async request => json(await inboxSnapshot(new URL(request.url).searchParams.get('status') ?? 'open', request.signal)))

  route('/inbox/events', ['GET'], async (request) => {
    const status = new URL(request.url).searchParams.get('status') ?? 'open'
    return stream(request, event => event.type === 'inbox' || event.type === 'run', () => inboxSnapshot(status, request.signal), 'inbox')
  })

  route('/inbox/respond', ['POST'], async (request) => {
    const b = await body(request)
    if (typeof b.id !== 'string') throw new UserError('id required')
    const item = await service.respond(b.id, b)
    return json({ ok: true, status: item.status })
  })

  const runAction = (path: string, fn: (runId: string, b: Record<string, unknown>) => Promise<void> | void) =>
    route(path, ['POST'], async (request) => {
      const b = await body(request)
      if (typeof b.runId !== 'string') throw new UserError('runId required')
      await fn(b.runId, b)
      return json({ ok: true, status: store.runById(b.runId)?.status })
    })
  // Empty-state entry of the workflow view: same as the model calling wf_start.
  route('/run/start', ['POST'], async (request) => {
    const b = await body(request)
    if (typeof b.sessionId !== 'string' || typeof b.requirement !== 'string' || !b.requirement.trim()) throw new UserError('sessionId and requirement required')
    if (b.template !== undefined && !isStartTemplate(b.template)) throw new UserError('template must be full or small')
    const { run, created } = await service.startForSession(b.sessionId, b.requirement, typeof b.title === 'string' ? b.title : '', isStartTemplate(b.template) ? b.template : undefined)
    // Started from a blank session's view: keep it in DSH's session list.
    void deps.engage(b.sessionId).catch(() => undefined)
    return json({ ok: true, runId: run.id, created })
  })
  // A bound session DSH still treats as blank (started by the command before
  // 0.1.0-beta.5): the browser asks once when it shows the session.
  route('/session/engage', ['POST'], async (request) => {
    const b = await body(request)
    if (typeof b.sessionId !== 'string') throw new UserError('sessionId required')
    if (!store.runBySession(b.sessionId)) throw new UserError('no workflow in this session', 404)
    return json({ ok: true, ...await deps.engage(b.sessionId) })
  })
  // Every run on this machine with its session, newest first (fallback entry).
  route('/runs', ['GET'], async (request) => {
    const t = await titles(request.signal)
    return json({ runs: store.runs().reverse().map(run => ({
      id: run.id, title: run.title, status: run.status, template: templateOf(run).id, currentNode: run.current_node,
      sessionId: run.session_id, sessionTitle: t.get(run.session_id) ?? null, projectPath: run.project_path, createdAt: run.created_at, updatedAt: run.updated_at,
    })) })
  })
  runAction('/run/continue', id => service.continueRun(id))
  runAction('/run/pause', id => service.pauseRun(id))
  runAction('/run/cancel', id => service.cancelRun(id))
  runAction('/node/retry', (id, b) => service.retryNode(id, String(b.node) as NodeKey))
  runAction('/node/accept', (id, b) => service.acceptNode(id, String(b.node) as NodeKey))

  route('/artifact', ['GET'], async (request) => {
    const q = new URL(request.url).searchParams
    const runId = q.get('runId')
    const path = q.get('path')
    if (!runId || !path) throw new UserError('runId and path required')
    return new Response(await service.readArtifact(runId, path), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
  })

  route('/diff', ['GET'], async (request) => {
    const runId = new URL(request.url).searchParams.get('runId')
    const run = runId ? store.runById(runId) : undefined
    if (!run) throw new UserError('run not found', 404)
    if (!run.is_git || !run.base_ref) return json({ git: false, diff: '', log: [] })
    return json({ git: true, branch: run.branch, diff: await diffSinceBase(run.worktree_path, run.base_ref), log: await branchLog(run.worktree_path, run.base_ref) })
  })

  if (deps.devRoutes) {
    // Test-only: drive a real main session so wf_start is a genuine model tool call.
    route('/dev/session', ['POST'], async (request) => {
      const b = await body(request)
      const c = controller()
      if (!c) throw new UserError('sessionController unavailable', 501)
      const { sessionId } = await c.create({ ...(typeof b.cwd === 'string' ? { cwd: b.cwd } : {}) })
      if (typeof b.text === 'string') await c.prompt({ requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: b.text }] }, request.signal)
      return json({ sessionId })
    })
    route('/dev/sessions', ['GET'], async (request) => {
      const { items } = await controller()?.list({}, request.signal) ?? { items: [] }
      return json(items.map(i => ({ sessionId: i.sessionId, origin: i.origin ?? null, parentSessionId: i.parentSessionId ?? null, running: i.running, agentAvailable: i.agentAvailable, blank: i.blank ?? null, title: i.projections?.values?.title ?? null })))
    })
    // Execute a slash command line through DSH's command registry, as the composer does.
    route('/dev/command', ['POST'], async (request) => {
      const b = await body(request)
      const commands = ctx.get('commands' as never) as { execute(agent: unknown, line: string, attachments: readonly unknown[], signal: AbortSignal): Promise<unknown> } | undefined
      if (!commands) throw new UserError('commands unavailable', 501)
      if (typeof b.sessionId !== 'string' || typeof b.line !== 'string') throw new UserError('sessionId and line required')
      const agent = await deps.service.mainAgent(b.sessionId)
      if (!agent) throw new UserError('session agent unavailable', 404)
      return json({ execution: await commands.execute(agent, b.line, [], request.signal) ?? null })
    })
    // Bind a run without settling the session: the state /rdfoe-workflow left before 0.1.0-beta.5.
    route('/dev/bind', ['POST'], async (request) => {
      const b = await body(request)
      if (typeof b.sessionId !== 'string' || typeof b.cwd !== 'string' || typeof b.requirement !== 'string') throw new UserError('sessionId, cwd and requirement required')
      const { run } = await service.startRun({ sessionId: b.sessionId, cwd: b.cwd, title: b.requirement.slice(0, 40), requirement: b.requirement })
      return json({ runId: run.id })
    })
    route('/dev/prompt', ['POST'], async (request) => {
      const b = await body(request)
      const c = controller()
      if (!c || typeof b.sessionId !== 'string' || typeof b.text !== 'string') throw new UserError('sessionId and text required')
      await c.prompt({ requestId: randomUUID(), sessionId: b.sessionId as SessionId, mode: 'queue', content: [{ type: 'text', text: b.text }] }, request.signal)
      return json({ ok: true })
    })
  }
}
