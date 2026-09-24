/**
 * Unified inbox (§7.2, §9.3): one list/detail component used by the global
 * panel (all runs, grouped by workflow) and by the 收件箱 tab of a session's
 * workflow view (one run). Both read the same /api data and answer through
 * the same /inbox/respond route.
 *
 * Keyboard: ↑/↓ or j/k move, Enter jumps into the detail, 1–9 pick an option
 * of the first question, ⌘/Ctrl+Enter submits the primary action.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { KIND_LABEL, NODE_LABEL, ROLE_LABEL, RUN_STATUS_LABEL, getJson, postJson, relativeTime, useSharedStream, useStream, type InboxItem, type InboxSnapshot } from '../api.ts'
import { ArtifactDoc, Markdown, Skeleton } from './Artifacts.tsx'

export interface InboxActions {
  /** Open the source session in the main column on its 工作流 view. */
  openSessionWorkflow: (sessionId: string) => void
  /** Open a node agent session in the right sidebar. */
  openAgentAside: (parentSessionId: string, agentSessionId: string) => void
}

type Done = (message: string, id: string) => void

// ── list ────────────────────────────────────────────────────────────────────

type StatusFilter = 'open' | 'all' | 'done'
type KindFilter = 'all' | InboxItem['kind']

function preview(item: InboxItem): string {
  const p = item.payload ?? {}
  switch (item.kind) {
    case 'question': return (p.questions ?? []).map((q: { question: string }) => q.question).join(' / ')
    case 'message': return p.text ?? ''
    case 'review': return `${p.label ?? p.gate} · ${(p.subjects ?? []).map((s: { label: string, version: number }) => `${s.label} v${s.version}`).join('、')}`
    case 'loop_stall': return p.reason ?? ''
  }
}

function who(item: InboxItem): string {
  if (item.agentRole) return ROLE_LABEL[item.agentRole] ?? item.agentRole
  if (item.payload?.role === 'system') return '工作流'
  return item.nodeKey ? NODE_LABEL[item.nodeKey] ?? item.nodeKey : '工作流'
}

const KIND_ICON: Record<InboxItem['kind'], string> = {
  question: 'M12 2a10 10 0 100 20 10 10 0 000-20 M9.1 9a3 3 0 015.8 1c0 2-3 3-3 3 M12 17h.01',
  message: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z',
  review: 'M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
  loop_stall: 'M10 9v6 M14 9v6 M12 2a10 10 0 100 20 10 10 0 000-20',
}

