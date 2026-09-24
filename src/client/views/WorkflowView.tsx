/**
 * The per-session 工作流 view (`conversation.view`, §9.2): run header with
 * progress and controls, the flow graph, then node detail / this run's inbox
 * / loop record / event log.
 */
import { useEffect, useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { NODE_LABEL, ROLE_LABEL, RUN_STATUS_LABEL, TEMPLATE_LABEL, getJson, orderOf, postJson, relativeTime, statusLabel, templateId, useStream, type RunSnapshot } from '../api.ts'
import { Skeleton } from './Artifacts.tsx'
import { FlowGraph, tone } from './FlowGraph.tsx'
import { EmptyState, InboxList, type InboxActions } from './Inbox.tsx'
import { NodeDetail } from './NodeDetail.tsx'

export interface WorkflowViewInjected extends InboxActions {
  openInbox: () => void
}

type Tab = 'node' | 'inbox' | 'loop' | 'events'
const RUN_TONE = { done: 'success', run: 'info', wait: 'warning', warn: 'warning', err: 'danger', idle: 'neutral' } as const

/** Re-render every second while something runs, so elapsed times tick. */
function useTicker(active: boolean) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(timer)
  }, [active])
}

export function WorkflowView(props: WorkflowViewInjected & { sessionId: string }) {
  const { sessionId } = props
  const { data, status } = useStream<RunSnapshot & { type: string }>(`/events?sessionId=${encodeURIComponent(sessionId)}`, 'run')
  const [tab, setTab] = useState<Tab>('node')
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const running = data?.nodes?.some(n => n.status === 'RUNNING') ?? false
  useTicker(running)

  const act = async (path: string, body: Record<string, unknown>) => {
    setError(null)
    setBusy(path)
    try { await postJson(path, body) } catch (e) { setError(String((e as Error).message)) } finally { setBusy(null) }
  }

  if (!data) {
    return <div className="rwf rwf-view"><div className="rwf-card"><Skeleton lines={3} /></div><div className="rwf-card"><Skeleton lines={5} /></div></div>
  }
  if (data.nodeOf) {
    const n = data.nodeOf
    return (
      <div className="rwf rwf-view" data-rdfoe-view="node-session">
        <EmptyState icon="flow" title={`这是工作流 ${n.runId} 的「${NODE_LABEL[n.nodeKey ?? ''] ?? n.nodeKey}」节点会话`}>
          {ROLE_LABEL[n.role] ?? n.role} · v{n.version}
          <div style={{ marginTop: 12 }}><Button size="sm" variant="primary" onClick={() => props.openSessionWorkflow(n.mainSessionId)}>返回主会话的工作流</Button></div>
        </EmptyState>
      </div>
    )
  }
  if (!data.run) return <StartWorkflow sessionId={sessionId} openSessionWorkflow={props.openSessionWorkflow} />

  const run = data.run
  const nodes = data.nodes ?? []
  const inbox = data.inbox ?? []
  const openItems = inbox.filter(i => i.status === 'OPEN')
  const order = orderOf(run.template)
  const current = selected ?? run.current_node ?? order[0]!
  const interrupted = run.status === 'INTERRUPTED' || nodes.some(n => n.status === 'INTERRUPTED')
  const stalled = openItems.some(i => i.kind === 'loop_stall')
  const doneCount = nodes.filter(n => n.status === 'SUCCEEDED' || n.status === 'APPROVED').length
  const runTone = tone(run.status === 'RUNNING' && openItems.some(i => i.blocking) ? 'WAITING_ANSWER' : run.status)
  const waiting = openItems.filter(i => i.blocking).length

  return (
    <div className="rwf rwf-view" data-rdfoe-view="run" data-run={run.id}>
      <div className="rwf-run-head">
        <div className="rwf-row">
          <h3>{run.title || run.id}</h3>
          <Tag tone={RUN_TONE[runTone]}><span data-rdfoe-run-status={run.status}>{run.status === 'RUNNING' && waiting > 0 ? `等你处理 ${waiting} 项` : RUN_STATUS_LABEL[run.status] ?? run.status}</span></Tag>
          <span className="rwf-spacer" />
          {!stalled && (interrupted || run.status === 'PAUSED' || run.status === 'FAILED') && (
            <Button size="sm" variant="primary" data-rdfoe-continue="" disabled={busy !== null} onClick={() => act('/run/continue', { runId: run.id })}>{busy === '/run/continue' ? '恢复中…' : '继续'}</Button>
          )}
          {run.status === 'RUNNING' && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act('/run/pause', { runId: run.id })}>暂停</Button>}
          {!['COMPLETED', 'CANCELLED', 'ORPHANED'].includes(run.status) && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => { if (confirm('取消这条工作流？正在运行的子代理会被停止。')) void act('/run/cancel', { runId: run.id }) }}>取消</Button>}
          <Button size="sm" variant="outline" onClick={props.openInbox}>收件箱{openItems.length > 0 && <span className="rwf-count">{openItems.length}</span>}</Button>
        </div>
        <div className="rwf-meta">
          <span>{run.id}</span>
          {run.branch ? <span>分支 <code>{run.branch}</code></span> : <span className="rwf-warn-text">非 git 目录：直接在项目目录工作</span>}
          <span>{TEMPLATE_LABEL[templateId(run.template)]}</span>
          <span>{doneCount}/{order.length} 个环节完成</span>
          {run.loop_round > 0 && <span>实施⇄验证第 {run.loop_round} 轮</span>}
          <span>创建于 {relativeTime(run.created_at)}</span>
          <span className={`rwf-live ${status === 'live' ? 'on' : ''}`}>{status === 'live' ? '实时' : '连接中…'}</span>
        </div>
        <div className="rwf-progress"><span style={{ width: `${Math.round(doneCount / order.length * 100)}%` }} className={`t-${tone(run.status)}`} /></div>
      </div>
      {templateId(run.template) === 'legacy' && <div className="rwf-callout warn">这是 0.1.0-beta.4 之前旧版流程的工作流，只能查看，不能继续推进。需要继续开发请在新会话里重新开启工作流。</div>}
      {stalled && <div className="rwf-callout warn">{openItems.find(i => i.kind === 'loop_stall')?.payload?.loop === 'design' ? '设计⇄审查循环已暂停，请在收件箱处理「防空转」询问：再改一轮、带着阻断交给你审核，或终止。' : '实施⇄验证循环已暂停，请在收件箱处理「防空转」询问：继续、回到任务规划或终止。'}<Button size="sm" variant="ghost" onClick={() => setTab('inbox')}>去处理</Button></div>}
      {interrupted && !stalled && <div className="rwf-callout warn">DSH 重启后，这条工作流停在中断处。点「继续」从断点恢复{openItems.some(i => i.blocking && i.kind === 'question') ? '；重启前的提问仍可在收件箱作答，答复后对应子代理会自动续上' : ''}。</div>}
      {error && <div className="rwf-callout err">{error}</div>}
      <FlowGraph run={run} nodes={nodes} agents={data.agents ?? []} reviews={data.reviews ?? []} inbox={inbox} selected={current} onSelect={(k) => { setSelected(k); setTab('node') }} />
      <div className="rwf-tabs" role="tablist">
        {([['node', `节点 · ${NODE_LABEL[current] ?? current}`], ['inbox', '收件箱'], ['loop', '循环记录'], ['events', '事件']] as const).map(([key, label]) => (
          <button key={key} type="button" role="tab" className="rwf-tab" aria-selected={tab === key} onClick={() => setTab(key)} data-rdfoe-tab={key}>
            {label}{key === 'inbox' && openItems.length > 0 && <span className="rwf-count">{openItems.length}</span>}
          </button>
        ))}
      </div>
      {tab === 'node' && <NodeDetail data={data} nodeKey={current} actions={props} onRetry={k => act('/node/retry', { runId: run.id, node: k })} onAccept={k => act('/node/accept', { runId: run.id, node: k })} />}
      {tab === 'inbox' && <InboxList items={inbox} grouped={false} actions={props} embedded />}
      {tab === 'loop' && <LoopRecord data={data} />}
      {tab === 'events' && <EventLog data={data} />}
    </div>
  )
}

