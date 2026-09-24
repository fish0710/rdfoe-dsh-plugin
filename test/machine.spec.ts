/**
 * Exhaustive transition-table tests (§4.2): every (state, event) pair of every
 * table is either the documented target or an IllegalTransitionError.
 */
import { describe, expect, it } from 'vitest'
import {
  AI_NODE_TABLE, INBOX_TABLE, REVIEW_TABLE, RUN_TABLE, IllegalTransitionError, apply, type MachineKind,
} from '../src/host/workflow/machine.ts'

type Expect = Record<string, Record<string, string>>

const RUN_EVENTS = ['start', 'pause', 'resume', 'interrupt', 'complete', 'fail', 'cancel', 'orphan']
const AI_EVENTS = ['start', 'wait', 'answered', 'succeed', 'fail', 'block', 'accept', 'retry', 'interrupt', 'resume', 'stale', 'cancel']
const REVIEW_EVENTS = ['open', 'approve', 'reject', 'stale', 'cancel']
const INBOX_EVENTS = ['resolve', 'cancel']

/** The documented legal transitions, written out independently of the implementation. */
const EXPECTED: Record<MachineKind, { events: string[], table: object, legal: Expect }> = {
  run: {
    events: RUN_EVENTS,
    table: RUN_TABLE,
    legal: {
      CREATED: { start: 'RUNNING', cancel: 'CANCELLED', orphan: 'ORPHANED' },
      RUNNING: { pause: 'PAUSED', interrupt: 'INTERRUPTED', complete: 'COMPLETED', fail: 'FAILED', cancel: 'CANCELLED', orphan: 'ORPHANED' },
      PAUSED: { resume: 'RUNNING', interrupt: 'INTERRUPTED', cancel: 'CANCELLED', orphan: 'ORPHANED' },
      INTERRUPTED: { resume: 'RUNNING', cancel: 'CANCELLED', orphan: 'ORPHANED' },
      FAILED: { resume: 'RUNNING', cancel: 'CANCELLED', orphan: 'ORPHANED' },
      COMPLETED: {},
      CANCELLED: {},
      ORPHANED: {},
    },
  },
  ai: {
    events: AI_EVENTS,
    table: AI_NODE_TABLE,
    legal: {
      PENDING: { start: 'RUNNING', cancel: 'CANCELLED' },
      RUNNING: { wait: 'WAITING_ANSWER', succeed: 'SUCCEEDED', fail: 'FAILED', block: 'BLOCKED', interrupt: 'INTERRUPTED', cancel: 'CANCELLED' },
      WAITING_ANSWER: { answered: 'RUNNING', interrupt: 'INTERRUPTED', cancel: 'CANCELLED' },
      SUCCEEDED: { stale: 'STALE' },
      FAILED: { retry: 'RUNNING', stale: 'STALE', cancel: 'CANCELLED' },
      BLOCKED: { retry: 'RUNNING', accept: 'SUCCEEDED', stale: 'STALE', cancel: 'CANCELLED' },
      INTERRUPTED: { resume: 'RUNNING', stale: 'STALE', cancel: 'CANCELLED' },
      STALE: { start: 'RUNNING', cancel: 'CANCELLED' },
      CANCELLED: {},
    },
  },
  review: {
    events: REVIEW_EVENTS,
    table: REVIEW_TABLE,
    legal: {
      PENDING: { open: 'AWAITING_REVIEW', cancel: 'CANCELLED' },
      AWAITING_REVIEW: { approve: 'APPROVED', reject: 'REJECTED', stale: 'STALE', cancel: 'CANCELLED' },
      APPROVED: { stale: 'STALE' },
      REJECTED: { open: 'AWAITING_REVIEW', stale: 'STALE', cancel: 'CANCELLED' },
      STALE: { open: 'AWAITING_REVIEW', cancel: 'CANCELLED' },
      CANCELLED: {},
    },
  },
  inbox: {
    events: INBOX_EVENTS,
    table: INBOX_TABLE,
    legal: { OPEN: { resolve: 'RESOLVED', cancel: 'CANCELLED' }, RESOLVED: {}, CANCELLED: {} },
  },
}

for (const [kind, spec] of Object.entries(EXPECTED) as [MachineKind, typeof EXPECTED[MachineKind]][]) {
  describe(`${kind} transition table`, () => {
    it('has exactly the documented states', () => {
      expect(Object.keys(spec.table).sort()).toEqual(Object.keys(spec.legal).sort())
    })
    for (const state of Object.keys(spec.legal)) {
      for (const event of spec.events) {
        const target = spec.legal[state]![event]
        it(`${state} --${event}--> ${target ?? 'ILLEGAL'}`, () => {
          if (target) expect(apply(kind, state, event)).toBe(target)
          else expect(() => apply(kind, state, event)).toThrow(IllegalTransitionError)
        })
      }
    }
  })
}

describe('human-only review decisions', () => {
  it('approve/reject are reachable only from AWAITING_REVIEW', () => {
    for (const state of Object.keys(REVIEW_TABLE)) {
      for (const event of ['approve', 'reject']) {
        if (state === 'AWAITING_REVIEW') continue
        expect(() => apply('review', state, event)).toThrow(IllegalTransitionError)
      }
    }
  })
  it('unknown states and events are illegal', () => {
    expect(() => apply('run', 'NOPE', 'start')).toThrow(IllegalTransitionError)
    expect(() => apply('ai', 'RUNNING', 'approve')).toThrow(IllegalTransitionError)
  })
})
