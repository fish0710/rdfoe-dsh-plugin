/**
 * WorkflowService: the plugin's own orchestration loop (H8, decision 5).
 *
 * - Status changes go only through Store.transition (transition tables +
 *   event row in one transaction).
 * - Each run is driven by a serialized `tick`: find the first unfinished node
 *   in template order and start it (AI node) or open its review (gate).
 * - Review gates change state only from `respond()`, i.e. a human action on
 *   the inbox route. Nothing reacting to AI output can approve (Q3).
 * - Two fix ⇄ check loops (§17): a failing DR sends the run back to D, a
 *   failing Y back to X; both stop and ask the user when they stall.
 * - Legacy runs (template `standard`, before 0.1.0-beta.4) are never driven:
 *   on startup they become ORPHANED (read-only).
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { routeFor, type Config } from '../config.ts'
import { commitAll, createWorktree, repoRoot } from '../git/git.ts'
import type { InboxBroker } from '../inbox/broker.ts'
import { personaFor } from '../prompts/personas.ts'
import type { Hub } from '../runner/hub.ts'
import type { AgentRunResult, NodeRunner } from '../runner/node-runner.ts'
import type { InboxRow, NodeAgentRow, NodeRow, RunRow, Store } from '../store/store.ts'
import type { AskQuestion, NodeReport, ToolEnv } from '../tools/node-tools.ts'
import { canApply } from './machine.ts'
import { buildPrompt, formatAnswers, lastFailures } from './prompt.ts'
import {
  NODE_KIND, NODE_LABEL, REQUIRED_ARTIFACTS, TEMPLATES,
  artifactDir, downstreamFrom, isGate, templateOf, type AiKey, type GateKey, type NodeKey, type StartTemplateId,
} from './template.ts'

export class UserError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'UserError'
  }
}

interface RunConfig {
  /** DR version up to which the user acknowledged a design-loop stall. */
  designAck?: number
}

const now = () => new Date().toISOString()
const LIVE_RUN = ['CREATED', 'RUNNING', 'PAUSED', 'INTERRUPTED', 'FAILED']

