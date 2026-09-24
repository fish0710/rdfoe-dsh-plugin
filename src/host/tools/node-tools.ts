/**
 * Workflow tools of node subagents (§6.3). A node agent joins DSH's own agent
 * preset (read, write, edit, glob, grep, bash, web, skills, …) and gets only
 * the flow tools here on top: wf_ask / wf_message (the inbox) and wf_report
 * (the structured result that drives the state machine). They are registered
 * through the node agent's scoped context, so the main session never sees
 * them. The native calls pass `guardNativeCall` first; every call, native or
 * not, is audited in `tool_call`; flow-tool results also carry pending
 * non-blocking user replies (§7.4 rule 1), which otherwise arrive as steering.
 */
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CHECK_ROLES, type Role } from '../workflow/template.ts'
import { relPosix, resolveInside } from './path-guard.ts'

export interface AskQuestion {
  id?: string
  header?: string
  question: string
  detail?: string
  options?: { label: string, description?: string }[]
  multiSelect?: boolean
}

export interface NodeReport {
  summary: string
  artifacts: string[]
  openIssues: string[]
  confidence: number
  verdict?: 'pass' | 'fail'
  items?: { id: string, result: 'pass' | 'fail', evidence: string }[]
  /** C only: blocking decisions remain (the node becomes BLOCKED). */
  blocked?: boolean
}

/** Everything a node tool needs; implemented by the WorkflowService per agent. */
export interface ToolEnv {
  runId: string
  nodeId: string
  role: Role
  version: number
  round: number
  /** The run worktree (or project dir for non-git runs). */
  root: string
  /** Workspace-relative files that must exist before wf_report is accepted. */
  required?: string[]
  /** When set, the node may change only these workspace-relative files (Y, DR, A). */
  writeScope?: string[]
  /** Scoped roles in git runs: workspace paths changed since the agent started that lie outside writeScope. */
  outOfScope?(): Promise<string[]>
  agentSessionId(): string | undefined
  audit(tool: string, args: unknown, affected: string[], exitCode: number | null, startedAt: number): void
  /** Pending non-blocking replies for this agent, marked delivered. */
  takeReplies(): string[]
  ask(questions: AskQuestion[], blocking: boolean, signal: AbortSignal): Promise<string>
  message(text: string, level: string, expectReply: boolean): Promise<string>
  report(report: NodeReport): void
}

const withReplies = (env: ToolEnv) => {
  const replies = env.takeReplies()
  return replies.length > 0 ? { userReplies: replies } : {}
}

const repliesSchema = { type: 'array', items: { type: 'string' } } as const

function renderReplies(value: { userReplies?: string[] }): { type: 'text', text: string }[] {
  return value.userReplies && value.userReplies.length > 0
    ? [{ type: 'text', text: `\n\n【用户的新回复】\n${value.userReplies.map(r => `- ${r}`).join('\n')}` }]
    : []
}

const digest = (args: unknown) => {
  const json = JSON.stringify(args)
  return json.length > 300 ? `${json.slice(0, 300)}…#${createHash('sha1').update(json).digest('hex').slice(0, 8)}` : json
}

async function audited<T>(env: ToolEnv, tool: string, args: unknown, fn: () => Promise<{ value: T, affected?: string[], exitCode?: number | null }>): Promise<T> {
  const started = Date.now()
  try {
    const { value, affected = [], exitCode = 0 } = await fn()
    env.audit(tool, digest(args), affected, exitCode, started)
    return value
  } catch (error) {
    env.audit(tool, digest(args), [], -1, started)
    throw error
  }
}

// ── native tools: guard and audit ─────────────────────────────────────────────

/**
 * DSH tools a node never gets: questions go through wf_ask (the inbox), and
 * goals and plan mode would take the turn away from the workflow.
 */
export const NATIVE_DENY = ['ask_user_question', 'create_goal', 'update_goal', 'get_goal', 'exit_plan_mode'] as const

/** Native file tools whose `file_path` the guard checks. */
const FILE_WRITERS = new Set(['write', 'edit'])

