/**
 * Node input assembly (§6.1): requirement + approved upstream artifacts +
 * this node's rejection history + answered questions/replies + the failed
 * items of the last check (D after DR, X after Y) + (A) the human decisions +
 * the PH template of every file the node writes (§17). Everything here is ordinary task context for the model; no
 * hidden metadata.
 */
import { PH_TEMPLATES } from '../prompts/ph/templates.ts'
import type { InboxRow, NodeVersionRow, ReviewRow, RunRow } from '../store/store.ts'
import { NODE_LABEL, NODE_SKILL, templateOf, type NodeKey, type Role } from './template.ts'

export interface PromptInput {
  run: RunRow
  role: Role
  version: number
  round: number
  resume?: boolean
  upstream: { label: string, path: string }[]
  rejections: (ReviewRow & { node_key: string })[]
  replies: InboxRow[]
  /** D: the blocking findings of the last design review; X: the last verification's failures. */
  failedItems?: { id: string, evidence: string }[]
  extra?: string
  /** Workspace-relative files this agent must write. */
  outputs?: string[]
  /** The tasks.md that X ticks and Y appends fix tasks to. */
  tasksPath?: string
  /** Local date (YYYY-MM-DD) for dated entries; defaults to now. */
  today?: string
  /** A: every human decision of the run, oldest first. */
  reviews?: (ReviewRow & { node_key: string })[]
}

function describeReply(item: InboxRow): string {
  const payload = JSON.parse(item.payload_json) as Record<string, unknown>
  const response = JSON.parse(item.response_json ?? 'null') as Record<string, unknown> | null
  if (item.kind === 'message') return `你发过的消息「${String(payload.text ?? '')}」，用户回复：${String(response?.text ?? '')}`
  if (item.kind === 'question') return formatAnswers(payload.questions as { id?: string, question: string }[], response)
  return JSON.stringify(response)
}

export function formatAnswers(questions: { id?: string, question: string }[], response: Record<string, unknown> | null): string {
  const answers = (response?.answers ?? {}) as Record<string, { selected?: string[], text?: string, skipped?: boolean }>
  return questions.map((q, i) => {
    const key = q.id ?? String(i)
    const a = answers[key]
    const text = !a || a.skipped ? '（用户跳过：由你决定）' : [...(a.selected ?? []), ...(a.text ? [a.text] : [])].join('；') || '（空）'
    return `问：${q.question}\n答：${text}`
  }).join('\n')
}

export function buildPrompt(input: PromptInput): string {
  const { run, role, version, round } = input
  const template = templateOf(run)
  const outputs = input.outputs ?? []
  const lines: string[] = []
  lines.push(`本节点：${NODE_LABEL[role]}（${role}），第 ${version} 版，执行 PH ${NODE_SKILL[role]}。流程模板：${template.label}（${template.id}）。`)
  if (input.resume) {
    lines.push('', '## 从中断处继续', '宿主进程曾经重启，你之前的工作被中断。请检查你已经写过的文件（wf_list / wf_read），从中断处继续完成任务，最后调用 wf_report。')
  }
  lines.push('', `## 需求原文（工作流 ${run.id}${run.title ? ` · ${run.title}` : ''}）`, run.requirement_text || run.title || '（未提供）')
  lines.push('', '## 工作区', '所有路径都相对于工作区根目录。')
  // Models otherwise invent dates for 澄清记录 / archive entries.
  lines.push('', `今天是 ${input.today ?? new Date().toLocaleDateString('sv-SE')}，文档里要写日期时用它。`)
  if (outputs.length > 0) lines.push('', '## 你要写的文件', ...outputs.map(p => `- ${p}`))
  if (input.upstream.length > 0) {
    lines.push('', '## 上游产物（先用 wf_read 阅读）')
    for (const u of input.upstream) lines.push(`- ${u.label}：${u.path}`)
  }
  if (role === 'X' && input.tasksPath) lines.push('', '## 任务清单', `按 ${input.tasksPath} 执行；任务进度（勾选）和因用户验收打回追加的修复任务都记在这个文件里。`)
  if (role === 'Y') {
    lines.push('', '## 你的产出', `逐条验证后把记录写进 ${outputs[0] ?? 'verification.md'}；有失败时用 wf_edit 把修复任务追加到 ${input.tasksPath ?? 'tasks.md'} 末尾。然后调用 wf_report（verdict + items），工作流会据此生成验收报告。这两个文件之外的写入会被拒绝。`)
  }
  if (role === 'DR') lines.push('', '## 你的产出', `把审查写进 ${outputs[0] ?? 'review.md'}，然后调用 wf_report（verdict + items）。有阻断发现（verdict=fail）时工作流会自动回到设计节点。`)
  if (role === 'X' || role === 'Y') lines.push('', `当前是实施⇄验证循环第 ${round} 轮。`)
  if (input.failedItems && input.failedItems.length > 0) {
    lines.push('', role === 'D' ? '## 设计审查的阻断发现（逐条回应）' : '## 上一轮验证失败项（逐条修复）')
    for (const f of input.failedItems) lines.push(`- ${f.id}：${f.evidence}`)
  }
  if (input.rejections.length > 0) {
    lines.push('', '## 审核打回意见（逐条回应）')
    for (const r of input.rejections) lines.push(`- ${NODE_LABEL[r.node_key as NodeKey] ?? r.node_key}（${r.node_key}）打回 v${r.target_version}：${r.comment}`)
  }
  if (input.reviews && input.reviews.length > 0) {
    lines.push('', '## 审核记录（人工审核的真实决定，按时间先后）')
    for (const r of input.reviews) lines.push(`- ${r.created_at.slice(0, 16).replace('T', ' ')} ${NODE_LABEL[r.node_key as NodeKey] ?? r.node_key}（${r.node_key}）v${r.target_version}：${r.decision === 'APPROVED' ? '通过' : `打回到 ${r.rollback_to}`}${r.comment ? `，意见：${r.comment}` : ''}`)
  }
  if (input.replies.length > 0) {
    lines.push('', '## 用户的答复与回复')
    for (const r of input.replies) lines.push(`- ${describeReply(r).replace(/\n/g, '\n  ')}`)
  }
  if (input.extra) lines.push('', input.extra)
  const templates = [...new Set(outputs.map(p => p.split('/').at(-1)!))].filter(name => PH_TEMPLATES[name] !== undefined)
  if (templates.length > 0) {
    lines.push('', '## 模板参考（书写参考，不是规则）')
    for (const name of templates) lines.push('', `### ${name}`, '~~~markdown', PH_TEMPLATES[name]!.trim(), '~~~')
  }
  return lines.join('\n')
}

export function lastFailures(check: NodeVersionRow | undefined): { id: string, evidence: string }[] {
  if (!check) return []
  const structured = JSON.parse(check.structured_json) as { items?: { id: string, result: string, evidence: string }[] }
  return (structured.items ?? []).filter(i => i.result === 'fail').map(i => ({ id: i.id, evidence: i.evidence }))
}
