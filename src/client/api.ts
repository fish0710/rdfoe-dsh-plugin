/** Browser-side client for `/api/rdfoe-wf/*`. Relative URLs ride the page's Connection authentication. */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

export const API = '/api/rdfoe-wf'

export interface RunRow {
  id: string
  session_id: string
  project_path: string
  worktree_path: string
  branch: string | null
  base_ref: string | null
  is_git: number
  title: string
  requirement_text: string
  status: string
  current_node: string | null
  loop_round: number
  /** full | small (the Host normalises legacy rows to full). */
  template?: string
  created_at: string
}
export interface NodeRow { id: string, node_key: string, kind: 'ai' | 'review', status: string, attempt: number, current_version: number, final_version: number | null, agent_session_id: string | null, error: string | null, started_at: string | null, ended_at: string | null }
export interface AgentRow { id: string, node_id: string, version: number, role: string, agent_session_id: string | null, model: string | null, status: string, error: string | null, started_at: string, ended_at: string | null }
export interface VersionRow { node_key: string, node_id: string, version: number, round: number, origin: string, artifacts_json: string, summary: string, structured_json: string, commit_sha: string | null, created_at: string }
export interface ReviewRow { node_key: string, target_version: number, decision: string, comment: string, rollback_to: string | null, created_at: string }
export interface EventRow { id: number, node_id: string | null, type: string, before: string | null, after: string | null, payload_json: string | null, ts: string }
export interface ToolCallRow { id: number, node_id: string | null, agent_session_id: string | null, tool: string, args_digest: string, affected_paths: string | null, exit_code: number | null, duration_ms: number, ts: string }
export interface LoopRow { round: number, failed: number, total: number, failedIds: string[] }

export interface InboxItem {
  id: string
  kind: 'question' | 'message' | 'review' | 'loop_stall'
  blocking: boolean
  status: 'OPEN' | 'RESOLVED' | 'CANCELLED'
  payload: any
  response: any
  createdAt: string
  resolvedAt: string | null
  deliveredAt: string | null
  round: number
  runId: string
  runTitle: string
  runStatus: string
  currentNode: string | null
  loopRound: number
  doneCount: number
  nodeCount?: number
  template?: string
  sessionId: string
  sessionTitle: string | null
  nodeKey: string | null
  nodeLabel: string | null
  agentSessionId: string | null
  agentRole: string | null
  agentAlive: boolean
}

export interface RunSnapshot {
  run: RunRow | null
  nodeOf?: { runId: string, mainSessionId: string, nodeKey?: string, role: string, version: number }
  nodes?: NodeRow[]
  versions?: VersionRow[]
  agents?: AgentRow[]
  reviews?: ReviewRow[]
  inbox?: InboxItem[]
  loop?: LoopRow[]
  events?: EventRow[]
  toolCalls?: ToolCallRow[]
  pending?: number
}

export interface InboxSnapshot { openCount: number, blockingCount: number, items: InboxItem[] }

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`)
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

export async function postJson<T = { ok: boolean }>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const value = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
  return value
}

export async function getText(path: string): Promise<string> {
  const response = await fetch(`${API}${path}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

/**
 * Follow one NDJSON route, reconnecting after drops; returns the latest
 * message of `type`. This plugin has no DSH store, so the stream lives in
 * component-local state.
 */
export function useStream<T>(path: string | null, type: string): { data: T | null, status: string } {
  const [data, setData] = useState<T | null>(null)
  const [status, setStatus] = useState('idle')
  useEffect(() => {
    if (path === null) return
    setData(null)
    const controller = new AbortController()
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          setStatus('connecting')
          const response = await fetch(`${API}${path}`, { signal: controller.signal })
          if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
          setStatus('live')
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
          let buffer = ''
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += value
            let newline: number
            while ((newline = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, newline)
              buffer = buffer.slice(newline + 1)
              if (line.trim() === '') continue
              const message = JSON.parse(line) as { type: string }
              if (message.type === type) setData(message as T)
            }
          }
        } catch {
          if (controller.signal.aborted) return
          setStatus('reconnecting')
        }
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
    })()
    return () => controller.abort()
  }, [path, type])
  return { data, status }
}

interface SharedStream { data: unknown, listeners: Set<() => void>, controller: AbortController }
const sharedStreams = new Map<string, SharedStream>()

function openShared(key: string, path: string, type: string): SharedStream {
  const entry = sharedStreams.get(key)
  if (entry !== undefined) return entry
  const stream: SharedStream = { data: null, listeners: new Set(), controller: new AbortController() }
  sharedStreams.set(key, stream)
  const { signal } = stream.controller
  void (async () => {
    while (!signal.aborted) {
      try {
        const response = await fetch(`${API}${path}`, { signal })
        if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += value
          let newline: number
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            if (line.trim() === '') continue
            const message = JSON.parse(line) as { type: string }
            if (message.type !== type) continue
            stream.data = message
            for (const listener of stream.listeners) listener()
          }
        }
      } catch {
        if (signal.aborted) return
      }
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
  })()
  return stream
}

/**
 * useStream for small badges shown in several places at once (sidebar icon,
 * aside toolbar): one connection per route however many components read it,
 * closed when the last one unmounts. Browsers cap HTTP/1.1 connections per
 * host at six, and every useStream holds one open.
 */
export function useSharedStream<T>(path: string, type: string): T | null {
  const key = `${type} ${path}`
  const subscribe = useCallback((listener: () => void) => {
    const stream = openShared(key, path, type)
    stream.listeners.add(listener)
    return () => {
      stream.listeners.delete(listener)
      if (stream.listeners.size > 0) return
      stream.controller.abort()
      sharedStreams.delete(key)
    }
  }, [key, path, type])
  return useSyncExternalStore(subscribe, () => (sharedStreams.get(key)?.data ?? null) as T | null)
}

