/**
 * wf_start and /rdfoe-workflow cards: the `tool.call.toolview` card (inside
 * the turn's work process, which DSH folds once the turn completes), the
 * `conversation.chat.commandview` card, and the turn-tail card that keeps the
 * started workflow visible under the model's closing reply.
 */
import { useState, type KeyboardEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { NODE_LABEL, RUN_STATUS_LABEL, TEMPLATE_LABEL, orderOf, parseCommandRun, templateId, useStream, type RunSnapshot } from '../api.ts'

export interface WfStartCardInjected {
  openWorkflowView: () => boolean
}

interface Block { kind?: string, meta?: unknown, isError?: boolean }
interface Meta { runId: string, status: string, created: boolean, currentNode?: string, template?: string, pending?: number, branch?: string }

function metaOf(block: Block): Meta | undefined {
  const meta = block.kind === 'tool-result' ? block.meta : undefined
  if (typeof meta !== 'object' || meta === null) return undefined
  const m = meta as Record<string, unknown>
  return typeof m.runId === 'string' && typeof m.status === 'string' ? m as unknown as Meta : undefined
}

export function WfStartCard({ block, callId, openWorkflowView }: WfStartCardInjected & { block: Block, callId: string }) {
  const [missed, setMissed] = useState(false)
  const meta = metaOf(block)
  if (block.kind !== 'tool-result') return <div className="rwf rwf-tool-card" data-rdfoe-card="running"><span className="rwf-spinner" /> 正在开启工作流…</div>
  if (block.isError || meta === undefined) return <div className="rwf rwf-tool-card err" data-rdfoe-card="error">工作流启动失败（{callId}）</div>
  const steps = orderOf(meta.template)
  const at = steps.indexOf(meta.currentNode ?? '')
  return (
    <div className="rwf rwf-tool-card" data-rdfoe-card={meta.runId}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="logo" aria-hidden="true"><circle cx="5" cy="12" r="2.2" /><circle cx="12" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" /><circle cx="19" cy="12" r="2.2" /><path d="M7 11l3-3.5M7 13l3 3.5M14 7.5l3 3M14 16.5l3-3" /></svg>
      <div className="grow">
        <div className="title">工作流 {meta.runId} {meta.created ? '已开启' : '已恢复'}</div>
        <div className="rwf-muted small">{TEMPLATE_LABEL[templateId(meta.template)]} · {RUN_STATUS_LABEL[meta.status] ?? meta.status}{meta.currentNode ? ` · 当前：${NODE_LABEL[meta.currentNode] ?? meta.currentNode}` : ''}{meta.branch ? ` · ${meta.branch}` : ''}</div>
        <div className="mini-steps">{steps.map((s, i) => <span key={s} className={i < at ? 'done' : i === at ? 'cur' : ''} title={NODE_LABEL[s]} />)}</div>
      </div>
      <Button size="sm" variant="primary" data-rdfoe-open-view="" onClick={() => setMissed(!openWorkflowView())}>打开工作流</Button>
      {missed && <span className="rwf-muted small">未找到「工作流」标签</span>}
    </div>
  )
}

/** Structural subset of DSH's CommandNode (ui-conversation records, 0.1.5 and 0.1.7). */
interface CommandNodeLike { name: string | null, args: string | null, outcome: { kind: 'success' | 'error', text?: string } | null }

/** `conversation.chat.commandview` card for `/rdfoe-workflow`, parsed from the command/done text. */
export function WfCommandCard({ node, openWorkflowView }: WfStartCardInjected & { node: CommandNodeLike }) {
  const [missed, setMissed] = useState(false)
  const outcome = node.outcome
  if (outcome === null) return <div className="rwf rwf-tool-card" data-rdfoe-card="running"><span className="rwf-spinner" /> 正在开启工作流…</div>
  const rest = (outcome.text ?? '').split('\n').slice(1)
  const parsed = outcome.kind === 'success' ? parseCommandRun(outcome.text) : null
  if (parsed === null) {
    return (
      <div className={`rwf rwf-tool-card${outcome.kind === 'error' ? ' err' : ''}`} data-rdfoe-card={outcome.kind === 'error' ? 'error' : 'usage'}>
        <div className="grow" style={{ whiteSpace: 'pre-wrap' }}>{outcome.text ?? '/rdfoe-workflow'}</div>
      </div>
    )
  }
  const { verb, runId, facts } = parsed
  const steps = orderOf(parsed.template)
  const at = steps.indexOf(parsed.node ?? '')
  return (
    <div className="rwf rwf-tool-card" data-rdfoe-card={runId}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="logo" aria-hidden="true"><circle cx="5" cy="12" r="2.2" /><circle cx="12" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" /><circle cx="19" cy="12" r="2.2" /><path d="M7 11l3-3.5M7 13l3 3.5M14 7.5l3 3M14 16.5l3-3" /></svg>
      <div className="grow">
        <div className="title">工作流 {runId} {verb === '已开启' ? '已开启' : verb === '已恢复' ? '已恢复' : ''}</div>
        <div className="rwf-muted small">{facts}</div>
        {rest.length > 0 && <div className="rwf-muted small">{rest.join(' ')}</div>}
        <div className="mini-steps">{steps.map((s, i) => <span key={s} className={i < at ? 'done' : i === at ? 'cur' : ''} title={NODE_LABEL[s]} />)}</div>
      </div>
      <Button size="sm" variant="primary" data-rdfoe-open-view="" onClick={() => setMissed(!openWorkflowView())}>打开工作流</Button>
      {missed && <span className="rwf-muted small">未找到「工作流」标签</span>}
    </div>
  )
}

/** Turn data key of START_TURN_DEFINITION: the wf_start call made in that turn. */
export const START_TURN_KEY = 'rdfoe-workflow-start'

interface EventLike { type: string, seq: number, data: { turn?: number, name?: string, callId?: unknown } }
interface StartTurnState { turn: number, callId: string | null }
type LocationData = { kind: 'turn', turn: number, key: string, value: { callId: string } }

/**
 * ui-conversation event Definition (same shape in 0.1.5 and 0.1.7, as
 * ui-deliverables uses it): per turn, the first wf_start tool call. Chat
 * hands this turn data to `conversation.chat.turnTail` entries.
 */
export const START_TURN_DEFINITION = {
  kind: START_TURN_KEY,
  match: (event: EventLike) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' as const }
    if (event.type === 'tool/call' && event.data.name === 'wf_start') return { id: String(event.data.turn), role: 'update' as const }
    return null
  },
  start: (_context: unknown, match: { event: EventLike }): StartTurnState => ({ turn: match.event.data.turn!, callId: null }),
  update: (context: { state: StartTurnState }, match: { event: EventLike }): StartTurnState =>
    context.state.callId === null ? { ...context.state, callId: String(match.event.data.callId) } : context.state,
  buildLocationData: (context: { state?: StartTurnState }, scope: string, previous?: LocationData): LocationData | null => {
    const state = context.state
    if (scope !== 'turn' || state === undefined || state.callId === null) return null
    if (previous?.kind === 'turn' && previous.turn === state.turn && previous.key === START_TURN_KEY && previous.value.callId === state.callId) return previous
    return { kind: 'turn', turn: state.turn, key: START_TURN_KEY, value: { callId: state.callId } }
  },
}

