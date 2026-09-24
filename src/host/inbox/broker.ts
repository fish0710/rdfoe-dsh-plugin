/**
 * InboxBroker (§7.2–7.4): every item is persisted first; blocking tool calls
 * park on an in-process waiter keyed by item id. Resolution always goes
 * through the inbox transition table, then wakes the waiter (if the calling
 * process is still alive) and notifies the WorkflowService.
 */
import type { Hub } from '../runner/hub.ts'
import type { InboxKind, InboxRow, Store } from '../store/store.ts'

export interface NewItem {
  runId: string
  sessionId: string
  nodeId: string | null
  agentSessionId: string | null
  round: number
  kind: InboxKind
  blocking: boolean
  payload: unknown
}

type Waiter = { resolve: (response: unknown) => void, reject: (error: Error) => void }

export class InboxBroker {
  private readonly waiters = new Map<string, Waiter>()
  private readonly listeners = new Set<(item: InboxRow) => void>()

  constructor(private readonly store: Store, private readonly hub: Hub) {}

  onResolved(listener: (item: InboxRow) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  open(item: NewItem): InboxRow {
    const row = this.store.addInbox({
      run_id: item.runId,
      session_id: item.sessionId,
      node_id: item.nodeId,
      agent_session_id: item.agentSessionId,
      round: item.round,
      kind: item.kind,
      blocking: item.blocking ? 1 : 0,
      payload_json: JSON.stringify(item.payload),
    })
    this.hub.publish({ type: 'inbox', runId: row.run_id, id: row.id, status: 'OPEN' })
    return row
  }

  /**
   * Park until the item is resolved. Aborting only releases the caller: the
   * item stays OPEN (a process exit must not lose questions, §7.5); callers
   * that really withdraw an item call cancel() explicitly.
   */
  wait(id: string, signal: AbortSignal): Promise<unknown> {
    const current = this.store.inboxItem(id)
    if (current?.status === 'RESOLVED') return Promise.resolve(JSON.parse(current.response_json ?? 'null'))
    if (current?.status === 'CANCELLED') return Promise.reject(new Error(`inbox item ${id} was cancelled`))
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.waiters.delete(id)
        reject(new Error(`wait for inbox item ${id} aborted`))
      }
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.set(id, {
        resolve: (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
        reject: (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
      })
    })
  }

  hasWaiter(id: string): boolean {
    return this.waiters.has(id)
  }

  resolve(id: string, response: unknown): InboxRow {
    this.store.transition({ table: 'inbox_item', id }, 'resolve', { response_json: JSON.stringify(response), resolved_at: new Date().toISOString() })
    const row = this.store.inboxItem(id)!
    const waiter = this.waiters.get(id)
    this.waiters.delete(id)
    waiter?.resolve(response)
    this.hub.publish({ type: 'inbox', runId: row.run_id, id, status: 'RESOLVED' })
    for (const listener of this.listeners) listener(row)
    return row
  }

  cancel(id: string, reason: string): void {
    const row = this.store.inboxItem(id)
    if (!row || row.status !== 'OPEN') return
    this.store.transition({ table: 'inbox_item', id }, 'cancel', { resolved_at: new Date().toISOString(), response_json: JSON.stringify({ cancelled: reason }) })
    const waiter = this.waiters.get(id)
    this.waiters.delete(id)
    waiter?.reject(new Error(`inbox item ${id} cancelled: ${reason}`))
    this.hub.publish({ type: 'inbox', runId: row.run_id, id, status: 'CANCELLED' })
  }

  /** Release every parked call (plugin unload); items stay OPEN for §7.5 recovery. */
  detachAll(reason: string): void {
    for (const waiter of this.waiters.values()) waiter.reject(new Error(reason))
    this.waiters.clear()
  }
}