function KindIcon({ kind }: { kind: InboxItem['kind'] }) {
  return (
    <svg className={`rwf-kind-icon k-${kind}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={KIND_ICON[kind]} />
    </svg>
  )
}

export function EmptyState({ title, children, icon = 'inbox' }: { title: string, children?: ReactNode, icon?: 'inbox' | 'flow' }) {
  return (
    <div className="rwf-empty" data-rdfoe-empty="">
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {icon === 'inbox'
          ? <><path d="M3 13l3-8h12l3 8v6H3z" /><path d="M3 13h5l1 2h6l1-2h5" /></>
          : <><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /><path d="M7 12h3 M14 12h3" /></>}
      </svg>
      <div className="title">{title}</div>
      {children && <div className="rwf-muted">{children}</div>}
    </div>
  )
}

export function InboxList({ items, grouped, actions, embedded }: { items: InboxItem[], grouped: boolean, actions: InboxActions, embedded?: boolean }) {
  const [status, setStatus] = useState<StatusFilter>('open')
  const [kind, setKind] = useState<KindFilter>('all')
  const [blockingOnly, setBlockingOnly] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [answered, setAnswered] = useState<Set<string>>(new Set())
  const [leaving, setLeaving] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<{ text: string, key: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)

  // Items answered here disappear from 待处理 at once; the stream confirms shortly after.
  useEffect(() => {
    setAnswered(prev => new Set([...prev].filter(id => items.find(i => i.id === id)?.status === 'OPEN')))
  }, [items])

  const visible = useMemo(() => items
    .filter(i => status === 'all' || (status === 'open' ? i.status === 'OPEN' && !answered.has(i.id) : i.status !== 'OPEN' || answered.has(i.id)))
    .filter(i => kind === 'all' || i.kind === kind)
    .filter(i => !blockingOnly || i.blocking)
    .sort((a, b) => Number(b.blocking && b.status === 'OPEN') - Number(a.blocking && a.status === 'OPEN') || b.createdAt.localeCompare(a.createdAt)), [items, status, kind, blockingOnly, answered])

  const groups = useMemo(() => {
    const map = new Map<string, InboxItem[]>()
    for (const item of visible) {
      const key = grouped ? item.runId : 'all'
      map.set(key, [...(map.get(key) ?? []), item])
    }
    return [...map.entries()]
  }, [visible, grouped])
  const ordered = useMemo(() => groups.flatMap(([, g]) => g), [groups])

  const selected = ordered.find(i => i.id === selectedId) ?? ordered[0] ?? null
  const openCount = items.filter(i => i.status === 'OPEN' && !answered.has(i.id)).length

  const done: Done = useCallback((text, id) => {
    setToast({ text, key: Date.now() })
    // Fade the row out, then drop it and move on to the next open item.
    setLeaving(prev => new Set(prev).add(id))
    const index = ordered.findIndex(i => i.id === id)
    const next = ordered.slice(index + 1).find(i => i.status === 'OPEN') ?? ordered.slice(0, index).reverse().find(i => i.status === 'OPEN')
    setTimeout(() => {
      setAnswered(prev => new Set(prev).add(id))
      setLeaving(prev => { const s = new Set(prev); s.delete(id); return s })
      setSelectedId(next && next.id !== id ? next.id : null)
      listRef.current?.focus()
    }, 320)
  }, [ordered])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(timer)
  }, [toast])

  const move = (delta: number) => {
    if (ordered.length === 0) return
    const index = Math.max(0, ordered.findIndex(i => i.id === selected?.id))
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, index + delta))]!
    setSelectedId(next.id)
    listRef.current?.querySelector(`[data-rdfoe-item="${next.id}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      // Enter / ⌘Enter submit the primary action; when it still needs input, jump to the first field.
      e.preventDefault()
      const primary = detailRef.current?.querySelector<HTMLButtonElement>('[data-primary]:not(:disabled)')
      if (primary) primary.click()
      else detailRef.current?.querySelector<HTMLElement>('textarea, input[type=text], input:not([type])')?.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); move(-1) }
    else if (e.key === 'Tab' && !e.shiftKey) {
      const field = detailRef.current?.querySelector<HTMLElement>('textarea, input[type=text], input:not([type])')
      if (field) { e.preventDefault(); field.focus() }
    } else if (/^[1-9]$/.test(e.key)) {
      const options = detailRef.current?.querySelectorAll<HTMLInputElement>('[data-rdfoe-question]:first-of-type input[type=radio], [data-rdfoe-question]:first-of-type input[type=checkbox]')
      options?.[Number(e.key) - 1]?.click()
    }
  }

  const onDetailKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      detailRef.current?.querySelector<HTMLButtonElement>('[data-primary]:not(:disabled)')?.click()
    } else if (e.key === 'Escape') {
      listRef.current?.focus()
    }
  }

  return (
    <div className={`rwf-inbox${embedded ? ' embedded' : ''}`} data-rdfoe-inbox-list="">
      <div className="rwf-inbox-list" ref={listRef} tabIndex={0} onKeyDown={onListKey} role="listbox" aria-label="收件箱条目">
        <div className="rwf-filters">
          <div className="rwf-seg">
            {(['open', 'all', 'done'] as const).map(s => (
              <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>
                {s === 'open' ? <>待处理{openCount > 0 && <span className="rwf-count">{openCount}</span>}</> : s === 'all' ? '全部' : '已处理'}
              </button>
            ))}
          </div>
          <select className="rwf-select" value={kind} onChange={e => setKind(e.target.value as KindFilter)} aria-label="类型">
            <option value="all">全部类型</option>
            {(Object.keys(KIND_LABEL) as InboxItem['kind'][]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          <label className="rwf-check"><input type="checkbox" checked={blockingOnly} onChange={e => setBlockingOnly(e.target.checked)} />只看阻塞</label>
        </div>
        {visible.length === 0 && (
          <EmptyState title={status === 'open' ? '没有待处理的事项' : '没有条目'}>
            {status === 'open' ? '子代理提问、发消息，或到了审核环节时，会出现在这里。' : '换个筛选条件看看。'}
          </EmptyState>
        )}
        {groups.map(([key, groupItems]) => {
          const head = groupItems[0]!
          return (
            <div key={key} className="rwf-group-block">
              {grouped && (
                <div className="rwf-group" data-rdfoe-group={key}>
                  <span className="name">{head.sessionTitle ?? head.runTitle ?? key}</span>
                  <span className="rwf-group-progress">
                    <span className="bar"><span style={{ width: `${Math.round(head.doneCount / (head.nodeCount || 7) * 100)}%` }} /></span>
                    <span className="rwf-muted">{head.doneCount}/{head.nodeCount || 7} · {head.runStatus === 'RUNNING' && head.currentNode ? `${NODE_LABEL[head.currentNode] ?? head.currentNode}${head.loopRound > 0 && (head.currentNode === 'X1' || head.currentNode === 'X2') ? `第 ${head.loopRound} 轮` : ''}` : RUN_STATUS_LABEL[head.runStatus] ?? head.runStatus}</span>
                  </span>
                </div>
              )}
              {groupItems.map(item => {
                const open = item.status === 'OPEN' && !answered.has(item.id)
                return (
                  <div
                    key={item.id}
                    className={`rwf-item${open ? '' : ' closed'}${leaving.has(item.id) ? ' leaving' : ''}`}
                    role="option"
                    aria-selected={selected?.id === item.id}
                    data-rdfoe-item={item.id}
                    data-kind={item.kind}
                    data-status={item.status}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <KindIcon kind={item.kind} />
                    <div className="body">
                      <div className="line1">
                        <span className="kind">{KIND_LABEL[item.kind]}</span>
                        {open && item.blocking && <span className="rwf-blocking">阻塞</span>}
                        <span className="rwf-muted who">{who(item)}</span>
                        <span className="rwf-muted time">{relativeTime(item.createdAt)}</span>
                      </div>
                      <div className="txt">{preview(item)}</div>
                    </div>
                    {!open && <span className="rwf-done-mark" aria-label="已处理">✓</span>}
                  </div>
                )
              })}
            </div>
          )
        })}
        <div className="rwf-keys">j/k 或 ↑↓ 切换 · 1–9 选选项 · Tab 去输入 · Enter / ⌘Enter 提交</div>
      </div>
      <div className="rwf-inbox-detail" ref={detailRef} onKeyDown={onDetailKey}>
        {selected
          ? <ItemDetail key={selected.id} item={selected} actions={actions} done={done} answered={answered.has(selected.id)} />
          : <EmptyState title="选择一个条目">左侧选择条目查看详情并处理。</EmptyState>}
        {toast && <div key={toast.key} className="rwf-toast" role="status" data-rdfoe-toast="">{toast.text}</div>}
      </div>
    </div>
  )
}

// ── detail ──────────────────────────────────────────────────────────────────

function useAction(item: InboxItem, done: Done) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (body: Record<string, unknown>, message: string) => {
    setBusy(String(body.action))
    setError(null)
    try {
      await postJson('/inbox/respond', { id: item.id, ...body })
      done(message, item.id)
    } catch (e) {
      setError(String((e as Error).message))
    } finally {
      setBusy(null)
    }
  }
  return { busy, error, run }
}

