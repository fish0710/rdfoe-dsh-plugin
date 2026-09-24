/**
 * `/rdfoe-workflow [--small] <需求>`: a DSH human command (`ctx.commands`, present in
 * 0.1.5 and 0.1.7). It does not start the run itself: it submits one real
 * user message (`agent.followup`) asking the model to call wf_start once, so
 * the session gets an ordinary turn — user message, wf_start card, a short
 * reply, and DSH's own title — and stays in DSH's session list. The
 * requirement and template the user typed are parked in `pendingStarts`;
 * wf_start takes them from there instead of the model's paraphrase. A session
 * that already has a run gets its status, and a start already on its way is
 * not submitted twice.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Store } from '../store/store.ts'
import { NODE_LABEL, templateOf, type NodeKey, type StartTemplateId } from '../workflow/template.ts'
import type { WorkflowService } from '../workflow/service.ts'

export const COMMAND_NAME = 'rdfoe-workflow'
export const COMMAND_DESCRIPTION = '用 RDFOE 工作流实现需求：/rdfoe-workflow [--small] <需求>'
export const COMMAND_HINT = '[--small] <需求>'

const STATUS_LABEL: Record<string, string> = { CREATED: '已创建', RUNNING: '运行中', PAUSED: '已暂停', INTERRUPTED: '已中断', COMPLETED: '已完成', FAILED: '失败', CANCELLED: '已取消', ORPHANED: '只读' }

export const USAGE = [
  '本会话还没有工作流。用法：/rdfoe-workflow [--small] <需求>。',
  '例如：/rdfoe-workflow 给 utils 增加一个 slugify 函数，并补上单元测试。',
  '默认走完整流程：需求录入 → 需求澄清 → 设计 ⇄ 设计审查 → 设计批准 → 任务规划 → 验证计划 → 授权实施 → 实施 ⇄ 验证 → 用户验收 → 归档。',
  '范围局部、预期明确的小改动加 --small：/rdfoe-workflow --small 修正登录按钮的提示文案。流程为小改动 → 授权实施 → 实施 ⇄ 验证 → 用户验收 → 归档。',
  '在 git 仓库里会新建 worktree 与分支 rdfoe/<runId>。',
].join('\n')

/** Structural subset of `@deepseek-ai/dsh-commands` CommandResult. */
export type CommandResult = { kind: 'success', text?: string } | { kind: 'error', text: string }

type Service = Pick<WorkflowService, 'pendingCount'>

/** Requirement and template the command handed to the model, per session, until wf_start consumes them. */
export const pendingStarts = new Map<string, { requirement: string, template: StartTemplateId }>()

const TEMPLATE_TEXT: Record<StartTemplateId, string> = { full: '完整流程', small: '小改动流程' }

/**
 * The user message the command submits. Human-readable (it shows in the
 * conversation), led by the requirement so DSH's fallback and generated
 * titles name it, and explicit enough for a small model: one wf_start call
 * with the template, then one sentence.
 */
export function startPrompt(requirement: string, template: StartTemplateId): string {
  return `【工作流】${requirement}\n\n（用 RDFOE 工作流实现上面的需求，${TEMPLATE_TEXT[template]}：请只调用一次 wf_start，template 传 "${template}"，requirement 传上面的需求原文；不要自己实现需求。调用后用一句话告诉我工作流已启动。）`
}

const START_PROMPT = /^【工作流】([\s\S]*)\n\n（用 RDFOE 工作流实现上面的需求，[^：]*：请只调用一次 wf_start，template 传 "(full|small)"/u

/** Inverse of startPrompt (the fake model mirrors it). */
export function parseStartPrompt(text: string): { requirement: string, template: StartTemplateId } | null {
  const match = START_PROMPT.exec(text)
  return match ? { requirement: match[1]!, template: match[2] as StartTemplateId } : null
}

function summary(store: Store, service: Service, runId: string, verb: string): string {
  const run = store.runById(runId)!
  const node = run.current_node ? NODE_LABEL[run.current_node as NodeKey] ?? run.current_node : ''
  return [
    `${verb}工作流 ${run.id} · ${STATUS_LABEL[run.status] ?? run.status}${node ? ` · 当前节点 ${node}` : ''} · 待处理 ${service.pendingCount(run.id)}${run.branch ? ` · 分支 ${run.branch}` : ''} · 流程 ${({ full: '完整', small: '小改动', legacy: '旧版' } as const)[templateOf(run).id]}`,
    `项目 ${run.project_path}。在本会话的「工作流」视图和侧边栏「收件箱」跟进。`,
  ].join('\n')
}

/** Split a leading `--small` / `--full` off the command input. */
export function parseCommandInput(rawInput: string): { template: StartTemplateId, requirement: string } {
  const text = rawInput.trim()
  const flag = /^--(small|full)(?=\s|$)/u.exec(text)
  return flag ? { template: flag[1] as StartTemplateId, requirement: text.slice(flag[0].length).trim() } : { template: 'full', requirement: text }
}

/**
 * Status for a bound session, usage without a requirement, otherwise park
 * the requirement and submit the start message once.
 * @param submit - posts the start message as the session's next user turn.
 */
export function runWorkflowCommand(
  store: Store,
  service: Service,
  input: { sessionId: string, cwd: string | undefined, rawInput: string },
  submit: (text: string) => void,
): CommandResult {
  const { template, requirement } = parseCommandInput(input.rawInput)
  const existing = store.runBySession(input.sessionId)
  if (existing) {
    const text = summary(store, service, existing.id, '本会话的')
    return { kind: 'success', text: requirement ? `${text}\n本会话已绑定工作流，这次输入的需求没有采用。` : text }
  }
  if (!requirement) return { kind: 'success', text: USAGE }
  if (!input.cwd) return { kind: 'error', text: '无法确定本会话的工作目录，工作流未开启。' }
  if (pendingStarts.has(input.sessionId)) return { kind: 'success', text: '本会话的工作流正在开启，请稍候。' }
  pendingStarts.set(input.sessionId, { requirement, template })
  submit(startPrompt(requirement, template))
  return { kind: 'success', text: `正在开启工作流（${TEMPLATE_TEXT[template]}）：需求已作为消息发给模型，由它调用 wf_start。` }
}

interface CommandAgent {
  id: string
  session: { header: { cwd?: string } }
  followup(message: ReturnType<typeof createUserMessage>): void
  whenIdle(): Promise<void>
}

interface CommandsLike {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler(invocation: { agent: CommandAgent, rawInput: string }): Promise<CommandResult>
  }): () => void
}

export function registerWorkflowCommand(commands: CommandsLike, store: Store, service: Service): () => void {
  return commands.register({
    name: COMMAND_NAME,
    description: COMMAND_DESCRIPTION,
    input: { hint: COMMAND_HINT },
    handler: async ({ agent, rawInput }) => runWorkflowCommand(store, service, { sessionId: agent.id, cwd: agent.session.header.cwd, rawInput }, (text) => {
      // After the handler settles, so `command/done` precedes the turn in the log.
      setTimeout(() => {
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        // A turn that ended without wf_start (model error, cancel) must not block the next attempt.
        void agent.whenIdle().finally(() => pendingStarts.delete(agent.id))
      }, 0)
    }),
  })
}
