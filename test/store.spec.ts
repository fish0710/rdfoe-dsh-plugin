import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/host/store/store.ts'
import { IllegalTransitionError } from '../src/host/workflow/machine.ts'
import { NODE_KIND, ORDER, TEMPLATES, templateOf } from '../src/host/workflow/template.ts'

const NODES = ORDER.map(key => ({ key, kind: NODE_KIND[key] }))

describe('Store', () => {
  let dir: string
  let store: Store

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rdfoe-store-'))
    store = new Store(join(dir, 'rdfoe-workflow', 'state.db'))
  })
  afterEach(async () => {
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('binds one run per session and creates the seven template nodes once', () => {
    const first = store.getOrCreateRun({ sessionId: 's-1', projectPath: '/p', title: 'a' }, NODES)
    const second = store.getOrCreateRun({ sessionId: 's-1', projectPath: '/other', title: 'b' }, NODES)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.run.id).toBe(first.run.id)
    expect(store.nodes(first.run.id)).toHaveLength(12)
  })

  it('records the template (default full); small runs get the six small-template nodes', () => {
    const full = store.getOrCreateRun({ sessionId: 's-f', projectPath: '/p', title: 'f' }, NODES)
    expect(full.run.template).toBe('full')
    expect(store.nodes(full.run.id)).toHaveLength(12)
    const smallNodes = TEMPLATES.small.order.map(key => ({ key, kind: NODE_KIND[key] }))
    const small = store.getOrCreateRun({ sessionId: 's-s', projectPath: '/p', title: 's', template: 'small' }, smallNodes)
    expect(small.run.template).toBe('small')
    expect(store.nodes(small.run.id).map(n => n.node_key).sort()).toEqual(['A', 'H2', 'H3', 'S', 'X', 'Y'])
  })

  it('reads rows written before templates (template = standard) as legacy', () => {
    store.insertRawRun({ id: 'WF-OLD', session_id: 's-old' })
    const old = store.runById('WF-OLD')!
    expect(old.template).toBe('standard')
    expect(templateOf(old).id).toBe('legacy')
  })

  it('can attach files to a recorded version (the design review\'s review.md)', () => {
    const { run } = store.getOrCreateRun({ sessionId: 's-v', projectPath: '/p', title: 'v' }, NODES)
    const d = store.node(run.id, 'D')
    store.addVersion({ node_id: d.id, version: 1, round: 0, origin: 'generated', artifacts_json: '["a/design.md"]', summary: '', structured_json: '{}' })
    store.setVersionArtifacts(d.id, 1, ['a/design.md', 'a/review.md'])
    expect(JSON.parse(store.version(d.id, 1)!.artifacts_json)).toEqual(['a/design.md', 'a/review.md'])
  })

  it('enforces session_id UNIQUE at the database level', () => {
    const { run } = store.getOrCreateRun({ sessionId: 's-dup', projectPath: '/p', title: '' }, NODES)
    expect(() => store.insertRawRun({ id: `${run.id}-x`, session_id: 's-dup' })).toThrow(/UNIQUE/)
  })

  it('transition applies the table and writes an event in the same transaction', () => {
    const { run } = store.getOrCreateRun({ sessionId: 's-t', projectPath: '/p', title: '' }, NODES)
    store.transition({ table: 'run', id: run.id }, 'start')
    const d = store.node(run.id, 'D')
    store.transition({ table: 'node', id: d.id }, 'start', { current_version: 1 })
    expect(store.node(run.id, 'D')).toMatchObject({ status: 'RUNNING', current_version: 1 })
    const events = store.events(run.id).map(e => `${e.type}:${e.before}->${e.after}`)
    expect(events).toContain('node:start:PENDING->RUNNING')
    expect(events).toContain('run:start:CREATED->RUNNING')
  })

  it('an illegal transition changes nothing and writes no event', () => {
    const { run } = store.getOrCreateRun({ sessionId: 's-i', projectPath: '/p', title: '' }, NODES)
    const r1 = store.node(run.id, 'H1')
    const before = store.events(run.id).length
    expect(() => store.transition({ table: 'node', id: r1.id }, 'approve')).toThrow(IllegalTransitionError)
    expect(store.node(run.id, 'H1').status).toBe('PENDING')
    expect(store.events(run.id)).toHaveLength(before)
  })

  it('inbox items transition OPEN → RESOLVED once; non-blocking answers are delivered once', () => {
    const { run } = store.getOrCreateRun({ sessionId: 's-q', projectPath: '/p', title: '' }, NODES)
    const item = store.addInbox({ run_id: run.id, session_id: 's-q', node_id: null, agent_session_id: 'agent-1', round: 0, kind: 'message', blocking: 0, payload_json: '{}' })
    store.transition({ table: 'inbox_item', id: item.id }, 'resolve', { response_json: '{"text":"hi"}', resolved_at: 'now' })
    expect(() => store.transition({ table: 'inbox_item', id: item.id }, 'resolve')).toThrow(IllegalTransitionError)
    expect(store.undelivered({ agentSessionId: 'agent-1' })).toHaveLength(1)
    store.markDelivered([item.id])
    expect(store.undelivered({ agentSessionId: 'agent-1' })).toHaveLength(0)
  })

  it('survives reopen', () => {
    const { run } = store.getOrCreateRun({ sessionId: 's-r', projectPath: '/p', title: '' }, NODES)
    const path = store.path
    store.close()
    store = new Store(path)
    expect(store.runBySession('s-r')?.id).toBe(run.id)
  })
})