export function ItemDetail({ item, actions, done, answered, compact }: { item: InboxItem, actions: InboxActions, done: Done, answered: boolean, compact?: boolean }) {
  const open = item.status === 'OPEN' && !answered
  return (
    <div
      className="rwf-item-detail"
      data-rdfoe-detail={item.id}
      data-kind={item.kind}
      onKeyDown={compact ? (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          ;(e.currentTarget.querySelector('[data-primary]:not(:disabled)') as HTMLButtonElement | null)?.click()
        }
      } : undefined}
    >
      <div className="rwf-detail-source">
        <KindIcon kind={item.kind} />
        <span className="kind">{KIND_LABEL[item.kind]}</span>
        {item.blocking && open && <span className="rwf-blocking">阻塞</span>}
        <span className="rwf-muted">{who(item)} · {item.runId}{item.round > 0 ? ` · 第 ${item.round} 轮` : ''} · {relativeTime(item.createdAt)}</span>
        <span className="rwf-spacer" />
        {!open && <Tag tone={item.status === 'CANCELLED' ? 'danger' : 'success'}>{item.status === 'CANCELLED' ? '已取消' : '已处理'}</Tag>}
      </div>
      {item.kind === 'question' && <QuestionDetail item={item} open={open} done={done} />}
      {item.kind === 'message' && <MessageDetail item={item} open={open} done={done} />}
      {item.kind === 'review' && <ReviewDetail item={item} open={open} done={done} />}
      {item.kind === 'loop_stall' && <StallDetail item={item} open={open} done={done} />}
      {!compact && <div className="rwf-detail-foot">
        <span className="rwf-muted">来源：会话「{item.sessionTitle ?? item.sessionId}」</span>
        <span className="rwf-spacer" />
        <Button size="sm" variant="ghost" onClick={() => actions.openSessionWorkflow(item.sessionId)} data-rdfoe-open-session="">打开会话</Button>
        {item.agentSessionId && <Button size="sm" variant="ghost" onClick={() => actions.openAgentAside(item.sessionId, item.agentSessionId!)} data-rdfoe-open-agent="">看子代理</Button>}
      </div>}
    </div>
  )
}

