/**
 * Hand-drawn SVG flow graph (◇ §14), drawn from the run's template (full or
 * small). Each template node is a card with its
 * status and version. The running node breathes; nodes waiting for the user
 * carry a pulsing marker; each fix ⇄ check loop (D ⇄ DR, X ⇄ Y) is a return
 * arc labelled with its round; past rejections are faint dashed arcs above.
 * The graph keeps its proportions: it scales down to a minimum width and
 * scrolls horizontally below that.
 */
import { NODE_LABEL, STATUS_LABEL, TEMPLATE_LOOPS, isGateKey, orderOf, templateId, type AgentRow, type InboxItem, type NodeRow, type ReviewRow, type RunRow } from '../api.ts'
const WIDE = 118
const H = 70
const WIDE_GAP = 22
const TOP = 64
const BOTTOM = 78

/** Visual tone per status; the graph, badges and lists share it. */
export function tone(status: string): 'done' | 'run' | 'wait' | 'warn' | 'err' | 'idle' {
  switch (status) {
    case 'SUCCEEDED': case 'APPROVED': case 'COMPLETED': case 'RESOLVED': return 'done'
    case 'RUNNING': return 'run'
    case 'WAITING_ANSWER': case 'AWAITING_REVIEW': return 'wait'
    case 'INTERRUPTED': case 'STALE': case 'REJECTED': case 'PAUSED': case 'BLOCKED': return 'warn'
    case 'FAILED': case 'CANCELLED': return 'err'
    default: return 'idle'
  }
}

const ICON: Record<string, string> = {
  REQ: 'M4 4h10l4 4v12H4z M14 4v4h4', D: 'M5 19l4-1 9-9-3-3-9 9z M13 7l3 3', R1: 'M5 12l4 4 10-10',
  R: 'M4 4h10l4 4v12H4z M14 4v4h4 M8 13h8 M8 17h5', C: 'M9.1 9a3 3 0 015.8 1c0 2-3 3-3 3 M12 17h.01', DR: 'M11 4a7 7 0 100 14 7 7 0 000-14 M21 21l-5-5',
  H1: 'M5 12l4 4 10-10', H2: 'M5 12l4 4 10-10', H3: 'M5 12l4 4 10-10', T: 'M5 6h14 M5 12h14 M5 18h9', V: 'M9 12l2 2 4-4 M4 4h16v16H4z',
  X: 'M8 6l-5 6 5 6 M16 6l5 6-5 6', Y: 'M9 12l2 2 4-4 M12 3a9 9 0 100 18 9 9 0 000-18', A: 'M4 7h16v13H4z M3 3h18v4H3z M10 11h4',
  S: 'M4 7h16 M4 12h10 M4 17h7 M17 14l3 3-3 3',
  P: 'M5 6h14 M5 12h14 M5 18h9', R2: 'M5 12l4 4 10-10', X1: 'M8 6l-5 6 5 6 M16 6l5 6-5 6', X2: 'M9 12l2 2 4-4 M12 3a9 9 0 100 18 9 9 0 000-18',
  R3: 'M5 12l4 4 10-10', DONE: 'M4 20V5 M4 5h11l-2 4 2 4H4',
}

/** Card labels that must fit beside the version pill. */
const GRAPH_LABEL: Record<string, string> = { X1: '实施', X2: '验收' }

