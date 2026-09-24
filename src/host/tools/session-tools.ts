/**
 * Main-session tools: `wf_start` binds (or resumes) this conversation's run
 * and returns immediately; `wf_status` reports it. `presentationMeta` carries
 * the card facts for the Web `tool.call.toolview` card (no custom session
 * events, R6).
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Store } from '../store/store.ts'
import { NODE_LABEL, TEMPLATES, templateOf, type NodeKey } from '../workflow/template.ts'
import type { WorkflowService } from '../workflow/service.ts'
import { pendingStarts } from './session-command.ts'

const cardSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string', required: true },
    sessionId: { type: 'string', required: true },
    projectPath: { type: 'string', required: true },
    branch: { type: 'string', required: true },
    status: { type: 'string', required: true },
    currentNode: { type: 'string', required: true },
    template: { type: 'string', required: true },
    pending: { type: 'integer', required: true },
    created: { type: 'boolean', required: true },
  },
} as const

function card(store: Store, service: WorkflowService, runId: string, created: boolean) {
  const run = store.runById(runId)!
  return {
    runId: run.id,
    sessionId: run.session_id,
    projectPath: run.project_path,
    branch: run.branch ?? '',
    status: run.status,
    currentNode: run.current_node ?? '',
    template: templateOf(run).id,
    pending: service.pendingCount(run.id),
    created,
  }
}

const describe = (v: { runId: string, status: string, currentNode: string, template: string, pending: number, branch: string, projectPath: string }) =>
  `工作流 ${v.runId}（${TEMPLATES[v.template as 'full' | 'small']?.label ?? v.template}） · ${v.status}${v.currentNode ? ` · 当前节点 ${NODE_LABEL[v.currentNode as NodeKey] ?? v.currentNode}` : ''} · 待处理 ${v.pending}`
  + `${v.branch ? ` · 分支 ${v.branch}` : ''} · 项目 ${v.projectPath}。用户可在本会话的「工作流」视图和侧边栏「收件箱」跟进。`

export function wfStartTool(store: Store, service: WorkflowService) {
  return defineTool({
    name: 'wf_start',
    description: 'Start the RDFOE workflow for the current conversation, or resume the one already bound to it. The flow follows project-harness: template "full" (default) = requirement → clarification → design ⇄ design review → [user approves design] → tasks → verify plan → [user authorises implementation] → implement ⇄ verify → [user acceptance] → archive. Template "small" = small-change prep → [user authorises implementation] → implement ⇄ verify → [user acceptance] → archive; use it only when the user asks for a small change or the change is clearly local, with known expected behaviour and no public interface, data migration or auth change. Pass the full requirement text the user gave. Returns immediately; the workflow runs in the background and the user follows it in the conversation\'s "工作流" view and the inbox. Do not implement the requirement yourself afterwards.',
    parameters: {
      requirement: { type: 'string', description: 'Full requirement text (required when starting a new workflow)' },
      title: { type: 'string', description: 'Short title' },
      template: { type: 'string', enum: ['full', 'small'], description: 'full (default) or small' },
    },
    output: {
      schema: cardSchema,
      render: (_args, v) => [{ type: 'text', text: `${v.created ? '已创建' : '已恢复'}${describe(v)}` }],
      presentationMeta: (_args, v) => ({ runId: v.runId, sessionId: v.sessionId, status: v.status, created: v.created, currentNode: v.currentNode, template: v.template, pending: v.pending, branch: v.branch }),
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('wf_start must be called from a conversation')
      const cwd = agent.session.header.cwd ?? process.cwd()
      // Started by /rdfoe-workflow: the user's own text and template win over the model's paraphrase.
      const typed = pendingStarts.get(agent.id)
      pendingStarts.delete(agent.id)
      const requirement = typed?.requirement ?? args.requirement ?? ''
      const title = typed ? requirement.split('\n')[0]!.slice(0, 40) : args.title ?? requirement.split('\n')[0]!.slice(0, 40)
      const template = typed?.template ?? (args.template === 'small' ? 'small' : 'full')
      const { run, created } = await service.startRun({ sessionId: agent.id, cwd, title, requirement, template })
      return card(store, service, run.id, created)
    },
  })
}

export function wfStatusTool(store: Store, service: WorkflowService) {
  return defineTool({
    name: 'wf_status',
    description: 'Report the status of the RDFOE workflow bound to the current conversation.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { bound: { type: 'boolean', required: true }, text: { type: 'string', required: true } } },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(_args, exec) {
      const run = exec.agent ? store.runBySession(exec.agent.id) : undefined
      if (!run) return { bound: false, text: '本会话还没有工作流。可以调用 wf_start 开启。' }
      const nodes = store.nodes(run.id).map(n => `${n.node_key}:${n.status}${n.current_version ? ` v${n.current_version}` : ''}`).join(' ')
      return { bound: true, text: `${describe(card(store, service, run.id, false))}\n节点：${nodes}\n实施⇄验收轮次：${run.loop_round}` }
    },
  })
}