interface Question { id?: string, header?: string, question: string, detail?: string, options?: { label: string, description?: string }[], multiSelect?: boolean }

function QuestionDetail({ item, open, done }: { item: InboxItem, open: boolean, done: Done }) {
  const questions: Question[] = item.payload?.questions ?? []
  const [answers, setAnswers] = useState<Record<string, { selected: string[], text: string }>>({})
  const { busy, error, run } = useAction(item, done)
  const set = (key: string, patch: Partial<{ selected: string[], text: string }>) => setAnswers(a => ({ ...a, [key]: { ...(a[key] ?? { selected: [], text: '' }), ...patch } }))
  const complete = questions.every((q, i) => { const a = answers[q.id ?? String(i)]; return a && (a.selected.length > 0 || a.text.trim() !== '') })
  return (
    <div className="rwf-question">
      {!item.blocking && <div className="rwf-callout info">非阻塞问题：子代理已按自己的假设继续，答复会在它下一次调用工具时送达。</div>}
      {questions.map((q, i) => {
        const key = q.id ?? String(i)
        const a = answers[key] ?? { selected: [], text: '' }
        const previous = item.response?.answers?.[key]
        return (
          <fieldset key={key} className="rwf-q" data-rdfoe-question={key} disabled={!open}>
            {q.header && <div className="rwf-q-header">{q.header}</div>}
            <div className="rwf-q-title">{q.question}</div>
            {q.detail && <div className="rwf-sub">{q.detail}</div>}
            <div className="rwf-options">
              {(q.options ?? []).map((o, n) => {
                const checked = open ? a.selected.includes(o.label) : (previous?.selected ?? []).includes(o.label)
                return (
                  <label key={o.label} className={`rwf-option${checked ? ' on' : ''}`}>
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      name={`${item.id}-${key}`}
                      checked={checked}
                      onChange={e => set(key, { selected: q.multiSelect ? (e.target.checked ? [...a.selected, o.label] : a.selected.filter(s => s !== o.label)) : [o.label] })}
                    />
                    {i === 0 && n < 9 && <kbd>{n + 1}</kbd>}
                    <span><span className="opt-label">{o.label}</span>{o.description && <span className="rwf-muted"> — {o.description}</span>}</span>
                  </label>
                )
              })}
            </div>
            {open
              ? <input className="rwf-input wide" placeholder={(q.options ?? []).length ? '补充说明或其他答案（可选）' : '输入你的回答'} value={a.text} onChange={e => set(key, { text: e.target.value })} />
              : previous?.text && <div className="rwf-answer">回答：{previous.text}</div>}
          </fieldset>
        )
      })}
      {!open && item.response?.skippedAll && <div className="rwf-answer">已跳过，由子代理自行决定。</div>}
      {open && (
        <div className="rwf-actions">
          <Button variant="primary" size="sm" data-primary="" disabled={busy !== null || !complete} data-rdfoe-action="answer" onClick={() => run({ action: 'answer', answers }, '已提交回答，子代理继续工作')}>{busy === 'answer' ? '提交中…' : '提交回答'}</Button>
          <Button variant="outline" size="sm" disabled={busy !== null} data-rdfoe-action="skip" onClick={() => run({ action: 'skip' }, '已跳过，由子代理自行决定')}>跳过（由你决定）</Button>
        </div>
      )}
      {error && <div className="rwf-callout err">{error}</div>}
    </div>
  )
}