/** Chinese labels for every status enum the UI shows (never render the raw value). */
export const STATUS_LABEL: Record<string, string> = {
  PENDING: '待开始', RUNNING: '运行中', WAITING_ANSWER: '等你回答', SUCCEEDED: '已完成', FAILED: '失败', BLOCKED: '已阻断', INTERRUPTED: '已中断',
  STALE: '已过期', CANCELLED: '已取消', AWAITING_REVIEW: '待审核', APPROVED: '已通过', REJECTED: '已打回',
  CREATED: '已创建', PAUSED: '已暂停', COMPLETED: '已完成', ORPHANED: '只读', OPEN: '待处理', RESOLVED: '已处理',
}
export const statusLabel = (status: string | null | undefined): string => (status ? STATUS_LABEL[status] ?? status : '')

/** Node labels (Host workflow/template.ts). Current keys first: parseCommandRun maps a label back to the first key that has it. */
export const NODE_LABEL: Record<string, string> = {
  R: '需求录入', C: '需求澄清', D: '设计', DR: '设计审查', H1: '设计批准', T: '任务规划', V: '验证计划', H2: '授权实施',
  X: '实施', Y: '验证', H3: '用户验收', A: '归档', S: '小改动',
  R1: '设计审核', P: '计划生成', R2: '计划审核', X1: '实施（旧）', X2: '验收（旧）', R3: '结果审核',
}
export const ROLE_LABEL: Record<string, string> = {
  R: '需求录入子代理', C: '需求澄清子代理', D: '设计子代理', DR: '设计审查子代理', T: '任务规划子代理', V: '验证计划子代理',
  X: '实施子代理', Y: '验证子代理', A: '归档子代理', S: '小改动子代理',
  P_impl: '实施计划子代理', P_accept: '验收计划子代理', X1: '实施子代理', X2: '验收子代理', prereview: 'AI 预审', system: '工作流',
}

export type TemplateKind = 'full' | 'small' | 'legacy'
/** Node order and loops per template (Host workflow/template.ts). */
export const TEMPLATE_ORDER: Record<TemplateKind, readonly string[]> = {
  full: ['R', 'C', 'D', 'DR', 'H1', 'T', 'V', 'H2', 'X', 'Y', 'H3', 'A'],
  small: ['S', 'H2', 'X', 'Y', 'H3', 'A'],
  legacy: ['D', 'R1', 'P', 'R2', 'X1', 'X2', 'R3'],
}
export const TEMPLATE_LOOPS: Record<TemplateKind, readonly { fix: string, check: string }[]> = {
  full: [{ fix: 'D', check: 'DR' }, { fix: 'X', check: 'Y' }],
  small: [{ fix: 'X', check: 'Y' }],
  legacy: [{ fix: 'X1', check: 'X2' }],
}
export const TEMPLATE_LABEL: Record<TemplateKind, string> = { full: '完整流程', small: '小改动', legacy: '旧版流程（只读）' }
export const templateId = (value: string | null | undefined): TemplateKind => (value === 'full' || value === 'small' ? value : 'legacy')
export const orderOf = (template: string | null | undefined): readonly string[] => TEMPLATE_ORDER[templateId(template)]
/** The AI node a gate reviews first (its default rollback target) per template. */
export function gateSubject(template: string | null | undefined, key: string): string | undefined {
  const t = templateId(template)
  if (t === 'legacy') return ({ R1: 'D', R2: 'P', R3: 'X1' } as Record<string, string>)[key]
  return ({ H1: 'D', H2: t === 'small' ? 'S' : 'T', H3: 'X' } as Record<string, string>)[key]
}
export const isGateKey = (key: string): boolean => ['H1', 'H2', 'H3', 'R1', 'R2', 'R3'].includes(key)
/** Implementation / verification nodes (current and legacy keys). */
export const isImplKey = (key: string): boolean => key === 'X' || key === 'X1'
export const isCheckKey = (key: string): boolean => key === 'Y' || key === 'X2' || key === 'DR'

export const KIND_LABEL: Record<InboxItem['kind'], string> = { question: '问题', message: '消息', review: '审核', loop_stall: '防空转' }
export const RUN_STATUS_LABEL: Record<string, string> = { CREATED: '已创建', RUNNING: '运行中', PAUSED: '已暂停', INTERRUPTED: '已中断', COMPLETED: '已完成', FAILED: '失败', CANCELLED: '已取消', ORPHANED: '只读' }

/** First line of a `/rdfoe-workflow` result (Host session-command.ts): `<verb>工作流 WF-… · <status>[ · 当前节点 <label>] · …`. */
const COMMAND_RUN_LINE = /^(已开启|已恢复|本会话的)工作流 (WF-[A-Z0-9]+) · ([^·\n]+?)(?: · 当前节点 ([^·\n]+?))?(?: · |$)/u

export function parseCommandRun(text: string | undefined): { verb: string, runId: string, status: string, node: string | null, template: TemplateKind, facts: string } | null {
  const first = (text ?? '').split('\n')[0]!
  const match = COMMAND_RUN_LINE.exec(first)
  if (match === null) return null
  const node = Object.entries(NODE_LABEL).find(([, label]) => label === match[4])?.[0] ?? null
  const template: TemplateKind = / · 流程 小改动(?: · |$)/u.test(first) ? 'small' : / · 流程 旧版(?: · |$)/u.test(first) ? 'legacy' : 'full'
  return { verb: match[1]!, runId: match[2]!, status: match[3]!, node, template, facts: first.split(' · ').slice(1).join(' · ') }
}

export function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`
  return iso.slice(0, 10)
}
