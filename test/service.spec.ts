import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/host/config.ts'
import { InboxBroker } from '../src/host/inbox/broker.ts'
import { Hub } from '../src/host/runner/hub.ts'
import { Store } from '../src/host/store/store.ts'
import { NODE_KIND, TEMPLATES } from '../src/host/workflow/template.ts'
import { WorkflowService } from '../src/host/workflow/service.ts'

const nodesOf = (id: 'full' | 'legacy') => TEMPLATES[id].order.map(key => ({ key, kind: NODE_KIND[key] }))

describe('WorkflowService startup (legacy runs are read-only)', () => {
  let dir: string
  let store: Store
  let inbox: InboxBroker
  let service: WorkflowService

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rdfoe-svc-'))
    store = new Store(join(dir, 'state.db'))
    const hub = new Hub()
    inbox = new InboxBroker(store, hub)
    const config = { run: { autoResume: false }, loop: { stallRounds: 3, remindAt: 10 } } as unknown as Config
    service = new WorkflowService({} as never, config, store, hub, inbox, {} as never, join(dir, 'wt'))
  })
  afterEach(async () => {
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('orphans live legacy runs and withdraws their open items; current runs are interrupted as before', () => {
    const legacy = store.getOrCreateRun({ id: 'WF-OLD', sessionId: 's-old', projectPath: '/p', title: 'old', template: 'standard' }, nodesOf('legacy')).run
    store.transition({ table: 'run', id: legacy.id }, 'start')
    const review = inbox.open({ runId: legacy.id, sessionId: 's-old', nodeId: store.node(legacy.id, 'R1').id, agentSessionId: null, round: 0, kind: 'review', blocking: true, payload: { gate: 'R1' } })
    store.getOrCreateRun({ id: 'WF-DONE', sessionId: 's-done', projectPath: '/p', title: 'done', template: 'standard' }, nodesOf('legacy'))
    store.transition({ table: 'run', id: 'WF-DONE' }, 'cancel')
    const current = store.getOrCreateRun({ id: 'WF-NEW', sessionId: 's-new', projectPath: '/p', title: 'new', template: 'full' }, nodesOf('full')).run
    store.transition({ table: 'run', id: current.id }, 'start')
    store.transition({ table: 'node', id: store.node(current.id, 'R').id }, 'start')

    expect(service.recoverOnStartup()).toEqual({ runs: 1, nodes: 1, orphaned: 1 })
    expect(store.runById('WF-OLD')!.status).toBe('ORPHANED')
    expect(store.inboxItem(review.id)!.status).toBe('CANCELLED')
    expect(store.runById('WF-DONE')!.status).toBe('CANCELLED')
    expect(store.runById('WF-NEW')!.status).toBe('INTERRUPTED')
    expect(store.node('WF-NEW', 'R').status).toBe('INTERRUPTED')
  })

  it('refuses to continue an orphaned legacy run', async () => {
    store.getOrCreateRun({ id: 'WF-OLD', sessionId: 's-old', projectPath: '/p', title: 'old', template: 'standard' }, nodesOf('legacy'))
    store.transition({ table: 'run', id: 'WF-OLD' }, 'start')
    service.recoverOnStartup()
    await expect(service.continueRun('WF-OLD')).rejects.toThrow(/ORPHANED/)
  })
})