function MessageDetail({ item, open, done }: { item: InboxItem, open: boolean, done: Done }) {
  const [text, setText] = useState('')
  const { busy, error, run } = useAction(item, done)
  const p = item.payload ?? {}
  const level = p.level === 'risk' ? { tone: 'danger' as const, label: '风险' } : p.level === 'decision' ? { tone: 'info' as const, label: '决定' } : null
  return (
    <div className="rwf-message">
      <div className="rwf-bubble">
        {level && <Tag tone={level.tone}>{level.label}</Tag>}
        <Markdown text={String(p.text ?? '')} compact />
        {p.expectReply && open && <div className="rwf-muted small">子代理希望得到回复。</div>}
      </div>
      {!open && item.response?.text && (
        <div className="rwf-bubble mine">{item.response.text}<div className="rwf-muted small">{item.deliveredAt ? `已送达子代理（${relativeTime(item.deliveredAt)}）` : item.agentAlive ? '待送达：会随子代理下一次工具调用一起交给它。' : '子代理已结束，这条回复会带到该节点下次运行。'}</div></div>
      )}
      {open && (
        <>
          <textarea className="rwf-textarea" placeholder="回复子代理（可选）" value={text} onChange={e => setText(e.target.value)} />
          <div className="rwf-actions">
            <Button variant="primary" size="sm" data-primary="" disabled={busy !== null || !text.trim()} data-rdfoe-action="reply" onClick={() => run({ action: 'reply', text }, '回复已发送')}>{busy === 'reply' ? '发送中…' : '回复'}</Button>
            <Button variant="outline" size="sm" disabled={busy !== null} data-rdfoe-action="read" onClick={() => run({ action: 'read' }, '已标记为已读')}>标为已读</Button>
          </div>
        </>
      )}
      {error && <div className="rwf-callout err">{error}</div>}
    </div>
  )
}

interface Subject { node: string, label: string, version: number, artifacts: string[], summary: string, openIssues: string[], confidence?: number, verdict?: string, items?: { id: string, result: string, evidence: string }[], previousVersion?: number }