function LoopRecord({ data }: { data: RunSnapshot }) {
  const loop = data.loop ?? []
  const x1 = (data.versions ?? []).filter(v => v.node_key === 'X1')
  if (loop.length === 0) return <EmptyState icon="flow" title="还没有验收结果">实施与验收开始后，每一轮的失败项和修复摘要会记在这里。</EmptyState>
  const max = Math.max(1, ...loop.map(l => l.total))
  return (
    <div className="rwf-trend big" data-rdfoe-loop="">
      {loop.map(l => (
        <div key={l.round} className="rwf-trend-row">
          <span className="r">第 {l.round} 轮</span>
          <span className="bar"><span className={l.failed === 0 ? 'pass' : 'fail'} style={{ width: `${l.failed === 0 ? 100 : (l.failed / max) * 100}%` }} /></span>
          <span className="n">{l.failed === 0 ? '全部通过' : `${l.failed}/${l.total} 失败`}</span>
          <span className="rwf-muted ids">{l.failedIds.join('、')}</span>
          <span className="summary">{x1.find(v => v.round === l.round)?.summary ?? ''}</span>
        </div>
      ))}
    </div>
  )
}

const EVENT_LABEL: Record<string, string> = {
  'run:create': '创建工作流', 'run:start': '开始运行', 'run:pause': '暂停', 'run:resume': '恢复', 'run:interrupt': '中断', 'run:complete': '完成', 'run:cancel': '取消',
  'node:start': '节点开始', 'node:succeed': '节点完成', 'node:fail': '节点失败', 'node:wait': '等待回答', 'node:answered': '收到回答', 'node:stale': '标记重做',
  'node:open': '进入审核', 'node:approve': '审核通过', 'node:reject': '审核打回', 'node:interrupt': '节点中断', 'node:resume': '节点恢复', 'node:retry': '重试',
  'node:finalize': '定稿', 'node:block': '需求仍有阻断', 'node:accept': '按当前需求继续', 'agent:start': '子代理启动', 'agent:end': '子代理结束', 'inbox_item:resolve': '收件箱已处理', 'inbox_item:cancel': '收件箱条目取消',
}