/** Git commands that rewrite the run branch; the workflow owns commits (restore/checkout of files stays allowed). */
const GIT_OWNED = /(^|[;&|(\s])git\s+(?:-\S+(?:\s+[^-\s]\S*)?\s+)*(commit|push|merge|rebase|reset|switch|tag|cherry-pick|revert|am|worktree)\b/

/**
 * Pre-dispatch check for one native tool call of a node agent. DSH's sandbox
 * and the worktree cwd bound the agent as a whole; this adds the node's own
 * limits: writes stay inside the workspace and out of .git, a scoped role
 * (Y, DR, A) writes only its files, and nobody commits or moves the branch.
 * @returns the denial reason, or undefined to let the call run.
 */
export async function guardNativeCall(env: Pick<ToolEnv, 'root' | 'writeScope'>, name: string, args: unknown): Promise<string | undefined> {
  const input = (args ?? {}) as Record<string, unknown>
  if (FILE_WRITERS.has(name) && typeof input.file_path === 'string') {
    let rel: string
    try {
      rel = relPosix(env.root, await resolveInside(env.root, input.file_path, 'write'))
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    if (env.writeScope && !env.writeScope.includes(rel)) return `${rel} is outside what this node may write: ${env.writeScope.join(', ')}`
  }
  if (name === 'bash' && typeof input.command === 'string' && GIT_OWNED.test(input.command)) {
    return 'the workflow owns commits and the run branch; do not commit, reset, switch or push. Leave your changes in the working tree.'
  }
  return undefined
}

/** Audit row fields for a finished native call. */
export function nativeAudit(name: string, args: unknown, result: { isError: boolean, value?: unknown }): { digest: string, affected: string[], exitCode: number | null } {
  const input = (args ?? {}) as Record<string, unknown>
  const affected = typeof input.file_path === 'string' ? [input.file_path] : []
  if (name === 'bash') {
    const value = (result.value ?? {}) as { exitCode?: number | null }
    return { digest: String(input.command ?? ''), affected, exitCode: result.isError ? -1 : typeof value.exitCode === 'number' ? value.exitCode : null }
  }
  const shown = name === 'write' ? { file_path: input.file_path, bytes: typeof input.content === 'string' ? input.content.length : undefined } : input
  return { digest: digest(shown), affected, exitCode: result.isError ? -1 : 0 }
}

// ── human channel ───────────────────────────────────────────────────────────

export function wfAsk(env: ToolEnv) {
  return defineTool({
    name: 'wf_ask',
    description: 'Ask the user one or more questions through the workflow inbox. Only ask when a real ambiguity would change the result. By default the call blocks until the user answers; with blocking=false you continue on your own assumption and the answer arrives later as a user message. Use this instead of any other way of asking the user.',
    parameters: {
      questions: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            header: { type: 'string', description: 'Short label' },
            question: { type: 'string', required: true },
            detail: { type: 'string' },
            options: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string', required: true }, description: { type: 'string' } } } },
            multiSelect: { type: 'boolean' },
          },
        },
      },
      blocking: { type: 'boolean', description: 'Wait for the answer (default true)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { answer: { type: 'string', required: true }, userReplies: repliesSchema } },
      render: (_a, v) => [{ type: 'text', text: v.answer }, ...renderReplies(v)],
    },
    async execute(args, exec) {
      if (args.questions.length === 0) throw new Error('questions must be non-empty')
      return audited(env, 'wf_ask', { question: args.questions.map(q => q.question).join(' / '), blocking: args.blocking !== false }, async () => {
        const answer = await env.ask(args.questions as AskQuestion[], args.blocking !== false, exec.signal)
        return { value: { answer, ...withReplies(env) } }
      })
    },
  })
}

export function wfMessage(env: ToolEnv) {
  return defineTool({
    name: 'wf_message',
    description: 'Send the user a non-blocking message (progress, risk, or a decision they should know about). Set expectReply when you want an answer; it will arrive later as a user message. Do not use this for questions that block your work (use wf_ask).',
    parameters: {
      text: { type: 'string', required: true },
      level: { type: 'string', enum: ['info', 'risk', 'decision'], description: 'info | risk | decision' },
      expectReply: { type: 'boolean' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, userReplies: repliesSchema } },
      render: (_a, v) => [{ type: 'text', text: `message ${v.id} delivered to the user's inbox` }, ...renderReplies(v)],
    },
    async execute(args) {
      return audited(env, 'wf_message', { text: args.text.slice(0, 120) }, async () => {
        const id = await env.message(args.text, args.level ?? 'info', args.expectReply === true)
        return { value: { id, ...withReplies(env) } }
      })
    },
  })
}

