/**
 * Make a session that only ran `/rdfoe-workflow` an ordinary session.
 *
 * DSH treats a session with no turn as a blank "新会话": its list projection
 * (`sessionListMetadata.blank` in api-session-controller, 0.1.5 and 0.1.7)
 * turns false on the first committed `turn/start` and on nothing else, and
 * the session browser hides every blank session except the selected one. A
 * slash command logs only `command/run`/`command/done`, so the session drops
 * out of the list once another is selected, keeps the empty-state welcome
 * page, and never shows the View tabs.
 *
 * engageSession gives the session that first turn through the agent loop's
 * public paths, without a model call: `followup` wakes the driver, which
 * appends `turn/start`; an `agent/pre-step` listener empties the claimed
 * batch, so the loop closes the turn as `completed` before any step (no
 * request, no `user/message`). The title goes through `sessionTitle.rename`.
 * Every event written is DSH's own (R6).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Text of the follow-up the pre-step listener drops; it only ever reaches the durable inbox. */
export const ENGAGE_TEXT = '（RDFOE 工作流：登记本会话，不发送给模型）'

export const sessionTitleOf = (runTitle: string) => `工作流 · ${runTitle}`

interface TitlesLike {
  get(session: Agent['session']): unknown
  rename(session: Agent['session'], title: string): unknown
}
interface SessionsLike { flush(session: Agent['session']): Promise<boolean> }
type PreStepDecision = { kind: 'enter', messages: unknown[] } | { kind: 'reject' }

/** No `turn/start` yet: DSH lists and renders the session as blank. */
export function isBlank(agent: Pick<Agent, 'session'>): boolean {
  return !agent.session.snapshotEvents().some(event => event.type === 'turn/start')
}

/** Per-session guard: the command and the browser's self-heal may both ask at once. */
const inFlight = new Map<string, Promise<{ titled: boolean, engaged: boolean }>>()

/**
 * Title an untitled session `工作流 · <run title>` and open one empty turn on
 * a blank, idle one. Both steps are no-ops on sessions that already have them.
 */
export function engageSession(ctx: Context, agent: Agent, runTitle: string): Promise<{ titled: boolean, engaged: boolean }> {
  const pending = inFlight.get(agent.id)
  if (pending) return pending
  const work = engage(ctx, agent, runTitle).finally(() => inFlight.delete(agent.id))
  inFlight.set(agent.id, work)
  return work
}

async function engage(ctx: Context, agent: Agent, runTitle: string): Promise<{ titled: boolean, engaged: boolean }> {
  const titles = ctx.get('sessionTitle' as never) as TitlesLike | undefined
  let titled = false
  if (titles && titles.get(agent.session) === undefined && runTitle.trim()) {
    titles.rename(agent.session, sessionTitleOf(runTitle.trim()))
    titled = true
  }
  if (!isBlank(agent) || agent.status !== 'idle') return { titled, engaged: false }

  const message = createUserMessage({ content: [{ type: 'text', text: ENGAGE_TEXT }], source: { kind: 'user' } })
  // Prepended so no other listener sees (or forwards) the placeholder batch.
  const dispose = (ctx.on as (name: string, listener: unknown, prepend: boolean) => () => boolean)('agent/pre-step', async (
    payload: { agent: Agent, messages: readonly { id: unknown }[] },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> => {
    if (payload.agent !== agent || !payload.messages.some(m => m.id === message.id)) return next()
    // Alone, an empty batch closes the turn before any step; with real input
    // that raced in, that input proceeds as usual without the placeholder.
    if (payload.messages.length === 1) return { kind: 'enter', messages: [] }
    const decision = await next()
    return decision.kind === 'enter' ? { ...decision, messages: decision.messages.filter(m => (m as { id: unknown }).id !== message.id) } : decision
  }, true)
  try {
    agent.followup(message)
    await agent.whenIdle()
  } finally {
    dispose()
  }
  // Persist now so a restart right after still lists the session.
  await (ctx.get('sessions' as never) as SessionsLike | undefined)?.flush(agent.session).catch(() => false)
  return { titled, engaged: !isBlank(agent) }
}