function ReviewDetail({ item, open, done }: { item: InboxItem, open: boolean, done: Done }) {
  const p = item.payload ?? {}
  const subjects: Subject[] = p.subjects ?? []
  const pre = p.aiPreReview
  const docs = [
    ...subjects.flatMap(s => s.artifacts.filter(a => a.startsWith('.rdfoe/') && !a.endsWith('.json')).map(a => ({ label: s.label, path: a }))),
    // Legacy items: the pre-review's own files.
    ...(pre?.artifacts ?? []).filter((a: string) => !subjects.some(s => s.artifacts.includes(a))).map((a: string) => ({ label: 'AI 设计审查', path: a })),
  ]
  const [artifact, setArtifact] = useState<string | null>(docs[0]?.path ?? null)
  const [comment, setComment] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [rollbackTo, setRollbackTo] = useState<string>(p.rollbackTargets?.[0] ?? '')
  const [diff, setDiff] = useState<{ diff: string, log: string[] } | null>(null)
  const { busy, error, run } = useAction(item, done)
  useEffect(() => {
    if (p.gate !== 'H3' && p.gate !== 'R3') return
    getJson<{ diff: string, log: string[] }>(`/diff?runId=${encodeURIComponent(item.runId)}`).then(setDiff, () => setDiff(null))
  }, [p.gate, item.runId])
  return (
    <div className="rwf-review">
      <h4 className="rwf-review-title">{p.label}</h4>
      {p.acceptanceGuide && (
        <div className="rwf-card rwf-guide" data-rdfoe-acceptance-guide={p.acceptanceGuide}>
          <div className="rwf-row"><b>用户成果验收指引</b><span className="rwf-muted small">智能体自测已通过；请按这份指引体验成果，判断是否满足你的需要。不满意就打回到「实施」，写明哪里不符合。</span></div>
          <ArtifactDoc runId={item.runId} path={p.acceptanceGuide} />
        </div>
      )}
      {subjects.map(s => (
        <div key={s.node} className="rwf-card" data-rdfoe-subject={s.node}>
          <div className="rwf-row">
            <b>{s.label} v{s.version}</b>
            {s.verdict && <Tag tone={s.verdict === 'pass' ? 'success' : 'danger'}>验收{s.verdict === 'pass' ? '通过' : '未通过'}</Tag>}
            {s.confidence !== undefined && s.confidence < 0.7 && <Tag tone="warning">低置信 {Math.round(s.confidence * 100)}%</Tag>}
            {s.previousVersion && <span className="rwf-muted small">上一版 v{s.previousVersion}（可在节点详情里对比）</span>}
          </div>
          <div className="rwf-summary-text">{s.summary}</div>
          {s.openIssues.length > 0 && <div className="rwf-callout warn"><b>需关注</b><ul>{s.openIssues.map(o => <li key={o}>{o}</li>)}</ul></div>}
          {s.items && (
            <table className="rwf-table"><tbody>
              {s.items.map(i => <tr key={i.id}><td>{i.id}</td><td><Tag tone={i.result === 'pass' ? 'success' : 'danger'}>{i.result === 'pass' ? '通过' : '未通过'}</Tag></td><td className="rwf-evidence">{i.evidence}</td></tr>)}
            </tbody></table>
          )}
        </div>
      ))}
      {docs.length > 0 && (
        <div className="rwf-toolbar">
          {docs.map(d => <button key={d.path} type="button" className="rwf-chip" aria-pressed={artifact === d.path} onClick={() => setArtifact(d.path)}>{d.label} · {d.path.split('/').at(-1)}</button>)}
        </div>
      )}
      {artifact && <ArtifactDoc runId={item.runId} path={artifact} />}
      {(p.gate === 'H3' || p.gate === 'R3') && diff && (
        <details className="rwf-card"><summary>代码变更 · {diff.log.length} 个提交（run 分支相对发起时的 HEAD）</summary><pre className="rwf-pre">{diff.log.join('\n')}{'\n\n'}{diff.diff || '（没有代码变更）'}</pre></details>
      )}
      {p.loop && p.loop.length > 0 && (
        <div className="rwf-loop-mini">实施⇄验证：{p.loop.map((l: { round: number, failed: number, total: number }) => <span key={l.round} className={l.failed === 0 ? 'ok' : 'bad'}>第{l.round}轮 {l.failed}/{l.total}</span>)}</div>
      )}
      {pre && (
        <div className="rwf-card rwf-prereview" data-rdfoe-prereview={pre.status}>
          <div className="rwf-row"><b>{pre.kind === 'design' ? 'AI 设计审查' : 'AI 预审'}</b><Tag tone="quiet">仅供参考，不影响流程</Tag>
            {pre.status === 'running' && <span className="rwf-muted small"><span className="rwf-spinner" /> 生成中…</span>}
            {pre.status === 'failed' && <span className="rwf-error small">预审失败：{pre.error}</span>}</div>
          {pre.status === 'running' && <Skeleton lines={2} />}
          {pre.summary && <div className="rwf-summary-text">{pre.summary}</div>}
          {pre.openIssues?.length > 0 && <ul>{pre.openIssues.map((o: string) => <li key={o}>{o}</li>)}</ul>}
        </div>
      )}
      {!open && item.response && (
        <div className={`rwf-callout ${item.response.action === 'approve' ? 'ok' : 'warn'}`}>
          {item.response.action === 'approve' ? '已通过' : `已打回到「${NODE_LABEL[item.response.rollbackTo] ?? item.response.rollbackTo}」：${item.response.comment}`}
        </div>
      )}
      {open && (
        <div className="rwf-decision">
          {!rejecting
            ? (
              <div className="rwf-actions">
                <Button variant="primary" size="sm" data-primary="" disabled={busy !== null} data-rdfoe-action="approve" onClick={() => run({ action: 'approve' }, `已通过 ${p.label}`)}>{busy === 'approve' ? '提交中…' : '通过'}</Button>
                <Button variant="outline" size="sm" disabled={busy !== null} data-rdfoe-action="start-reject" onClick={() => setRejecting(true)}>打回…</Button>
                <span className="rwf-muted small">审核只能由你拍板；打回后回退节点及其下游重做，版本号 +1。</span>
              </div>
            )
            : (
              <div className="rwf-reject">
                <textarea className="rwf-textarea" autoFocus placeholder="打回意见（必填）：哪里不对、希望怎么改" value={comment} onChange={e => setComment(e.target.value)} data-rdfoe-comment="" />
                <div className="rwf-actions">
                  <label className="rwf-row rwf-sub">回退到
                    <select className="rwf-select" value={rollbackTo} onChange={e => setRollbackTo(e.target.value)} data-rdfoe-rollback="">
                      {(p.rollbackTargets ?? []).map((t: string) => <option key={t} value={t}>{NODE_LABEL[t] ?? t}</option>)}
                    </select>
                  </label>
                  <span className="rwf-spacer" />
                  <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>取消</Button>
                  <Button variant="primary" size="sm" data-primary="" disabled={busy !== null || !comment.trim()} data-rdfoe-action="reject"
                    onClick={() => run({ action: 'reject', comment, rollbackTo }, `已打回到「${NODE_LABEL[rollbackTo] ?? rollbackTo}」`)}>{busy === 'reject' ? '提交中…' : '确认打回'}</Button>
                </div>
              </div>
            )}
        </div>
      )}
      {error && <div className="rwf-callout err">{error}</div>}
    </div>
  )
}