function EventLog({ data }: { data: RunSnapshot }) {
  const nodes = new Map((data.nodes ?? []).map(n => [n.id, n.node_key]))
  const events = data.events ?? []
  if (events.length === 0) return <EmptyState title="暂无事件" />
  return (
    <div className="rwf-events" data-rdfoe-events="">
      {events.map(e => {
        const label = EVENT_LABEL[e.type] ?? (e.type.startsWith('inbox_item:create:') ? `新${({ question: '问题', message: '消息', review: '审核项', loop_stall: '防空转询问' } as Record<string, string>)[e.type.split(':')[2]!] ?? '条目'}` : e.type)
        const node = e.node_id ? nodes.get(e.node_id) : undefined
        return (
          <div key={e.id} className={`rwf-event t-${tone(e.after ?? '')}`}>
            <span className="time">{e.ts.slice(11, 19)}</span>
            <span className="dot" />
            <span className="what">{node ? <b>{NODE_LABEL[node] ?? node}</b> : null} {label}{e.before && e.after ? <span className="rwf-muted"> {statusLabel(e.before)} → {statusLabel(e.after)}</span> : null}</span>
            {e.payload_json && <span className="rwf-muted payload">{e.payload_json.slice(0, 140)}</span>}
          </div>
        )
      })}
    </div>
  )
}