interface TailOwner { turn?: { data?: { get(key: string): unknown } } }

/** Chain selector (0.1.5) and list guard (0.1.7): only turns that called wf_start. */
export function selectStartTurn(owner: TailOwner): { callId: string } | null {
  const value = owner.turn?.data?.get(START_TURN_KEY) as { callId?: string } | undefined
  return typeof value?.callId === 'string' ? { callId: value.callId } : null
}

/** `conversation.chat.turnTail` card: the session's workflow, live, one click to its view. */
export function WfStartTail(props: WfStartCardInjected & TailOwner & { sessionId: string }) {
  if (selectStartTurn(props) === null) return null
  return <LiveRunCard sessionId={props.sessionId} openWorkflowView={props.openWorkflowView} />
}

function LiveRunCard({ sessionId, openWorkflowView }: WfStartCardInjected & { sessionId: string }) {
  const [missed, setMissed] = useState(false)
  const { data } = useStream<RunSnapshot & { type: string }>(`/events?sessionId=${encodeURIComponent(sessionId)}`, 'run')
  const run = data?.run
  if (!run) return null
  const steps = orderOf(run.template)
  const at = steps.indexOf(run.current_node ?? '')
  const pending = data?.inbox?.filter(i => i.status === 'OPEN').length ?? 0
  const open = () => setMissed(!openWorkflowView())
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }
  return (
    <div className="rwf rwf-tool-card rwf-tail-card" role="button" tabIndex={0} onClick={open} onKeyDown={onKey} data-rdfoe-tail={run.id} aria-label={`打开工作流 ${run.id}`}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="logo" aria-hidden="true"><circle cx="5" cy="12" r="2.2" /><circle cx="12" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" /><circle cx="19" cy="12" r="2.2" /><path d="M7 11l3-3.5M7 13l3 3.5M14 7.5l3 3M14 16.5l3-3" /></svg>
      <div className="grow">
        <div className="title">{run.title || run.id}</div>
        <div className="rwf-muted small">
          {run.id} · {TEMPLATE_LABEL[templateId(run.template)]} · {RUN_STATUS_LABEL[run.status] ?? run.status}
          {run.current_node ? ` · 当前：${NODE_LABEL[run.current_node] ?? run.current_node}` : ''}
          {pending > 0 ? ` · 待处理 ${pending}` : ''}
        </div>
        <div className="mini-steps">{steps.map((s, i) => <span key={s} className={i < at ? 'done' : i === at ? 'cur' : ''} title={NODE_LABEL[s]} />)}</div>
      </div>
      <Button size="sm" variant="primary" data-rdfoe-open-view="" onClick={(e) => { e.stopPropagation(); open() }}>打开工作流</Button>
      {missed && <span className="rwf-muted small">未找到「工作流」标签</span>}
    </div>
  )
}