function StallDetail({ item, open, done }: { item: InboxItem, open: boolean, done: Done }) {
  const p = item.payload ?? {}
  const { busy, error, run } = useAction(item, done)
  const design = p.loop === 'design'
  const trend: { round: number, failed: number, total: number, failedIds: string[] }[] = p.trend ?? []
  const max = Math.max(1, ...trend.map(t => t.total))
  return (
    <div className="rwf-stall">
      <div className="rwf-callout warn"><span><b>{design ? '设计⇄审查' : '实施⇄验证'}循环已暂停：</b>{p.reason}</span></div>
      <div className="rwf-trend">
        {trend.map(t => (
          <div key={t.round} className="rwf-trend-row">
            <span className="r">{design ? `审查 ${t.round}` : `第 ${t.round} 轮`}</span>
            <span className="bar"><span className="fail" style={{ width: `${(t.failed / max) * 100}%` }} /></span>
            <span className="n">{t.failed}/{t.total} 失败</span>
            <span className="rwf-muted ids">{t.failedIds.join('、')}</span>
          </div>
        ))}
      </div>
      {open
        ? (
          <div className="rwf-actions">
            <Button variant="primary" size="sm" data-primary="" disabled={busy !== null} data-rdfoe-action="continue" onClick={() => run({ action: 'continue' }, '已继续循环')}>{design ? '再改一轮设计' : '继续循环'}</Button>
            {design
              ? <Button variant="outline" size="sm" disabled={busy !== null} data-rdfoe-action="to_review" onClick={() => run({ action: 'to_review' }, '已交给你审核设计')}>带着阻断交给我审核</Button>
              : <Button variant="outline" size="sm" disabled={busy !== null} data-rdfoe-action="back_to_plan" onClick={() => run({ action: 'back_to_plan' }, '已回到任务规划重做')}>回到任务规划</Button>}
            <Button variant="outline" size="sm" disabled={busy !== null} data-rdfoe-action="terminate" onClick={() => { if (confirm('终止这条工作流？')) void run({ action: 'terminate' }, '工作流已终止') }}>终止</Button>
          </div>
        )
        : item.response?.action && <div className="rwf-callout ok">已选择：{({ continue: design ? '再改一轮设计' : '继续循环', back_to_plan: '回到任务规划', to_review: '交给用户审核', terminate: '终止' } as Record<string, string>)[item.response.action]}</div>}
      {error && <div className="rwf-callout err">{error}</div>}
    </div>
  )
}