/** Empty state (§9.1 「为本会话开启工作流」): explain the flow and start it in one click, same as wf_start. */
function StartWorkflow({ sessionId, openSessionWorkflow }: { sessionId: string, openSessionWorkflow: (sessionId: string) => void }) {
  const [requirement, setRequirement] = useState('')
  const [template, setTemplate] = useState<'full' | 'small'>('full')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = async () => {
    setBusy(true)
    setError(null)
    try { await postJson('/run/start', { sessionId, requirement, template }) } catch (e) { setError(String((e as Error).message)); setBusy(false) }
  }
  const steps: [string, string][] = template === 'full'
    ? [['需求录入 · 澄清', '记录需求，逐个问清阻断决定'], ['设计 ⇄ 设计审查', 'AI 审查有阻断就自动重做设计'], ['设计批准', '你来拍板'], ['任务规划 → 验证计划', '任务清单，再写自测计划与验收指引'], ['授权实施', '你来拍板'], ['实施 ⇄ 验证', '改代码、跑测试，自测不过自动再修'], ['用户验收', '按验收指引确认成果，你来拍板'], ['归档', '写归档摘要，代码留在独立分支']]
    : [['小改动', '改动说明、任务、验证计划与验收指引'], ['授权实施', '你来拍板'], ['实施 ⇄ 验证', '改代码、跑测试，自测不过自动再修'], ['用户验收', '按验收指引确认成果，你来拍板'], ['归档', '写归档摘要']]
  return (
    <div className="rwf rwf-view" data-rdfoe-view="empty">
      <div className="rwf-start">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="logo" aria-hidden="true"><circle cx="5" cy="12" r="2.2" /><circle cx="12" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" /><circle cx="19" cy="12" r="2.2" /><path d="M7 11l3-3.5M7 13l3 3.5M14 7.5l3 3M14 16.5l3-3" /></svg>
        <h3>为本会话开启工作流</h3>
        <p className="rwf-sub">描述你的需求，插件会在后台用一组子代理把它推进到可合并的代码；三道审核都由你拍板，问题和审核集中在侧边栏「收件箱」。</p>
        <div className="rwf-seg" role="radiogroup" aria-label="流程模板" data-rdfoe-template="">
          {(['full', 'small'] as const).map(t => (
            <button key={t} type="button" role="radio" aria-checked={template === t} aria-pressed={template === t} onClick={() => setTemplate(t)} data-rdfoe-template-option={t}>
              {t === 'full' ? '完整流程' : '小改动（--small）'}
            </button>
          ))}
        </div>
        <ol className="rwf-start-steps">
          {steps.map(([name, hint], i) => <li key={name}><b>{i + 1}</b><span className="name">{name}</span><span className="rwf-muted">{hint}</span></li>)}
        </ol>
        <textarea
          className="rwf-textarea"
          placeholder="需求描述，例如：给 utils 增加 slugify 函数，支持中文转拼音，并补上单元测试"
          value={requirement}
          onChange={e => setRequirement(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && requirement.trim()) { e.preventDefault(); void start() } }}
          data-rdfoe-requirement=""
        />
        <div className="rwf-actions">
          <Button variant="primary" disabled={busy || !requirement.trim()} onClick={() => void start()} data-rdfoe-start="">{busy ? '正在开启…' : '开启工作流'}</Button>
          <span className="rwf-muted small">也可以在「对话」里让模型调用 wf_start。git 仓库会在独立的 worktree 和分支上工作，不改动你当前的分支。</span>
        </div>
        {error && <div className="rwf-callout err">{error}</div>}
      </div>
      <LocalRuns currentSessionId={sessionId} openSessionWorkflow={openSessionWorkflow} />
    </div>
  )
}

interface LocalRun { id: string, title: string, status: string, template: string, currentNode: string | null, sessionId: string, sessionTitle: string | null, projectPath: string, updatedAt: string }

/**
 * 本机的工作流: every run in this plugin's database with a way back to its
 * session. DSH's session list hid sessions that only ran /rdfoe-workflow
 * before 0.1.0-beta.5; opening one here also makes DSH list it again.
 */
function LocalRuns({ currentSessionId, openSessionWorkflow }: { currentSessionId: string, openSessionWorkflow: (sessionId: string) => void }) {
  const [runs, setRuns] = useState<LocalRun[] | null>(null)
  useEffect(() => {
    let live = true
    getJson<{ runs: LocalRun[] }>('/runs').then(r => { if (live) setRuns(r.runs) }, () => { if (live) setRuns([]) })
    return () => { live = false }
  }, [])
  const others = runs?.filter(r => r.sessionId !== currentSessionId) ?? []
  if (others.length === 0) return null
  return (
    <div className="rwf-local-runs" data-rdfoe-local-runs="">
      <div className="rwf-local-runs-head">本机的工作流<span className="rwf-muted small">{others.length} 条</span></div>
      {others.map(run => (
        <div key={run.id} className="rwf-local-run" data-rdfoe-local-run={run.id}>
          <div className="grow">
            <div className="name">{run.title || run.id}</div>
            <div className="rwf-muted small">
              {run.id} · {RUN_STATUS_LABEL[run.status] ?? run.status}{run.currentNode ? ` · ${NODE_LABEL[run.currentNode] ?? run.currentNode}` : ''} · {TEMPLATE_LABEL[templateId(run.template)]} · {relativeTime(run.updatedAt)}
            </div>
          </div>
          <Button size="sm" variant="ghost" data-rdfoe-open-session={run.sessionId} onClick={() => openSessionWorkflow(run.sessionId)}>打开会话</Button>
        </div>
      ))}
    </div>
  )
}
