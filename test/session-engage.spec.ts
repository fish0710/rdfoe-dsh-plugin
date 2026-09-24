import { describe, expect, it, vi } from 'vitest'
import { ENGAGE_TEXT, engageSession, isBlank, sessionTitleOf } from '../src/host/tools/session-engage.ts'

type Decision = { kind: 'enter', messages: { id: string }[] } | { kind: 'reject' }
type PreStep = (payload: { agent: unknown, messages: { id: string }[] }, next: () => Promise<Decision>) => Promise<Decision>

/**
 * A fake agent whose driver behaves like AgentLoop.turn(): followup → turn/start
 * → agent/pre-step waterfall → no step for an empty batch, else a model step.
 */
function harness(options: { events?: string[], status?: 'idle' | 'running', title?: string, extra?: { id: string }[] } = {}) {
  const events = (options.events ?? ['session/start', 'command/run', 'command/done']).map(type => ({ type }))
  const listeners: { fn: PreStep, prepend: boolean }[] = []
  const modelSteps: { id: string }[][] = []
  let title = options.title
  let idle = Promise.resolve()
  const agent = {
    id: 's-1',
    status: options.status ?? 'idle',
    session: { snapshotEvents: () => events },
    followup: vi.fn((message: { id: string, content: { text: string }[], source: { kind: string } }) => {
      idle = (async () => {
        events.push({ type: 'turn/start' })
        const claimed = [message, ...options.extra ?? []]
        const chain = [...listeners.filter(l => l.prepend).reverse(), ...listeners.filter(l => !l.prepend)]
        const run = (i: number): Promise<Decision> => i < chain.length
          ? chain[i]!.fn({ agent, messages: claimed }, () => run(i + 1))
          : Promise.resolve({ kind: 'enter', messages: [...claimed, { id: 'context' }] })
        const decision = await run(0)
        if (decision.kind === 'enter' && decision.messages.length > 0) modelSteps.push(decision.messages)
        events.push({ type: 'turn/end' })
      })()
    }),
    whenIdle: () => idle,
  }
  const flush = vi.fn(async () => true)
  const rename = vi.fn((_session: unknown, value: string) => { title = value })
  const ctx = {
    get: (name: string) => name === 'sessionTitle' ? { get: () => title, rename } : name === 'sessions' ? { flush } : undefined,
    on: (_name: string, fn: PreStep, prepend: boolean) => {
      const entry = { fn, prepend }
      listeners.push(entry)
      return () => { listeners.splice(listeners.indexOf(entry), 1); return true }
    },
  }
  return { agent, ctx, events, modelSteps, listeners, flush, rename, title: () => title }
}

describe('engageSession', () => {
  it('titles a command-only session and gives it one empty turn without a model step', async () => {
    const h = harness()
    expect(isBlank(h.agent as never)).toBe(true)
    const result = await engageSession(h.ctx as never, h.agent as never, '给 capitalize 增加 titleCase')
    expect(result).toEqual({ titled: true, engaged: true })
    expect(h.title()).toBe(sessionTitleOf('给 capitalize 增加 titleCase'))
    expect(h.title()).toBe('工作流 · 给 capitalize 增加 titleCase')
    expect(h.agent.followup).toHaveBeenCalledTimes(1)
    const message = h.agent.followup.mock.calls[0]![0]
    expect(message.source).toEqual({ kind: 'user' })
    expect(message.content[0]!.text).toBe(ENGAGE_TEXT)
    expect(h.modelSteps).toEqual([])
    expect(h.events.map(e => e.type).slice(-2)).toEqual(['turn/start', 'turn/end'])
    expect(h.listeners).toHaveLength(0)
    expect(h.flush).toHaveBeenCalledTimes(1)
  })

  it('leaves sessions that already had a turn or a title alone', async () => {
    const h = harness({ events: ['turn/start', 'turn/end'], title: '已有标题' })
    expect(await engageSession(h.ctx as never, h.agent as never, 'x')).toEqual({ titled: false, engaged: false })
    expect(h.rename).not.toHaveBeenCalled()
    expect(h.agent.followup).not.toHaveBeenCalled()
  })

  it('does not wake a running agent', async () => {
    const h = harness({ status: 'running' })
    expect(await engageSession(h.ctx as never, h.agent as never, 'x')).toEqual({ titled: true, engaged: false })
    expect(h.agent.followup).not.toHaveBeenCalled()
  })

  it('drops only the placeholder when real input shares the batch', async () => {
    const h = harness({ extra: [{ id: 'typed' }] })
    await engageSession(h.ctx as never, h.agent as never, 'x')
    expect(h.modelSteps).toEqual([[{ id: 'typed' }, { id: 'context' }]])
  })

  it('shares one engagement between concurrent callers', async () => {
    const h = harness()
    const [a, b] = await Promise.all([engageSession(h.ctx as never, h.agent as never, 'x'), engageSession(h.ctx as never, h.agent as never, 'x')])
    expect(a).toBe(b)
    expect(h.agent.followup).toHaveBeenCalledTimes(1)
  })
})