// ── global panel + sidebar icon ─────────────────────────────────────────────

export function InboxPanel(props: InboxActions) {
  const { data, status } = useStream<InboxSnapshot & { type: string }>('/inbox/events?status=all', 'inbox')
  return (
    <div className="rwf rwf-panel" data-rdfoe-inbox="">
      <div className="rwf-panel-head">
        <h3>收件箱</h3>
        {data && <span className="rwf-muted">{data.openCount > 0 ? `待处理 ${data.openCount} · 其中阻塞 ${data.blockingCount}` : '全部处理完了'}</span>}
        <span className="rwf-spacer" />
        <span className={`rwf-live ${status === 'live' ? 'on' : ''}`}>{status === 'live' ? '实时' : '连接中…'}</span>
      </div>
      <div className="rwf-panel-body">
        {data ? <InboxList items={data.items} grouped actions={props} /> : <div style={{ padding: 20 }}><Skeleton lines={8} /></div>}
      </div>
    </div>
  )
}

/** Open-item count shared by every badge on the page (one stream). */
export function useInboxOpenCount(): { count: number, blocking: number } {
  const data = useSharedStream<InboxSnapshot & { type: string }>('/inbox/events?status=open', 'inbox')
  return { count: data?.openCount ?? 0, blocking: data?.blockingCount ?? 0 }
}

export function InboxGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" aria-hidden="true">
      <path d="M3 13l3-8h12l3 8v6H3z" /><path d="M3 13h5l1 2h6l1-2h5" />
    </svg>
  )
}

export function InboxBadge({ count, blocking }: { count: number, blocking: number }) {
  if (count === 0) return null
  return <span className={`rwf-badge${blocking > 0 ? '' : ' soft'}`} data-rdfoe-inbox-badge={count}>{count > 99 ? '99+' : count}</span>
}

export function InboxIcon({ size }: { size: number, active: boolean }) {
  const { count, blocking } = useInboxOpenCount()
  return (
    <span className="rwf rwf-inbox-icon" style={{ width: size, height: size }} data-rdfoe-inbox-icon="">
      <InboxGlyph size={size} />
      <InboxBadge count={count} blocking={blocking} />
    </span>
  )
}