// ── structured result ───────────────────────────────────────────────────────

export function wfReport(env: ToolEnv) {
  const isCheck = CHECK_ROLES.includes(env.role)
  const isClarify = env.role === 'C'
  return defineTool({
    name: 'wf_report',
    description: isCheck
      ? 'Submit your structured check result. Call exactly once at the end, after writing your file(s). verdict must be "fail" if any item fails; every item needs concrete evidence (command output, file and line, observed behaviour).'
      : isClarify
        ? 'Submit your structured result. Call exactly once at the end, after writing requirement.md. Set blocked=true when blocking decisions remain unresolved (list them in openIssues).'
        : 'Submit your structured result. Call exactly once at the end, after writing your artifact file(s).',
    parameters: {
      summary: { type: 'string', required: true },
      artifacts: { type: 'array', required: true, items: { type: 'string' }, description: 'Workspace-relative paths you produced' },
      openIssues: { type: 'array', required: true, items: { type: 'string' }, description: 'Doubts, assumptions and risks the reviewer must look at' },
      confidence: { type: 'number', required: true, description: '0..1' },
      ...(isCheck ? {
        verdict: { type: 'string', enum: ['pass', 'fail'], required: true },
        items: {
          type: 'array',
          required: true,
          items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, result: { type: 'string', enum: ['pass', 'fail'], required: true }, evidence: { type: 'string', required: true } } },
        },
      } : {}),
      ...(isClarify ? { blocked: { type: 'boolean', required: true, description: 'true when blocking decisions remain' } } : {}),
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { accepted: { type: 'boolean', required: true }, userReplies: repliesSchema } },
      render: (_a, v) => [{ type: 'text', text: 'report accepted; you are done — end your turn with a one-line summary.' }, ...renderReplies(v)],
    },
    async execute(rawArgs) {
      // Arguments are frozen by the registry; work on a copy.
      const args = structuredClone(rawArgs) as unknown as NodeReport
      if (!(args.confidence >= 0 && args.confidence <= 1)) throw new Error('confidence must be between 0 and 1')
      for (const required of env.required ?? []) {
        const exists = await stat(join(env.root, required)).then(s => s.isFile(), () => false)
        if (!exists) throw new Error(`write ${required} before reporting`)
        if (!args.artifacts.includes(required)) args.artifacts = [...args.artifacts, required]
      }
      if (isCheck) {
        if (!args.items || args.items.length === 0) throw new Error('items must list every check or finding')
        const blank = args.items.find(i => i.evidence.trim().length < 5)
        if (blank) throw new Error(`item ${blank.id} has no real evidence`)
        const anyFail = args.items.some(i => i.result === 'fail')
        if (anyFail && args.verdict === 'pass') throw new Error('verdict must be "fail" when any item fails')
        if (!anyFail && args.verdict === 'fail') throw new Error('verdict "fail" requires at least one failing item')
      }
      if (isClarify && args.blocked && args.openIssues.length === 0) throw new Error('blocked=true needs the blocking decisions in openIssues')
      const outside = (await env.outOfScope?.()) ?? []
      if (outside.length > 0) throw new Error(`you changed files this node may not change: ${outside.join(', ')}. Restore them (for example git restore -- <path>, or delete a file you created) and report again; you may change only ${env.writeScope?.join(', ')}`)
      env.report(args)
      env.audit('wf_report', digest({ summary: args.summary.slice(0, 80), verdict: args.verdict, blocked: args.blocked }), args.artifacts, 0, Date.now())
      return { accepted: true, ...withReplies(env) }
    },
  })
}

/** The flow tools per role; the native ones come from DSH's agent preset. DR and A do not talk to the user. */
export function toolsFor(env: ToolEnv) {
  switch (env.role) {
    case 'DR':
      return [wfReport(env)]
    case 'A':
      return [wfMessage(env), wfReport(env)]
    default:
      return [wfAsk(env), wfMessage(env), wfReport(env)]
  }
}
