/**
 * Transition tables (§4.2). `apply(kind, state, event)` is the only function
 * that computes a new status; the Store persists the result together with an
 * `event` row in one transaction. Illegal transitions throw.
 */

export type RunStatus = 'CREATED' | 'RUNNING' | 'PAUSED' | 'INTERRUPTED' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'ORPHANED'
export type RunEvent = 'start' | 'pause' | 'resume' | 'interrupt' | 'complete' | 'fail' | 'cancel' | 'orphan'

export type AiNodeStatus = 'PENDING' | 'RUNNING' | 'WAITING_ANSWER' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'INTERRUPTED' | 'STALE' | 'CANCELLED'
export type AiNodeEvent = 'start' | 'wait' | 'answered' | 'succeed' | 'fail' | 'block' | 'accept' | 'retry' | 'interrupt' | 'resume' | 'stale' | 'cancel'

export type ReviewStatus = 'PENDING' | 'AWAITING_REVIEW' | 'APPROVED' | 'REJECTED' | 'STALE' | 'CANCELLED'
export type ReviewEvent = 'open' | 'approve' | 'reject' | 'stale' | 'cancel'

export type InboxStatus = 'OPEN' | 'RESOLVED' | 'CANCELLED'
export type InboxEvent = 'resolve' | 'cancel'

type Table<S extends string, E extends string> = { readonly [K in S]: Partial<Record<E, S>> }

export const RUN_TABLE: Table<RunStatus, RunEvent> = {
  CREATED: { start: 'RUNNING', cancel: 'CANCELLED', orphan: 'ORPHANED' },
  RUNNING: { pause: 'PAUSED', interrupt: 'INTERRUPTED', complete: 'COMPLETED', fail: 'FAILED', cancel: 'CANCELLED', orphan: 'ORPHANED' },
  PAUSED: { resume: 'RUNNING', interrupt: 'INTERRUPTED', cancel: 'CANCELLED', orphan: 'ORPHANED' },
  INTERRUPTED: { resume: 'RUNNING', cancel: 'CANCELLED', orphan: 'ORPHANED' },
  COMPLETED: {},
  FAILED: { resume: 'RUNNING', cancel: 'CANCELLED', orphan: 'ORPHANED' },
  CANCELLED: {},
  ORPHANED: {},
}

export const AI_NODE_TABLE: Table<AiNodeStatus, AiNodeEvent> = {
  PENDING: { start: 'RUNNING', cancel: 'CANCELLED' },
  RUNNING: { wait: 'WAITING_ANSWER', succeed: 'SUCCEEDED', fail: 'FAILED', block: 'BLOCKED', interrupt: 'INTERRUPTED', cancel: 'CANCELLED' },
  WAITING_ANSWER: { answered: 'RUNNING', interrupt: 'INTERRUPTED', cancel: 'CANCELLED' },
  SUCCEEDED: { stale: 'STALE' },
  FAILED: { retry: 'RUNNING', stale: 'STALE', cancel: 'CANCELLED' },
  /** C (clarify) finished with blocking decisions: the user retries it or accepts the requirement as is. */
  BLOCKED: { retry: 'RUNNING', accept: 'SUCCEEDED', stale: 'STALE', cancel: 'CANCELLED' },
  INTERRUPTED: { resume: 'RUNNING', stale: 'STALE', cancel: 'CANCELLED' },
  STALE: { start: 'RUNNING', cancel: 'CANCELLED' },
  CANCELLED: {},
}

/**
 * Review gates. `approve` / `reject` are human-only: the WorkflowService
 * exposes them solely through the inbox response route, never from code that
 * reacts to AI output.
 */
export const REVIEW_TABLE: Table<ReviewStatus, ReviewEvent> = {
  PENDING: { open: 'AWAITING_REVIEW', cancel: 'CANCELLED' },
  AWAITING_REVIEW: { approve: 'APPROVED', reject: 'REJECTED', stale: 'STALE', cancel: 'CANCELLED' },
  APPROVED: { stale: 'STALE' },
  REJECTED: { open: 'AWAITING_REVIEW', stale: 'STALE', cancel: 'CANCELLED' },
  STALE: { open: 'AWAITING_REVIEW', cancel: 'CANCELLED' },
  CANCELLED: {},
}

export const INBOX_TABLE: Table<InboxStatus, InboxEvent> = {
  OPEN: { resolve: 'RESOLVED', cancel: 'CANCELLED' },
  RESOLVED: {},
  CANCELLED: {},
}

export const TABLES = { run: RUN_TABLE, ai: AI_NODE_TABLE, review: REVIEW_TABLE, inbox: INBOX_TABLE } as const
export type MachineKind = keyof typeof TABLES

export class IllegalTransitionError extends Error {
  constructor(readonly kind: MachineKind, readonly from: string, readonly event: string) {
    super(`illegal ${kind} transition: ${from} --${event}-->`)
    this.name = 'IllegalTransitionError'
  }
}

export function next(kind: MachineKind, from: string, event: string): string | undefined {
  const row = (TABLES[kind] as Record<string, Record<string, string> | undefined>)[from]
  return row?.[event]
}

/** Compute the target status or throw. Pure; persistence lives in Store.transition. */
export function apply(kind: MachineKind, from: string, event: string): string {
  const to = next(kind, from, event)
  if (to === undefined) throw new IllegalTransitionError(kind, from, event)
  return to
}

export function canApply(kind: MachineKind, from: string, event: string): boolean {
  return next(kind, from, event) !== undefined
}