export class WorkflowService {
  /** Structured reports captured by wf_report, keyed by node_agent id. */
  private readonly reports = new Map<string, NodeReport>()
  /** node_agent id → live agent session id. */
  private readonly agentSessions = new Map<string, string>()
  private readonly messageCounts = new Map<string, number>()
  private readonly chains = new Map<string, Promise<void>>()
  /** Non-git projects: project path → run holding the implementation lock. */
  private readonly projectLocks = new Map<string, string>()
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly store: Store,
    private readonly hub: Hub,
    private readonly inbox: InboxBroker,
    private readonly runner: NodeRunner,
    private readonly worktreeRoot: string,
  ) {
    inbox.onResolved(item => this.afterResolved(item))
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * §8.3 step 1: RUNNING runs, nodes and agents become INTERRUPTED; OPEN items
   * stay. Live legacy runs become ORPHANED (read-only) and lose their items.
   */
  recoverOnStartup(): { runs: number, nodes: number, orphaned: number } {
    let runs = 0
    let nodes = 0
    let orphaned = 0
    this.store.tx(() => {
      for (const run of this.store.runsByStatus(...LIVE_RUN)) {
        if (templateOf(run).id !== 'legacy') continue
        this.store.transition({ table: 'run', id: run.id }, 'orphan', {}, { reason: 'legacy template (before 0.1.0-beta.4) is read-only' })
        for (const item of this.store.inbox({ runId: run.id, status: 'OPEN' })) this.inbox.cancel(item.id, 'legacy run is read-only')
        for (const agent of this.store.agentsOfRun(run.id).filter(a => a.status === 'RUNNING')) this.store.patchAgent(agent.id, { status: 'CANCELLED', ended_at: now() })
        orphaned++
      }
      for (const run of this.store.runsByStatus('RUNNING')) {
        this.store.transition({ table: 'run', id: run.id }, 'interrupt', {}, { reason: 'host restart' })
        runs++
      }
      for (const run of this.store.runs()) {
        if (run.status === 'ORPHANED') continue
        for (const node of this.store.nodes(run.id)) {
          if (node.status === 'RUNNING' || node.status === 'WAITING_ANSWER') {
            this.store.transition({ table: 'node', id: node.id }, 'interrupt', {}, { reason: 'host restart' })
            nodes++
          }
        }
      }
      for (const agent of this.store.agentsByStatus('RUNNING')) this.store.patchAgent(agent.id, { status: 'INTERRUPTED' })
    })
    if (this.config.run.autoResume) {
      for (const run of this.store.runsByStatus('INTERRUPTED')) void this.continueRun(run.id).catch(() => {})
    }
    return { runs, nodes, orphaned }
  }

  dispose(): void {
    this.disposed = true
  }

  private publish(runId: string): void {
    this.hub.publish({ type: 'run', runId })
  }

  // ── start / status ────────────────────────────────────────────────────────

  async startRun(input: { sessionId: string, cwd: string, title: string, requirement: string, template?: StartTemplateId }): Promise<{ run: RunRow, created: boolean }> {
    const existing = this.store.runBySession(input.sessionId)
    if (existing) {
      if (existing.status === 'INTERRUPTED') await this.continueRun(existing.id)
      return { run: this.store.runById(existing.id)!, created: false }
    }
    if (!input.requirement.trim() && !input.title.trim()) throw new UserError('requirement is required to start a workflow')
    const id = `WF-${Date.now().toString(36).slice(-4).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const repo = await repoRoot(input.cwd)
    let worktreePath = input.cwd
    let branch: string | null = null
    let baseRef: string | null = null
    if (repo) {
      worktreePath = join(this.worktreeRoot, id)
      branch = `rdfoe/${id}`
      baseRef = (await createWorktree(repo, worktreePath, branch)).baseRef
    }
    const template = TEMPLATES[input.template ?? 'full']
    const { run, created } = this.store.getOrCreateRun({
      id,
      sessionId: input.sessionId,
      projectPath: repo ?? input.cwd,
      worktreePath,
      branch,
      baseRef,
      isGit: repo !== undefined,
      title: input.title,
      requirement: input.requirement,
      template: template.id,
      config: {},
    }, template.order.map(key => ({ key, kind: NODE_KIND[key] })))
    if (created) {
      this.store.transition({ table: 'run', id: run.id }, 'start')
      this.publish(run.id)
      this.schedule(run.id)
    }
    return { run: this.store.runById(run.id)!, created }
  }

  /** Start from the UI for a session (resolves its cwd from the live or resumed agent). */
  async startForSession(sessionId: string, requirement: string, title: string, template?: StartTemplateId): Promise<{ run: RunRow, created: boolean }> {
    const main = await this.runner.mainAgent(sessionId)
    const cwd = main?.session.header.cwd
    if (!cwd) throw new UserError('cannot resolve the working directory of this session', 409)
    return this.startRun({ sessionId, cwd, requirement, template, title: title.trim() || requirement.trim().split('\n')[0]!.slice(0, 40) })
  }

  /** The live or resumed main-session agent (also used by the /dev routes). */
  mainAgent(sessionId: string) {
    return this.runner.mainAgent(sessionId)
  }

  pendingCount(runId: string): number {
    return this.store.inbox({ runId, status: 'OPEN' }).length
  }

  // ── scheduling ───────────────────────────────────────────────────────────

  /** Serialize ticks per run; errors are recorded, never thrown to callers. */
  schedule(runId: string): void {
    const previous = this.chains.get(runId) ?? Promise.resolve()
    const next = previous.then(() => this.tick(runId)).catch((error: unknown) => {
      this.store.event(runId, null, 'tick:error', null, null, { error: String(error) })
      this.publish(runId)
    })
    this.chains.set(runId, next)
  }

  private async tick(runId: string): Promise<void> {
    if (this.disposed) return
    const run = this.store.runById(runId)
    if (!run || run.status !== 'RUNNING') return
    const template = templateOf(run)
    if (template.id === 'legacy') return
    const nodes = new Map(this.store.nodes(runId).map(n => [n.node_key, n]))
    for (const key of template.order) {
      const node = nodes.get(key)!
      if (NODE_KIND[key] === 'ai') {
        if (node.status === 'SUCCEEDED') continue
        this.store.updateRun(runId, { current_node: key })
        if (node.status === 'PENDING' || node.status === 'STALE') await this.launchNode(run, key as AiKey, 'start')
        this.publish(runId)
        return
      }
      if (node.status === 'APPROVED') continue
      this.store.updateRun(runId, { current_node: key })
      if (node.status !== 'AWAITING_REVIEW') await this.openReview(run, key as GateKey)
      this.publish(runId)
      return
    }
    this.store.transition({ table: 'run', id: runId }, 'complete')
    this.store.updateRun(runId, { current_node: null })
    this.releaseLock(run)
    this.publish(runId)
  }

  private releaseLock(run: RunRow): void {
    if (this.projectLocks.get(run.project_path) === run.id) {
      this.projectLocks.delete(run.project_path)
      for (const other of this.store.runsByStatus('RUNNING')) if (other.id !== run.id && other.project_path === run.project_path) this.schedule(other.id)
    }
  }

  // ── AI nodes ─────────────────────────────────────────────────────────────

  private async launchNode(run: RunRow, key: AiKey, event: 'start' | 'retry'): Promise<void> {
    if (!run.is_git && (key === 'X' || key === 'Y')) {
      const holder = this.projectLocks.get(run.project_path)
      if (holder && holder !== run.id) {
        this.store.event(run.id, null, 'node:queued', null, null, { node: key, waitingFor: holder })
        return
      }
      this.projectLocks.set(run.project_path, run.id)
    }
    const node = this.store.node(run.id, key)
    // A BLOCKED clarification already recorded its version; its rerun is a new one.
    const version = event === 'start' || node.status === 'BLOCKED' ? node.current_version + 1 : node.current_version
    let round = run.loop_round
    if (key === templateOf(run).tasksNode && event === 'start') {
      this.store.updateRun(run.id, { loop_round: 0, stall_ack_round: 0 })
      round = 0
    }
    if (key === 'X' && event === 'start') {
      round = run.loop_round + 1
      this.store.updateRun(run.id, { loop_round: round })
    }
    const fresh = this.store.runById(run.id)!
    this.store.transition({ table: 'node', id: node.id }, event, {
      attempt: node.attempt + 1, current_version: version, started_at: now(), ended_at: null, error: null,
    }, { version, round })
    const main = await this.runner.mainAgent(run.session_id)
    const agentRow = this.store.createAgentRow({ runId: run.id, nodeId: node.id, version, role: key })
    try {
      await this.startAgent(fresh, this.store.node(run.id, key), agentRow, version, round, main, false)
    } catch (error) {
      this.store.patchAgent(agentRow.id, { status: 'FAILED', error: String(error), ended_at: now() })
      await this.onAgentFinished(agentRow.id, { agentSessionId: '', endKind: 'error', error: String(error), finalText: '' })
    }
  }

  private async startAgent(run: RunRow, node: NodeRow, agentRow: NodeAgentRow, version: number, round: number, main: Agent | undefined, resume: boolean): Promise<void> {
    const role = node.node_key as AiKey
    const outputs = REQUIRED_ARTIFACTS[role].map(file => `${artifactDir(run.id, role, version)}/${file}`)
    const tasksPath = role === 'X' || role === 'Y' ? this.planFile(run, 'tasks.md') : undefined
    const env = this.toolEnv(run, node, agentRow, role, version, round, {
      required: outputs,
      // Y never touches application code; DR and A write only their own record.
      writeScope: role === 'Y' ? [...outputs, ...(tasksPath ? [tasksPath] : [])] : role === 'DR' || role === 'A' ? outputs : undefined,
    })
    const prompt = buildPrompt({
      run, role, version, round, resume, outputs, tasksPath,
      upstream: this.upstreamFor(run, role, version),
      rejections: this.store.reviewsOfRun(run.id).filter(r => r.decision === 'REJECTED' && r.rollback_to === role),
      replies: resume ? this.answeredFor(agentRow) : this.takeNodeReplies(node),
      failedItems: role === 'D' ? lastFailures(this.latestVersionRow(run.id, 'DR')) : role === 'X' ? lastFailures(this.latestVersionRow(run.id, 'Y')) : undefined,
      reviews: role === 'A' ? this.store.reviewsOfRun(run.id) : undefined,
    })
    const launchInput = {
      env,
      mainSessionId: run.session_id,
      persona: personaFor(role, this.config.personas),
      prompt,
      label: `${run.id} · ${NODE_LABEL[role]} v${version}`,
      route: this.runner.route(main, routeFor(this.config.nodes, role), this.config.defaultModel),
      onSession: (id: string) => { this.agentSessions.set(agentRow.id, id); this.store.patchAgent(agentRow.id, { agent_session_id: id }) },
    }
    this.store.patchAgent(agentRow.id, { model: [launchInput.route.provider, launchInput.route.model].filter(Boolean).join('/') })
    let live
    if (resume && agentRow.agent_session_id) {
      try {
        live = await this.runner.resume({ ...launchInput, agentSessionId: agentRow.agent_session_id }, main)
      } catch (error) {
        // Cold resume failed: start a fresh session from the persisted artifacts.
        this.store.event(run.id, node.id, 'agent:resume-failed', null, null, { error: String(error) })
        live = await this.runner.launch(launchInput, main)
      }
    } else {
      live = await this.runner.launch(launchInput, main)
    }
    this.agentSessions.set(agentRow.id, live.agentSessionId)
    this.store.patchAgent(agentRow.id, { agent_session_id: live.agentSessionId, status: 'RUNNING' })
    this.store.patchNode(node.id, { agent_session_id: live.agentSessionId })
    this.store.event(run.id, node.id, 'agent:start', null, 'RUNNING', { role, agentSessionId: live.agentSessionId, attach: live.attach, resume })
    this.publish(run.id)
    void live.done.then(result => this.onAgentFinished(agentRow.id, result))
  }

  private latestVersionRow(runId: string, key: AiKey) {
    const node = this.store.nodes(runId).find(n => n.node_key === key)
    return node && node.current_version > 0 ? this.store.version(node.id, node.current_version) : undefined
  }

  /** A file of the node that holds it in this template (tasks.md → T/S; verify-plan.md, acceptance.md → V/S). */
  private planFile(run: RunRow, file: 'tasks.md' | 'verify-plan.md' | 'acceptance.md'): string | undefined {
    const template = templateOf(run)
    const key = file === 'tasks.md' ? template.tasksNode : template.verifyPlanNode
    const row = key ? this.latestVersionRow(run.id, key) : undefined
    return key && row ? `${artifactDir(run.id, key, row.version)}/${file}` : undefined
  }

  /** The artifacts the role reads: latest successful versions of upstream nodes, plus its own previous version on a redo. */
  private upstreamFor(run: RunRow, role: AiKey, version: number): { label: string, path: string }[] {
    const template = templateOf(run)
    const out: { label: string, path: string }[] = []
    const inTemplate = (key: AiKey) => template.order.includes(key)
    const add = (key: AiKey, v: number | undefined, files: [string, string][]) => {
      if (!v || !inTemplate(key)) return
      const row = this.store.version(this.store.node(run.id, key).id, v)
      if (!row) return
      const artifacts = JSON.parse(row.artifacts_json) as string[]
      for (const [file, label] of files) {
        const path = `${artifactDir(run.id, key, v)}/${file}`
        if (artifacts.includes(path)) out.push({ label, path })
      }
    }
    const cur = (key: AiKey) => (inTemplate(key) ? this.store.node(run.id, key).current_version : 0)
    const previous = (key: AiKey, files: [string, string][]) => { if (version > 1) add(key, version - 1, files.map(([f, l]): [string, string] => [f, `上一版 v${version - 1} ${l}`])) }
    const requirement = () => add(cur('C') ? 'C' : 'R', cur('C') || cur('R'), [['requirement.md', '需求（requirement.md）']])
    const design = () => { requirement(); add('D', cur('D'), [['design.md', '设计（design.md）']]); add('DR', cur('DR'), [['review.md', '设计审查（review.md）']]) }
    const source = () => (template.id === 'small' ? add('S', cur('S'), [['change.md', '小改动说明（change.md）']]) : design())
    const plan = () => {
      const tasks = template.tasksNode!
      const vp = template.verifyPlanNode!
      add(tasks, cur(tasks), [['tasks.md', '任务清单（tasks.md）']])
      add(vp, cur(vp), [['verify-plan.md', '验证计划（verify-plan.md）'], ['acceptance.md', '用户验收指引（acceptance.md）']])
    }
    switch (role) {
      case 'R':
        previous('R', [['requirement.md', '需求（requirement.md）']])
        break
      case 'C':
        add('R', cur('R'), [['requirement.md', '需求录入稿（requirement.md）']])
        previous('C', [['requirement.md', '澄清稿（requirement.md）']])
        break
      case 'D':
        requirement()
        previous('D', [['design.md', '设计（design.md）']])
        add('DR', cur('DR'), [['review.md', '最近一次设计审查（review.md）']])
        break
      case 'DR':
        requirement()
        add('D', cur('D'), [['design.md', '待审设计（design.md）']])
        previous('DR', [['review.md', '设计审查（review.md）']])
        break
      case 'T':
        design()
        previous('T', [['tasks.md', '任务清单（tasks.md）']])
        break
      case 'V':
        design()
        add('T', cur('T'), [['tasks.md', '任务清单（tasks.md）']])
        previous('V', [['verify-plan.md', '验证计划（verify-plan.md）'], ['acceptance.md', '用户验收指引（acceptance.md）']])
        break
      case 'S':
        previous('S', REQUIRED_ARTIFACTS.S.map((f): [string, string] => [f, `（${f}）`]))
        break
      case 'X':
        source()
        plan()
        add('Y', cur('Y'), [['verification.md', '上一轮验证记录']])
        break
      case 'Y':
        source()
        plan()
        add('X', cur('X'), [['verification.md', '本轮实施证据（verification.md）']])
        add('Y', version - 1, [['verification.md', '上一轮验证记录']])
        break
      case 'A':
        source()
        plan()
        add('X', cur('X'), [['verification.md', '最终实施证据（verification.md）']])
        add('Y', cur('Y'), [['verification.md', '最终验证记录（verification.md）'], ['acceptance-report.md', '验收报告（acceptance-report.md）']])
        break
    }
    return out
  }

  /** Non-blocking replies that arrived after this node's agents ended (§7.4 rule 2). */
  private takeNodeReplies(node: NodeRow): InboxRow[] {
    const rows = this.store.undelivered({ nodeId: node.id })
    this.store.markDelivered(rows.map(r => r.id))
    return rows
  }

  /** Items this interrupted agent asked before the restart and that now have answers (§7.5). */
  private answeredFor(agentRow: NodeAgentRow): InboxRow[] {
    if (!agentRow.agent_session_id) return []
    const rows = this.store.inbox({ runId: agentRow.run_id }).filter(i => i.agent_session_id === agentRow.agent_session_id && i.status === 'RESOLVED' && i.delivered_at === null && i.response_json !== null)
    this.store.markDelivered(rows.map(r => r.id))
    return rows
  }

  private toolEnv(run: RunRow, node: NodeRow, agentRow: NodeAgentRow, role: AiKey, version: number, round: number, files: { required?: string[], writeScope?: string[] } = {}): ToolEnv {
    const agentSessionId = () => this.agentSessions.get(agentRow.id) ?? this.store.agentRow(agentRow.id)?.agent_session_id ?? undefined
    return {
      runId: run.id,
      nodeId: node.id,
      role,
      version,
      round,
      root: run.worktree_path,
      required: files.required,
      writeScope: files.writeScope,
      agentSessionId,
      limits: { maxWriteBytes: this.config.write.maxBytes, execTimeoutMs: this.config.exec.timeoutMs, execOutputBytes: this.config.exec.outputBytes },
      audit: (tool, args, affected, exitCode, startedAt) => {
        this.store.toolCall({ run_id: run.id, node_id: node.id, agent_session_id: agentSessionId() ?? null, tool, args_digest: typeof args === 'string' ? args : JSON.stringify(args), affected_paths: affected.length ? affected.join('\n') : null, exit_code: exitCode, duration_ms: Date.now() - startedAt })
        this.hub.publish({ type: 'tool', runId: run.id, nodeId: node.id, tool })
      },
      takeReplies: () => {
        const id = agentSessionId()
        if (!id) return []
        const rows = this.store.undelivered({ agentSessionId: id })
        if (rows.length === 0) return []
        this.store.markDelivered(rows.map(r => r.id))
        return rows.map(r => {
          const payload = JSON.parse(r.payload_json) as Record<string, unknown>
          const response = JSON.parse(r.response_json ?? 'null') as Record<string, unknown>
          return r.kind === 'message'
            ? `对你的消息「${String(payload.text).slice(0, 80)}」：${String(response.text ?? '')}`
            : formatAnswers(payload.questions as AskQuestion[], response)
        })
      },
      ask: async (questions, blocking, signal) => {
        const item = this.inbox.open({ runId: run.id, sessionId: run.session_id, nodeId: node.id, agentSessionId: agentSessionId() ?? null, round, kind: 'question', blocking, payload: { role, questions } })
        if (!blocking) return `问题已登记为 ${item.id}（非阻塞）。请按你的合理假设继续；用户答复后会随之后的 wf_* 工具结果送达。`
        this.enterWait(node.id)
        try {
          const response = await this.inbox.wait(item.id, signal) as Record<string, unknown>
          return formatAnswers(questions, response)
        } finally {
          this.leaveWait(node.id)
        }
      },
      message: async (text, level, expectReply) => {
        const count = (this.messageCounts.get(agentRow.id) ?? 0) + 1
        if (count > this.config.message.maxPerAgent) throw new Error(`message limit reached (${this.config.message.maxPerAgent} per agent run)`)
        this.messageCounts.set(agentRow.id, count)
        const item = this.inbox.open({ runId: run.id, sessionId: run.session_id, nodeId: node.id, agentSessionId: agentSessionId() ?? null, round, kind: 'message', blocking: false, payload: { role, text, level, expectReply } })
        return item.id
      },
      report: (report) => { this.reports.set(agentRow.id, report) },
    }
  }

  private enterWait(nodeId: string): void {
    const node = this.store.nodeById(nodeId)
    if (node && canApply('ai', node.status, 'wait')) {
      this.store.transition({ table: 'node', id: nodeId }, 'wait')
      this.publish(node.run_id)
    }
  }

  private leaveWait(nodeId: string): void {
    const node = this.store.nodeById(nodeId)
    if (!node || node.status !== 'WAITING_ANSWER') return
    const stillBlocked = this.store.inbox({ runId: node.run_id, status: 'OPEN' }).some(i => i.node_id === nodeId && i.blocking === 1 && this.inbox.hasWaiter(i.id))
    if (!stillBlocked) {
      this.store.transition({ table: 'node', id: nodeId }, 'answered')
      this.publish(node.run_id)
    }
  }

  private async onAgentFinished(agentRowId: string, result: AgentRunResult): Promise<void> {
    if (this.disposed) return
    let agentRow = this.store.agentRow(agentRowId)!
    const node = this.store.nodeById(agentRow.node_id)!
    const run = this.store.runById(agentRow.run_id)!
    if (agentRow.status === 'CANCELLED' || node.status === 'CANCELLED' || node.status === 'INTERRUPTED') return
    let report = this.reports.get(agentRowId)
    if (!report && result.endKind === 'completed' && result.agentSessionId) {
      // One reminder before declaring the node failed.
      const again = await this.runner.nudge(result.agentSessionId, '你还没有调用 wf_report。请先确认产出文件已写好，然后调用 wf_report 提交结构化结果。')
      report = this.reports.get(agentRowId)
      if (again) result = again
    }
    if (agentRow.status === 'RUNNING') {
      this.store.patchAgent(agentRowId, {
        status: report ? 'COMPLETED' : 'FAILED',
        report_json: report ? JSON.stringify(report) : null,
        error: report ? null : `agent ended (${result.endKind}${result.error ? `: ${result.error}` : ''}) without wf_report`,
        ended_at: now(),
      })
    }
    if (result.agentSessionId) await this.runner.dispose(result.agentSessionId)
    agentRow = this.store.agentRow(agentRowId)!
    this.store.event(run.id, node.id, 'agent:end', 'RUNNING', agentRow.status, { role: agentRow.role, endKind: result.endKind, error: agentRow.error })
    const current = this.store.nodeById(node.id)!
    if (current.status !== 'RUNNING' && current.status !== 'WAITING_ANSWER') { this.publish(run.id); return }
    if (agentRow.status === 'FAILED') {
      const error = agentRow.error ?? 'failed'
      this.store.transition({ table: 'node', id: node.id }, 'fail', { error, ended_at: now() })
      this.inbox.open({ runId: run.id, sessionId: run.session_id, nodeId: node.id, agentSessionId: null, round: run.loop_round, kind: 'message', blocking: false, payload: { role: 'system', level: 'risk', text: `节点 ${NODE_LABEL[node.node_key]} v${current.current_version} 失败：${error}。可在工作流视图点「重试」。` } })
      this.publish(run.id)
      return
    }
    await this.completeNode(run, current, JSON.parse(agentRow.report_json!) as NodeReport)
  }

  private async completeNode(run: RunRow, node: NodeRow, report: NodeReport): Promise<void> {
    const key = node.node_key as AiKey
    const version = node.current_version
    const merged = { ...report, artifacts: [...report.artifacts] }
    const dir = join(run.worktree_path, artifactDir(run.id, key, version))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'report.json'), `${JSON.stringify(merged, null, 2)}\n`)
    if (key === 'Y') {
      await writeFile(join(dir, 'acceptance-report.md'), acceptanceMarkdown(run, version, merged))
      merged.artifacts.push(`${artifactDir(run.id, 'Y', version)}/acceptance-report.md`)
    }
    const origin = key === 'X' && run.loop_round > 1 ? 'loop_fix' : version > 1 ? 'revised' : 'generated'
    this.store.addVersion({ node_id: node.id, version, round: run.loop_round, origin, artifacts_json: JSON.stringify(merged.artifacts), summary: merged.summary, structured_json: JSON.stringify(merged) })

    if (key === 'C' && report.blocked) {
      this.store.transition({ table: 'node', id: node.id }, 'block', { ended_at: now() }, { version, blockers: report.openIssues })
      this.inbox.open({
        runId: run.id, sessionId: run.session_id, nodeId: node.id, agentSessionId: null, round: run.loop_round, kind: 'message', blocking: false,
        payload: {
          role: 'system', level: 'risk', expectReply: true, blocked: true,
          text: `需求澄清仍有阻断，工作流停在「需求澄清」：\n${report.openIssues.map(o => `- ${o}`).join('\n')}\n\n回复这条消息补充信息，澄清节点会带着你的回复重新运行；也可以在工作流视图点「按当前需求继续」进入设计。`,
        },
      })
      this.publish(run.id)
      return
    }
    this.store.transition({ table: 'node', id: node.id }, 'succeed', { ended_at: now() }, { version })

    const commit = async (message: string) => {
      if (!run.is_git) return
      const sha = await commitAll(run.worktree_path, `rdfoe(${run.id}): ${message}`).catch((error: unknown) => {
        this.store.event(run.id, node.id, 'git:commit-failed', null, null, { error: String(error) })
        return undefined
      })
      if (sha) this.store.setVersionCommit(node.id, version, sha)
    }
    if (key === 'X') await commit(`X round ${run.loop_round} (v${version})`)
    if (key === 'A') await commit(`A archived (v${version})`)
    if (key === 'Y') {
      await commit(`Y verification ${report.verdict === 'fail' ? 'failed' : 'passed'} (round ${run.loop_round})`)
      if (report.verdict === 'fail') return this.onVerificationFailed(run)
    }
    if (key === 'DR' && report.verdict === 'fail') {
      await commit(`DR design review blocked D v${this.store.node(run.id, 'D').current_version}`)
      return this.onDesignReviewFailed(run)
    }
    this.publish(run.id)
    this.schedule(run.id)
  }

  // ── D ⇄ DR loop ──────────────────────────────────────────────────────────

  /** DR versions with their blocking findings (the design loop record). */
  designTrend(runId: string): { round: number, failed: number, total: number, failedIds: string[] }[] {
    const dr = this.store.nodes(runId).find(n => n.node_key === 'DR')
    if (!dr) return []
    return this.store.versions(dr.id).map((v) => {
      const items = (JSON.parse(v.structured_json) as { items?: { id: string, result: string }[] }).items ?? []
      return { round: v.version, failed: items.filter(i => i.result === 'fail').length, total: items.length, failedIds: items.filter(i => i.result === 'fail').map(i => i.id) }
    })
  }

  private async onDesignReviewFailed(run: RunRow): Promise<void> {
    const ack = (JSON.parse(run.config_json) as RunConfig).designAck ?? 0
    const trend = this.designTrend(run.id).filter(t => t.round > ack)
    let streak = 0
    for (const t of [...trend].reverse()) { if (t.failed > 0) streak++; else break }
    if (streak >= this.config.loop.stallRounds) {
      // Leave D and DR as they are: the user either loops again or takes the design to review as is.
      this.store.transition({ table: 'run', id: run.id }, 'pause', {}, { reason: 'design_loop_stall' })
      this.inbox.open({
        runId: run.id, sessionId: run.session_id, nodeId: this.store.node(run.id, 'DR').id, agentSessionId: null, round: streak, kind: 'loop_stall', blocking: true,
        payload: { loop: 'design', round: streak, reason: `设计审查连续 ${streak} 次发现阻断问题`, trend: this.designTrend(run.id) },
      })
      this.publish(run.id)
      return
    }
    this.staleLoop(run, 'D', 'DR', 'design review blocked')
    this.publish(run.id)
    this.schedule(run.id)
  }

  private staleLoop(run: RunRow, fix: AiKey, check: AiKey, reason: string): void {
    this.store.tx(() => {
      for (const key of [fix, check]) {
        const n = this.store.node(run.id, key)
        if (canApply('ai', n.status, 'stale')) this.store.transition({ table: 'node', id: n.id }, 'stale', {}, { reason, round: run.loop_round })
      }
    })
  }

  // ── X ⇄ Y loop (§4.1) ────────────────────────────────────────────────────

  private async onVerificationFailed(run: RunRow): Promise<void> {
    this.staleLoop(run, 'X', 'Y', 'verification failed')
    const stall = this.stallReason(run.id)
    if (stall) {
      this.store.transition({ table: 'run', id: run.id }, 'pause', {}, { reason: 'loop_stall' })
      this.inbox.open({
        runId: run.id, sessionId: run.session_id, nodeId: this.store.node(run.id, 'Y').id, agentSessionId: null, round: run.loop_round, kind: 'loop_stall', blocking: true,
        payload: { loop: 'implement', round: run.loop_round, reason: stall, trend: this.failTrend(run.id) },
      })
      this.publish(run.id)
      return
    }
    this.publish(run.id)
    this.schedule(run.id)
  }

  /** Failure counts per round in the current X ⇄ Y loop (check versions since the latest tasks version). */
  failTrend(runId: string): { round: number, failed: number, total: number, failedIds: string[] }[] {
    const template = templateOf(this.store.runById(runId)!)
    const [sinceKey, checkKey] = template.id === 'legacy' ? ['P', 'X2'] : [template.tasksNode!, 'Y']
    const nodes = this.store.nodes(runId)
    const since = nodes.find(n => n.node_key === sinceKey)
    const check = nodes.find(n => n.node_key === checkKey)
    if (!check) return []
    const from = since && since.current_version > 0 ? this.store.version(since.id, since.current_version)?.created_at ?? '' : ''
    return this.store.versions(check.id)
      .filter(v => v.round >= 1 && v.created_at > from)
      .map((v) => {
        const items = (JSON.parse(v.structured_json) as { items?: { id: string, result: string }[] }).items ?? []
        return { round: v.round, failed: items.filter(i => i.result === 'fail').length, total: items.length, failedIds: items.filter(i => i.result === 'fail').map(i => i.id) }
      })
  }

  private stallReason(runId: string): string | undefined {
    const run = this.store.runById(runId)!
    const { stallRounds: k, remindAt } = this.config.loop
    const trend = this.failTrend(runId).filter(t => t.round > run.stall_ack_round)
    const round = run.loop_round
    if (round >= remindAt && round > run.stall_ack_round && round % remindAt === 0) return `累计已进行 ${round} 轮实施⇄验证（提醒阈值 ${remindAt}）`
    if (trend.length >= k + 1) {
      const tail = trend.slice(-(k + 1))
      if (tail.slice(1).every((t, i) => t.failed >= tail[i]!.failed)) return `连续 ${k} 轮失败项没有减少（${tail.map(t => t.failed).join(' → ')}）`
    }
    if (trend.length >= k) {
      const tail = trend.slice(-k)
      const repeated = tail[0]!.failedIds.filter(id => tail.every(t => t.failedIds.includes(id)))
      if (repeated.length > 0) return `同一失败项连续 ${k} 轮出现：${repeated.join('、')}`
    }
    return undefined
  }

  // ── review gates ──────────────────────────────────────────────────────────

  private async openReview(run: RunRow, gate: GateKey): Promise<void> {
    const template = templateOf(run)
    const node = this.store.node(run.id, gate)
    const subjects = template.gateSubject[gate]!.map((key) => {
      const subject = this.store.node(run.id, key)
      const version = this.store.version(subject.id, subject.current_version)
      const structured = version ? JSON.parse(version.structured_json) as Record<string, unknown> : {}
      return {
        node: key,
        label: NODE_LABEL[key],
        version: subject.current_version,
        artifacts: version ? JSON.parse(version.artifacts_json) as string[] : [],
        summary: version?.summary ?? '',
        openIssues: (structured.openIssues ?? []) as string[],
        confidence: structured.confidence as number | undefined,
        verdict: structured.verdict as string | undefined,
        items: structured.items as unknown,
        previousVersion: subject.current_version > 1 ? subject.current_version - 1 : undefined,
      }
    })
    const main = template.rollbackTargets[gate]![0]!
    const targetVersion = this.store.node(run.id, main).current_version
    this.store.transition({ table: 'node', id: node.id }, 'open', { current_version: targetVersion, started_at: now() }, { targetVersion })
    this.inbox.open({
      runId: run.id, sessionId: run.session_id, nodeId: node.id, agentSessionId: null, round: run.loop_round, kind: 'review', blocking: true,
      payload: {
        gate, label: NODE_LABEL[gate], template: template.id, subjects, rollbackTargets: template.rollbackTargets[gate],
        loop: gate === 'H3' ? this.failTrend(run.id) : undefined,
        // H3 = PH ph-verify step 4: the user judges the outcome with the prepared guide.
        acceptanceGuide: gate === 'H3' ? this.planFile(run, 'acceptance.md') : undefined,
      },
    })
  }

  private async approve(run: RunRow, gate: GateKey): Promise<void> {
    const subjects = templateOf(run).gateSubject[gate]!
    const gateNode = this.store.node(run.id, gate)
    this.store.tx(() => {
      this.store.transition({ table: 'node', id: gateNode.id }, 'approve', { ended_at: now() })
      this.store.addReview({ node_id: gateNode.id, target_version: gateNode.current_version, decision: 'APPROVED', comment: '', rollback_to: null })
      for (const key of subjects) {
        const subject = this.store.node(run.id, key)
        this.store.patchNode(subject.id, { final_version: subject.current_version })
        this.store.event(run.id, subject.id, 'node:finalize', null, null, { version: subject.current_version })
      }
    })
    // H3's approval is committed with the archive (A).
    if (run.is_git && gate !== 'H3') {
      const sha = await commitAll(run.worktree_path, `rdfoe(${run.id}): ${gate} approved ${subjects.map(k => `${k} v${this.store.node(run.id, k).current_version}`).join(', ')}`).catch((error: unknown) => {
        this.store.event(run.id, gateNode.id, 'git:commit-failed', null, null, { error: String(error) })
        return undefined
      })
      if (sha) for (const key of subjects) this.store.setVersionCommit(this.store.node(run.id, key).id, this.store.node(run.id, key).current_version, sha)
    }
    if (gate === 'H3') this.releaseLock(run)
    this.schedule(run.id)
  }

  private reject(run: RunRow, gate: GateKey, comment: string, rollbackTo: AiKey): void {
    const gateNode = this.store.node(run.id, gate)
    this.store.tx(() => {
      this.store.transition({ table: 'node', id: gateNode.id }, 'reject', { ended_at: now() }, { comment, rollbackTo })
      this.store.addReview({ node_id: gateNode.id, target_version: gateNode.current_version, decision: 'REJECTED', comment, rollback_to: rollbackTo })
      for (const key of downstreamFrom(templateOf(run), rollbackTo)) {
        if (key === gate) continue
        const n = this.store.node(run.id, key)
        if (canApply(isGate(key) ? 'review' : 'ai', n.status, 'stale')) this.store.transition({ table: 'node', id: n.id }, 'stale', {}, { cause: `${gate} rejected → ${rollbackTo}` })
      }
    })
    this.schedule(run.id)
  }

  // ── inbox responses (the only human write path) ───────────────────────────

  async respond(itemId: string, body: Record<string, unknown>): Promise<InboxRow> {
    const item = this.store.inboxItem(itemId)
    if (!item) throw new UserError('inbox item not found', 404)
    if (item.status !== 'OPEN') throw new UserError(`inbox item is ${item.status}`, 409)
    const run = this.store.runById(item.run_id)!
    const template = templateOf(run)
    const action = String(body.action ?? '')
    switch (item.kind) {
      case 'question': {
        const answers = (body.answers ?? {}) as Record<string, unknown>
        if (action !== 'answer' && action !== 'skip') throw new UserError('action must be answer or skip')
        return this.inbox.resolve(itemId, action === 'skip' ? { answers: {}, skippedAll: true } : { answers })
      }
      case 'message': {
        if (action === 'read') return this.inbox.resolve(itemId, null)
        if (action !== 'reply' || typeof body.text !== 'string' || !body.text.trim()) throw new UserError('action must be read, or reply with text')
        return this.inbox.resolve(itemId, { text: body.text })
      }
      case 'review': {
        const payload = JSON.parse(item.payload_json) as { gate: GateKey }
        const gateNode = this.store.node(run.id, payload.gate)
        if (gateNode.status !== 'AWAITING_REVIEW') throw new UserError(`gate ${payload.gate} is ${gateNode.status}`, 409)
        if (action === 'approve') {
          const resolved = this.inbox.resolve(itemId, { action })
          await this.approve(run, payload.gate)
          return resolved
        }
        if (action === 'reject') {
          const comment = typeof body.comment === 'string' ? body.comment.trim() : ''
          if (!comment) throw new UserError('a rejection needs a comment')
          const targets = template.rollbackTargets[payload.gate] ?? []
          const rollbackTo = String(body.rollbackTo ?? targets[0]) as AiKey
          if (!targets.includes(rollbackTo)) throw new UserError(`rollbackTo must be one of ${targets.join(', ')}`)
          const resolved = this.inbox.resolve(itemId, { action, comment, rollbackTo })
          this.reject(run, payload.gate, comment, rollbackTo)
          return resolved
        }
        throw new UserError('action must be approve or reject')
      }
      case 'loop_stall': {
        const design = (JSON.parse(item.payload_json) as { loop?: string }).loop === 'design'
        const allowed = design ? ['continue', 'to_review', 'terminate'] : ['continue', 'back_to_plan', 'terminate']
        if (!allowed.includes(action)) throw new UserError(`action must be ${allowed.join(', ')}`)
        const resolved = this.inbox.resolve(itemId, { action })
        if (action === 'terminate') {
          await this.cancelRun(run.id, 'terminated from loop_stall')
          return resolved
        }
        if (design) {
          const dr = this.store.node(run.id, 'DR')
          this.store.updateRun(run.id, { config_json: JSON.stringify({ ...JSON.parse(run.config_json) as RunConfig, designAck: dr.current_version }) })
          if (action === 'continue') this.staleLoop(run, 'D', 'DR', 'design loop continued by the user')
          // to_review: D and DR stay SUCCEEDED, so the tick opens H1 with the blocking findings visible.
        } else {
          this.store.updateRun(run.id, { stall_ack_round: run.loop_round })
          if (action === 'back_to_plan') {
            this.store.tx(() => {
              for (const key of downstreamFrom(template, template.tasksNode!)) {
                const n = this.store.node(run.id, key)
                if (canApply(isGate(key) ? 'review' : 'ai', n.status, 'stale')) this.store.transition({ table: 'node', id: n.id }, 'stale', {}, { cause: 'loop_stall back_to_plan' })
              }
            })
          }
        }
        if (this.store.runById(run.id)!.status === 'PAUSED') this.store.transition({ table: 'run', id: run.id }, 'resume', {}, { cause: `loop_stall ${action}` })
        this.schedule(run.id)
        return resolved
      }
    }
  }

  /** Answers to blocking items whose asking agent died with the old process (§7.5); replies that unblock C. */
  private afterResolved(item: InboxRow): void {
    if (item.kind === 'message') {
      const payload = JSON.parse(item.payload_json) as { blocked?: boolean }
      const response = JSON.parse(item.response_json ?? 'null') as { text?: string } | null
      const node = item.node_id ? this.store.nodeById(item.node_id) : undefined
      const run = this.store.runById(item.run_id)
      // A reply to the "clarification blocked" notice reruns C with the reply as input.
      if (payload.blocked && response?.text && node?.status === 'BLOCKED' && run?.status === 'RUNNING') {
        void this.retryNode(run.id, node.node_key).catch((error: unknown) => this.store.event(item.run_id, node.id, 'node:retry-failed', null, null, { error: String(error) }))
      }
      this.publish(item.run_id)
      return
    }
    if (item.kind !== 'question') { this.publish(item.run_id); return }
    if (!item.agent_session_id || this.inbox.hasWaiter(item.id)) return
    const agentRow = this.store.agentBySession(item.agent_session_id)
    const run = this.store.runById(item.run_id)
    if (agentRow?.status === 'INTERRUPTED' && run?.status === 'RUNNING') void this.resumeAgent(agentRow.id).catch(() => {})
    this.publish(item.run_id)
  }

  // ── run controls ──────────────────────────────────────────────────────────

  /** 「继续」(§8.3 step 2). */
  async continueRun(runId: string): Promise<void> {
    const run = this.store.runById(runId)
    if (!run) throw new UserError('run not found', 404)
    if (run.status === 'INTERRUPTED' || run.status === 'PAUSED' || run.status === 'FAILED') {
      if (run.status === 'PAUSED' && this.store.inbox({ runId, status: 'OPEN', kind: 'loop_stall' }).length > 0) throw new UserError('answer the loop-stall item in the inbox first', 409)
      this.store.transition({ table: 'run', id: runId }, 'resume', {}, { cause: 'continue' })
    } else if (run.status !== 'RUNNING') {
      throw new UserError(`run is ${run.status}`, 409)
    }
    for (const agentRow of this.store.agentsOfRun(runId).filter(a => a.status === 'INTERRUPTED')) {
      const waiting = this.store.inbox({ runId, status: 'OPEN' }).some(i => i.agent_session_id === agentRow.agent_session_id && i.blocking === 1)
      if (!waiting) await this.resumeAgent(agentRow.id)
    }
    this.publish(runId)
    this.schedule(runId)
  }

  private async resumeAgent(agentRowId: string): Promise<void> {
    const agentRow = this.store.agentRow(agentRowId)!
    if (agentRow.status !== 'INTERRUPTED') return
    const run = this.store.runById(agentRow.run_id)!
    const node = this.store.nodeById(agentRow.node_id)!
    if (node.status === 'INTERRUPTED') this.store.transition({ table: 'node', id: node.id }, 'resume')
    this.store.patchAgent(agentRowId, { status: 'RUNNING' })
    const main = await this.runner.mainAgent(run.session_id)
    try {
      await this.startAgent(run, this.store.nodeById(node.id)!, this.store.agentRow(agentRowId)!, agentRow.version, run.loop_round, main, true)
    } catch (error) {
      this.store.patchAgent(agentRowId, { status: 'FAILED', error: String(error), ended_at: now() })
      await this.onAgentFinished(agentRowId, { agentSessionId: '', endKind: 'error', error: String(error), finalText: '' })
    }
  }

  pauseRun(runId: string): void {
    this.store.transition({ table: 'run', id: runId }, 'pause', {}, { cause: 'user' })
    this.publish(runId)
  }

  async cancelRun(runId: string, reason = 'user'): Promise<void> {
    const run = this.store.runById(runId)
    if (!run) throw new UserError('run not found', 404)
    this.store.transition({ table: 'run', id: runId }, 'cancel', {}, { reason })
    for (const agentRow of this.store.agentsOfRun(runId).filter(a => a.status === 'RUNNING' || a.status === 'INTERRUPTED')) {
      this.store.patchAgent(agentRow.id, { status: 'CANCELLED', ended_at: now() })
      if (agentRow.agent_session_id) { this.runner.cancel(agentRow.agent_session_id); void this.runner.dispose(agentRow.agent_session_id) }
    }
    for (const node of this.store.nodes(runId)) {
      if (canApply(node.kind === 'review' ? 'review' : 'ai', node.status, 'cancel') && !['PENDING'].includes(node.status)) this.store.transition({ table: 'node', id: node.id }, 'cancel')
    }
    for (const item of this.store.inbox({ runId, status: 'OPEN' })) this.inbox.cancel(item.id, `run ${reason}`)
    this.releaseLock(run)
    this.publish(runId)
  }

  /** Withdraw the "clarification blocked" notice once the user retried or accepted. */
  private closeBlockedNotice(runId: string, nodeId: string, reason: string): void {
    for (const item of this.store.inbox({ runId, status: 'OPEN', kind: 'message' })) {
      if (item.node_id === nodeId && (JSON.parse(item.payload_json) as { blocked?: boolean }).blocked) this.inbox.cancel(item.id, reason)
    }
  }

  /** 「重试」 for a FAILED node, or rerun a BLOCKED clarification (same version; new replies are delivered). */
  async retryNode(runId: string, key: NodeKey): Promise<void> {
    const run = this.store.runById(runId)
    if (!run || run.status !== 'RUNNING') throw new UserError('run must be RUNNING to retry a node', 409)
    const node = this.store.node(runId, key)
    if (node.status !== 'FAILED' && node.status !== 'BLOCKED') throw new UserError(`node ${key} is ${node.status}`, 409)
    if (node.status === 'BLOCKED') this.closeBlockedNotice(runId, node.id, 'clarification retried')
    await this.launchNode(run, key as AiKey, 'retry')
    this.publish(runId)
  }

  /** 「按当前需求继续」: take a BLOCKED clarification as it is and move on to design. */
  async acceptNode(runId: string, key: NodeKey): Promise<void> {
    const run = this.store.runById(runId)
    if (!run || run.status !== 'RUNNING') throw new UserError('run must be RUNNING', 409)
    const node = this.store.node(runId, key)
    if (node.status !== 'BLOCKED') throw new UserError(`node ${key} is ${node.status}`, 409)
    this.store.transition({ table: 'node', id: node.id }, 'accept', { ended_at: now() }, { cause: 'user accepted the requirement with open blockers' })
    this.closeBlockedNotice(runId, node.id, 'accepted as is')
    this.publish(runId)
    this.schedule(runId)
  }

  /** Read one artifact file of a run (review display). */
  async readArtifact(runId: string, relPath: string): Promise<string> {
    const run = this.store.runById(runId)
    if (!run) throw new UserError('run not found', 404)
    const { resolveInside } = await import('../tools/path-guard.ts')
    const abs = await resolveInside(run.worktree_path, relPath, 'read')
    if ((await stat(abs)).size > 2 * 1024 * 1024) throw new UserError('file too large', 413)
    return readFile(abs, 'utf8')
  }
}

/** Y's structured items also become a table report next to its verification.md. */
function acceptanceMarkdown(run: RunRow, version: number, report: { summary: string, verdict?: string, items?: { id: string, result: string, evidence: string }[], openIssues: string[] }): string {
  const lines = [
    `# 验收报告 · ${run.id} · 第 ${run.loop_round} 轮（v${version}）`,
    '',
    `**结论：${report.verdict === 'pass' ? '通过' : '未通过'}**`,
    '',
    report.summary,
    '',
    '| 条目 | 结果 | 证据 |',
    '|---|---|---|',
    ...(report.items ?? []).map(i => `| ${i.id} | ${i.result === 'pass' ? '✅ 通过' : '❌ 未通过'} | ${i.evidence.replace(/\|/g, '\\|').replace(/\n/g, '<br>')} |`),
  ]
  if (report.openIssues.length > 0) lines.push('', '## 需关注', ...report.openIssues.map(o => `- ${o}`))
  return `${lines.join('\n')}\n`
}
