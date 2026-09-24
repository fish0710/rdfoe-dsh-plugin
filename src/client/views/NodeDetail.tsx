/**
 * Node detail page (§9.2): header (status, version switcher, time, model,
 * agent session), result summary, round input for the loop nodes, the
 * node's inbox items handled in place, artifacts with version comparison,
 * and a live activity timeline built from the tool_call audit.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { KIND_LABEL, NODE_LABEL, ROLE_LABEL, gateSubject, isCheckKey, isImplKey, relativeTime, statusLabel, type AgentRow, type RunSnapshot, type ToolCallRow, type VersionRow } from '../api.ts'
import { ArtifactBrowser } from './Artifacts.tsx'
import { tone } from './FlowGraph.tsx'
import { ItemDetail, type InboxActions } from './Inbox.tsx'

const TONE_TAG = { done: 'success', run: 'info', wait: 'warning', warn: 'warning', err: 'danger', idle: 'neutral' } as const

function duration(from: string | null | undefined, to: string | null | undefined): string {
  if (!from) return '—'
  const ms = (to ? Date.parse(to) : Date.now()) - Date.parse(from)
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${Math.floor(s / 3600)} 小时 ${Math.floor(s % 3600 / 60)} 分`
}

interface Structured {
  summary?: string
  openIssues?: string[]
  confidence?: number
  verdict?: string
  items?: { id: string, result: string, evidence: string }[]
}

const parse = (v: VersionRow | undefined): Structured => (v ? JSON.parse(v.structured_json) as Structured : {})

// ── activity timeline ───────────────────────────────────────────────────────

const TOOL_META: Record<string, { label: string, icon: string }> = {
  wf_read: { label: '读取', icon: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 100 6 3 3 0 000-6' },
  wf_list: { label: '列目录', icon: 'M3 7h7l2 2h9v10H3z' },
  wf_search: { label: '搜索', icon: 'M11 4a7 7 0 100 14 7 7 0 000-14 M21 21l-5-5' },
  wf_write: { label: '写入', icon: 'M5 19l4-1 9-9-3-3-9 9z' },
  wf_edit: { label: '修改', icon: 'M4 20h4L19 9l-4-4L4 16z' },
  wf_exec: { label: '执行', icon: 'M4 17l6-5-6-5 M12 19h8' },
  wf_git: { label: 'Git', icon: 'M6 3v12 M18 9a3 3 0 100-6 3 3 0 000 6z M6 21a3 3 0 100-6 3 3 0 000 6z M18 9a9 9 0 01-9 9' },
  wf_ask: { label: '提问', icon: 'M9.1 9a3 3 0 015.8 1c0 2-3 3-3 3 M12 17h.01' },
  wf_message: { label: '消息', icon: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z' },
  wf_report: { label: '提交结果', icon: 'M5 12l4 4 10-10' },
}

function callText(c: ToolCallRow): string {
  if (c.tool === 'wf_exec') return c.args_digest
  try {
    const args = JSON.parse(c.args_digest) as Record<string, unknown>
    return String(args.path ?? args.pattern ?? args.action ?? args.question ?? args.text ?? args.summary ?? '')
  } catch {
    return c.args_digest
  }
}

function Timeline({ calls, live }: { calls: ToolCallRow[], live: boolean }) {
  if (calls.length === 0) return <div className="rwf-empty small">{live ? '子代理刚启动，工具调用会实时出现在这里。' : '这个版本没有工具调用。'}</div>
  return (
    <ol className="rwf-timeline" data-rdfoe-timeline="">
      {live && <li className="rwf-tl-item live"><span className="rwf-tl-icon"><span className="rwf-spinner" /></span><span className="rwf-tl-body rwf-muted">进行中…</span></li>}
      {calls.map((c) => {
        const meta = TOOL_META[c.tool] ?? { label: c.tool, icon: 'M12 12h.01' }
        const failed = c.exit_code !== null && c.exit_code !== 0
        const text = callText(c)
        return (
          <li key={c.id} className={`rwf-tl-item${failed ? ' failed' : ''}`} data-tool={c.tool}>
            <span className="rwf-tl-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={meta.icon} /></svg></span>
            <span className="rwf-tl-body">
              <span className="rwf-tl-head">
                <b>{meta.label}</b>
                {c.tool === 'wf_exec'
                  ? <code className="rwf-tl-cmd">{text}</code>
                  : <span className="rwf-tl-text">{text}</span>}
              </span>
              <span className="rwf-tl-meta">
                {c.tool === 'wf_exec' && c.exit_code !== null && <span className={failed ? 'rwf-err-text' : 'rwf-ok-text'}>退出码 {c.exit_code}</span>}
                {c.tool !== 'wf_exec' && failed && <span className="rwf-err-text">出错</span>}
                <span>{c.duration_ms < 1000 ? `${c.duration_ms}ms` : `${(c.duration_ms / 1000).toFixed(1)}s`}</span>
                <span>{c.ts.slice(11, 19)}</span>
              </span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

// ── page ────────────────────────────────────────────────────────────────────

function Section({ title, extra, children }: { title: string, extra?: ReactNode, children: ReactNode }) {
  return (
    <section className="rwf-sec">
      <div className="rwf-sec-head"><h5>{title}</h5>{extra}</div>
      {children}
    </section>
  )
}

export function NodeDetail({ data, nodeKey, actions, onRetry, onAccept }: { data: RunSnapshot, nodeKey: string, actions: InboxActions, onRetry: (key: string) => void, onAccept: (key: string) => void }) {
  const run = data.run!
  const node = (data.nodes ?? []).find(n => n.node_key === nodeKey)
  const gate = node?.kind === 'review'
  const subjectKey = gateSubject(run.template, nodeKey) ?? nodeKey
  const allVersions = data.versions ?? []
  const nodeVersions = allVersions.filter(v => v.node_key === subjectKey)
  const agentsAll = (data.agents ?? []).filter(a => a.node_id === node?.id)
  const versionNumbers = useMemo(() => {
    const set = new Set<number>([...nodeVersions.map(v => v.version), ...agentsAll.filter(a => a.role !== 'prereview').map(a => a.version)])
    if (!gate && node && node.current_version > 0) set.add(node.current_version)
    return [...set].sort((a, b) => b - a)
  }, [nodeVersions, agentsAll, gate, node])
  const [picked, setPicked] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => { setPicked(null) }, [nodeKey])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2400)
    return () => clearTimeout(timer)
  }, [toast])

  if (!node) return <div className="rwf-empty small">点击流程图里的节点查看详情。</div>
  const version = picked ?? versionNumbers[0] ?? 0
  const versionRow = nodeVersions.find(v => v.version === version)
  const s = parse(versionRow)
  const agents: AgentRow[] = gate ? agentsAll : agentsAll.filter(a => a.version === version && a.role !== 'prereview')
  const sessionIds = new Set(agents.map(a => a.agent_session_id).filter(Boolean))
  const calls = (data.toolCalls ?? []).filter(c => c.node_id === node.id && (gate || sessionIds.has(c.agent_session_id as string)))
  const live = agents.some(a => a.status === 'RUNNING')
  const started = agents.map(a => a.started_at).sort()[0] ?? node.started_at
  const ended = live ? null : agents.map(a => a.ended_at).filter(Boolean).sort().at(-1) ?? node.ended_at
  const models = [...new Set(agents.map(a => a.model).filter(Boolean))]
  const lastAgent = agents.filter(a => a.agent_session_id).at(-1)
  const items = (data.inbox ?? []).filter(i => i.nodeKey === nodeKey)
  const openItems = items.filter(i => i.status === 'OPEN')
  const doneItems = items.filter(i => i.status !== 'OPEN')
  const t = tone(node.status)

  // Loop context: X of round r fixes the failures of Y round r-1; the check node shows its own results.
  const round = versionRow?.round ?? (version === node.current_version ? run.loop_round : 0)
  const checkKey = nodeKey === 'X1' || nodeKey === 'R3' ? 'X2' : nodeKey === 'H1' ? 'DR' : 'Y'
  const checkVersions = allVersions.filter(v => v.node_key === checkKey)
  const previousX2 = isImplKey(nodeKey) && round > 1 ? checkVersions.filter(v => v.round === round - 1).at(-1) : undefined
  const failuresIn = parse(previousX2).items?.filter(i => i.result === 'fail') ?? []

  return (
    <div className="rwf-detail" data-rdfoe-node-detail={nodeKey}>
      <div className="rwf-detail-head">
        <div className="rwf-row">
          <span className={`rwf-status-dot t-${t}`} />
          <h4>{NODE_LABEL[nodeKey]}</h4>
          <Tag tone={TONE_TAG[t]}><span data-rdfoe-node-status={node.status}>{statusLabel(node.status)}</span></Tag>
          {versionNumbers.length > 0 && (
            <select className="rwf-select" value={version} onChange={e => setPicked(Number(e.target.value))} aria-label="版本" data-rdfoe-version-picker="">
              {versionNumbers.map(v => <option key={v} value={v}>{gate ? `${NODE_LABEL[subjectKey]} ` : ''}v{v}{v === node.final_version || (gate && v === versionNumbers[0]) ? (node.final_version === v ? ' · 定稿' : '') : ''}</option>)}
            </select>
          )}
          {round > 0 && (isImplKey(nodeKey) || nodeKey === 'Y' || nodeKey === 'X2') && <Tag tone="outline">第 {round} 轮</Tag>}
          <span className="rwf-spacer" />
          {(node.status === 'FAILED' || node.status === 'BLOCKED') && run.status === 'RUNNING' && <Button size="sm" variant="primary" data-rdfoe-retry="" onClick={() => onRetry(nodeKey)}>{node.status === 'BLOCKED' ? '重新澄清' : '重试'}</Button>}
          {node.status === 'BLOCKED' && run.status === 'RUNNING' && <Button size="sm" variant="outline" data-rdfoe-accept="" onClick={() => onAccept(nodeKey)}>按当前需求继续</Button>}
          {lastAgent && (
            <Button size="sm" variant="outline" data-rdfoe-open-aside={lastAgent.agent_session_id!} onClick={() => actions.openAgentAside(run.session_id, lastAgent.agent_session_id!)}>
              在右侧打开子代理会话
            </Button>
          )}
        </div>
        <div className="rwf-facts">
          <div><span>耗时</span><b>{live ? `已运行 ${duration(started, null)}` : duration(started, ended)}</b></div>
          <div><span>模型</span><b>{models.length ? models.join('、') : '—'}</b></div>
          <div><span>子代理</span><b>{agents.length ? agents.map(a => ROLE_LABEL[a.role] ?? a.role).join('、') : '—'}</b></div>
          <div><span>执行次数</span><b>{node.attempt || '—'}</b></div>
          {versionRow?.commit_sha && <div><span>提交</span><b className="mono">{versionRow.commit_sha.slice(0, 8)}</b></div>}
        </div>
        {node.status === 'WAITING_ANSWER' && <div className="rwf-activity wait">子代理在等你回答，下方「待你处理」里直接作答即可。</div>}
        {node.status === 'BLOCKED' && <div className="rwf-callout warn">需求澄清仍有阻断（见下方「需关注」）。回复收件箱里的提示消息补充信息，会自动重新澄清；也可以点「按当前需求继续」进入设计。</div>}
        {node.error && <div className="rwf-callout err">{node.error}</div>}
      </div>

      {openItems.length > 0 && (
        <Section title={`待你处理 · ${openItems.length}`}>
          {openItems.map(item => (
            <div key={item.id} className="rwf-card rwf-inline-item" data-rdfoe-inline-item={item.kind}>
              <ItemDetail item={item} actions={actions} answered={false} done={message => setToast(message)} compact />
            </div>
          ))}
        </Section>
      )}
      {toast && <div className="rwf-toast" role="status" data-rdfoe-toast="">{toast}</div>}

      {(versionRow || gate) && (
        <Section title={gate ? `待审内容 · ${NODE_LABEL[subjectKey]} v${version}` : `结果摘要 · v${version}`} extra={s.confidence !== undefined && (
          <span className="rwf-confidence" title="子代理自评置信度">
            置信度<span className="bar"><span style={{ width: `${Math.round(s.confidence * 100)}%` }} className={s.confidence < 0.7 ? 'low' : ''} /></span>{Math.round(s.confidence * 100)}%
          </span>
        )}>
          {versionRow
            ? (
              <div className="rwf-card">
                <div className="rwf-summary-text">{versionRow.summary}</div>
                {s.openIssues && s.openIssues.length > 0 && <div className="rwf-callout warn"><b>需关注（openIssues）</b><ul>{s.openIssues.map(o => <li key={o}>{o}</li>)}</ul></div>}
              </div>
            )
            : <div className="rwf-empty small">还没有可审的结果。</div>}
        </Section>
      )}

      {isImplKey(nodeKey) && round > 1 && (
        <Section title={`本轮输入 · 第 ${round - 1} 轮验证失败项`}>
          {failuresIn.length === 0
            ? <div className="rwf-empty small">上一轮没有失败项。</div>
            : <ul className="rwf-fail-list">{failuresIn.map(f => <li key={f.id}><Tag tone="danger">{f.id}</Tag><span>{f.evidence}</span></li>)}</ul>}
        </Section>
      )}

      {(isCheckKey(nodeKey) || nodeKey === 'R3' || nodeKey === 'H3' || nodeKey === 'H1') && (() => {
        const check = isCheckKey(nodeKey) ? versionRow : checkVersions.at(-1)
        const xs = parse(check)
        if (!xs.items) return null
        const passed = xs.items.filter(i => i.result === 'pass').length
        const review = nodeKey === 'DR' || nodeKey === 'H1'
        return (
          <Section title={`${review ? '设计审查' : '验证结果'} · ${passed}/${xs.items.length} 通过`} extra={<Tag tone={xs.verdict === 'pass' ? 'success' : 'danger'}>{review ? (xs.verdict === 'pass' ? '无阻断' : '有阻断') : (xs.verdict === 'pass' ? '验证通过' : '验证未通过')}</Tag>}>
            <table className="rwf-table"><thead><tr><th>条目</th><th>结果</th><th>证据</th></tr></thead><tbody>
              {xs.items.map(i => <tr key={i.id}><td>{i.id}</td><td><Tag tone={i.result === 'pass' ? 'success' : 'danger'}>{i.result === 'pass' ? '通过' : '未通过'}</Tag></td><td className="rwf-evidence">{i.evidence}</td></tr>)}
            </tbody></table>
          </Section>
        )
      })()}

      <Section title="产物">
        <ArtifactBrowser key={`${nodeKey}-${version}`} runId={run.id} versions={nodeVersions.map(v => ({ version: v.version, artifacts: JSON.parse(v.artifacts_json) as string[] }))} initialVersion={version} />
      </Section>

      <Section title={`活动时间线 · ${calls.length}`} extra={live && <span className="rwf-live on">实时</span>}>
        <Timeline calls={calls} live={live} />
      </Section>

      {doneItems.length > 0 && (
        <Section title={`已处理的收件箱条目 · ${doneItems.length}`}>
          <div className="rwf-list">
            {doneItems.map(i => (
              <div key={i.id} className="rwf-list-row">
                <Tag tone="outline">{KIND_LABEL[i.kind]}</Tag>
                <span className="grow rwf-sub">{i.kind === 'review' ? (i.response?.action === 'approve' ? '通过' : `打回：${i.response?.comment ?? ''}`) : i.kind === 'question' ? (i.payload?.questions ?? []).map((q: { question: string }) => q.question).join(' / ') : String(i.payload?.text ?? i.payload?.reason ?? '')}</span>
                <span className="rwf-muted small">{relativeTime(i.resolvedAt ?? i.createdAt)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}