export function FlowGraph({ run, nodes, agents, reviews, inbox, selected, onSelect }: {
  run: RunRow
  nodes: NodeRow[]
  agents: AgentRow[]
  reviews: ReviewRow[]
  inbox: InboxItem[]
  selected: string | null
  onSelect: (key: string) => void
}) {
  const byKey = new Map(nodes.map(n => [n.node_key, n]))
  const KEYS = ['REQ', ...orderOf(run.template), 'DONE']
  // The full template has 14 cards: narrower cards without icons keep the labels readable.
  const compact = KEYS.length > 10
  const W = compact ? 96 : WIDE
  const GAP = compact ? 12 : WIDE_GAP
  const width = KEYS.length * (W + GAP) + GAP
  const height = TOP + H + BOTTOM
  const x = (i: number) => GAP + i * (W + GAP)
  const cy = TOP + H / 2
  const ix = (k: string) => KEYS.indexOf(k)
  const statusOf = (key: string): string => key === 'REQ' ? 'SUCCEEDED' : key === 'DONE' ? (run.status === 'COMPLETED' ? 'SUCCEEDED' : 'PENDING') : byKey.get(key)?.status ?? 'PENDING'
  const openByNode = new Map<string, number>()
  for (const item of inbox) {
    if (item.status === 'OPEN' && item.nodeKey) openByNode.set(item.nodeKey, (openByNode.get(item.nodeKey) ?? 0) + 1)
  }
  // Rejection history, one arc per gate → target pair.
  const rejections = new Map<string, { gate: string, target: string, count: number, active: boolean }>()
  for (const r of reviews) {
    if (r.decision !== 'REJECTED' || !r.rollback_to) continue
    const k = `${r.node_key}>${r.rollback_to}`
    const prev = rejections.get(k)
    rejections.set(k, { gate: r.node_key, target: r.rollback_to, count: (prev?.count ?? 0) + 1, active: byKey.get(r.node_key)?.status === 'REJECTED' })
  }
  const pAgents = agents.filter(a => a.node_id === byKey.get('P')?.id && a.version === byKey.get('P')?.current_version && a.role !== 'prereview')
  const loops = TEMPLATE_LOOPS[templateId(run.template)].map(({ fix, check }) => {
    const implement = fix === 'X' || fix === 'X1'
    const active = tone(statusOf(fix)) === 'run' || tone(statusOf(check)) === 'run' || (implement ? run.loop_round > 1 : (byKey.get(check)?.current_version ?? 0) > 1)
    const label = implement ? (run.loop_round > 0 ? `第 ${run.loop_round} 轮` : '实施 ⇄ 验证') : (byKey.get(check)?.current_version ?? 0) > 1 ? `审查 ${byKey.get(check)!.current_version} 次` : '设计 ⇄ 审查'
    return { fix, check, i1: ix(fix), i2: ix(check), active, label }
  }).filter(l => l.i1 >= 0 && l.i2 >= 0)

  return (
    <div className="rwf-graph" data-rdfoe-graph="">
      <svg viewBox={`0 0 ${width} ${height}`} style={{ maxWidth: width }} role="img" aria-label="工作流流程图">
        <defs>
          <marker id="rwf-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" className="rwf-arrowhead" />
          </marker>
          <marker id="rwf-arrow-loop" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" className="rwf-arrowhead loop" />
          </marker>
          <marker id="rwf-arrow-back" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" className="rwf-arrowhead back" />
          </marker>
        </defs>

        {KEYS.slice(0, -1).map((key, i) => {
          const from = tone(statusOf(key))
          const to = tone(statusOf(KEYS[i + 1]!))
          const cls = from === 'done' && (to === 'run' || to === 'wait') ? 'edge flowing' : from === 'done' && to === 'done' ? 'edge done' : 'edge'
          return <line key={`e${key}`} className={cls} x1={x(i) + W + 3} y1={cy} x2={x(i + 1) - 5} y2={cy} markerEnd="url(#rwf-arrow)" />
        })}

        {/* rejection history: faint dashed arcs above, stacked by span */}
        {[...rejections.values()].sort((a, b) => (ix(a.gate) - ix(a.target)) - (ix(b.gate) - ix(b.target))).map((r, n) => {
          const a = x(ix(r.gate)) + W / 2
          const b = x(ix(r.target)) + W / 2
          const lift = 26 + n * 12
          return (
            <g key={`back-${r.gate}-${r.target}`} className={`back${r.active ? ' active' : ''}`}>
              <path className="edge back" d={`M ${a - 10} ${TOP - 2} C ${a - 10} ${TOP - lift}, ${b + 10} ${TOP - lift}, ${b + 10} ${TOP - 5}`} markerEnd="url(#rwf-arrow-back)" />
              <text className="back-text" x={(a + b) / 2} y={TOP - lift + 4} textAnchor="middle">打回{r.count > 1 ? ` ×${r.count}` : ''}</text>
            </g>
          )
        })}

        {/* fix ⇄ check loops: a return arc from the check node back to the fix node */}
        {loops.map(({ fix, i1, i2, active, label }) => (
          <g key={`loop-${fix}`} className={`loop${active ? ' active' : ''}`} data-rdfoe-loop-arc={fix}>
            <path className="edge loop" d={`M ${x(i2) + W / 2} ${TOP + H + 4} C ${x(i2) + W / 2} ${TOP + H + 46}, ${x(i1) + W / 2} ${TOP + H + 46}, ${x(i1) + W / 2} ${TOP + H + 7}`} markerEnd="url(#rwf-arrow-loop)" />
            <g transform={`translate(${(x(i1) + x(i2) + W) / 2}, ${TOP + H + 58})`}>
              <rect className="loop-pill" x={-46} y={-12} width={92} height={24} rx={12} />
              <text className="loop-text" textAnchor="middle" y={4}>{label}</text>
            </g>
          </g>
        ))}

        {KEYS.map((key, i) => {
          const node = byKey.get(key)
          const status = statusOf(key)
          const t = tone(status)
          const label = key === 'REQ' ? '需求' : key === 'DONE' ? '完成' : GRAPH_LABEL[key] ?? NODE_LABEL[key] ?? key
          const sub = key === 'REQ' ? '需求原文' : key === 'DONE' ? (run.status === 'COMPLETED' ? '工作流完成' : '') : STATUS_LABEL[status] ?? status
          const clickable = node !== undefined
          const pending = openByNode.get(key) ?? 0
          const gate = isGateKey(key)
          const rx = gate ? H / 2 : 14
          const textX = compact ? (gate ? 16 : 12) : gate ? 48 : 44
          return (
            <g
              key={key}
              className={`n t-${t}${selected === key ? ' sel' : ''}${clickable ? ' click' : ''}`}
              data-node={key}
              data-status={status}
              transform={`translate(${x(i)},${TOP})`}
              onClick={clickable ? () => onSelect(key) : undefined}
              onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(key) } } : undefined}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              aria-label={clickable ? `${label} ${sub}` : undefined}
            >
              {t === 'run' && <rect className="pulse" width={W} height={H} rx={rx} />}
              <rect className="card" width={W} height={H} rx={rx} />
              {!compact && <g transform={`translate(${gate ? 18 : 14}, ${H / 2 - 20})`}>
                <circle className="icon-bg" cx={11} cy={11} r={13} />
                <path className="icon" d={ICON[key]} transform="translate(2,2) scale(0.75)" />
              </g>}
              <text className="label" x={textX} y={H / 2 - 3}>{label}</text>
              <text className="sub" x={textX} y={H / 2 + 15}>{sub}</text>
              {node && !gate && node.current_version > 0 && (
                <g transform={`translate(${W - 10}, 16)`}>
                  <rect className="ver" x={-26} y={-9} width={26} height={17} rx={8.5} />
                  <text className="ver-text" x={-13} y={3.5} textAnchor="middle">v{node.current_version}</text>
                </g>
              )}
              {key === 'P' && pAgents.length > 0 && (
                <g transform={`translate(${W - 30}, ${H - 13})`}>
                  {pAgents.map((a, j) => <circle key={a.id} className={`sub-dot t-${a.status === 'COMPLETED' ? 'done' : a.status === 'RUNNING' ? 'run' : a.status === 'FAILED' ? 'err' : 'warn'}`} cx={j * 11} cy={0} r={3.5} />)}
                </g>
              )}
              {(t === 'wait' || pending > 0) && (
                <g className="attention" transform={`translate(${W - 2}, 2)`}>
                  <circle className="attention-ring" r={11} />
                  <circle className="attention-dot" r={11} />
                  <text className="attention-text" textAnchor="middle" y={4}>{pending > 0 ? pending : '!'}</text>
                </g>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
