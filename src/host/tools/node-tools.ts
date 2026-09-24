/**
 * Controlled tools mounted only inside node subagents (§6.3). They are
 * registered through the node agent's scoped context, so the main session
 * never sees them. Every call is audited in `tool_call`, and every result
 * carries pending non-blocking user replies (§7.4 rule 1).
 */
import { exec as execShell } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { git } from '../git/git.ts'
import { CHECK_ROLES, type Role } from '../workflow/template.ts'
import { relPosix, resolveInside, safeEditFile, safeWriteFile } from './path-guard.ts'

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
  /** When set, wf_write / wf_edit may touch only these workspace-relative files (Y, DR, A). */
  writeScope?: string[]
  agentSessionId(): string | undefined
  audit(tool: string, args: unknown, affected: string[], exitCode: number | null, startedAt: number): void
  /** Pending non-blocking replies for this agent, marked delivered. */
  takeReplies(): string[]
  ask(questions: AskQuestion[], blocking: boolean, signal: AbortSignal): Promise<string>
  message(text: string, level: string, expectReply: boolean): Promise<string>
  report(report: NodeReport): void
  limits: { maxWriteBytes: number, execTimeoutMs: number, execOutputBytes: number }
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

// ── read-side tools (all roles) ─────────────────────────────────────────────

export function wfRead(env: ToolEnv) {
  return defineTool({
    name: 'wf_read',
    description: 'Read a UTF-8 text file in the workflow workspace. Paths are relative to the workspace root.',
    parameters: {
      path: { type: 'string', required: true, description: 'File path relative to the workspace root' },
      offset: { type: 'integer', description: '1-based first line (optional)' },
      limit: { type: 'integer', description: 'Maximum number of lines (optional)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true }, userReplies: repliesSchema } },
      render: (_a, v) => [{ type: 'text', text: v.content }, ...renderReplies(v)],
    },
    async execute(args, exec) {
      return audited(env, 'wf_read', args, async () => {
        const target = await resolveInside(env.root, args.path, 'read')
        let content = await readFile(target, { encoding: 'utf8', signal: exec.signal })
        if (args.offset !== undefined || args.limit !== undefined) {
          const lines = content.split('\n')
          const start = Math.max(1, args.offset ?? 1)
          content = lines.slice(start - 1, args.limit === undefined ? undefined : start - 1 + args.limit).join('\n')
        }
        return { value: { content, ...withReplies(env) }, affected: [relPosix(env.root, target)] }
      })
    },
  })
}

const LIST_LIMIT = 500

export function wfList(env: ToolEnv) {
  return defineTool({
    name: 'wf_list',
    description: 'List a directory in the workflow workspace (directories end with "/"). Set recursive to walk subdirectories (skips .git and node_modules).',
    parameters: {
      path: { type: 'string', description: 'Directory relative to the workspace root (default ".")' },
      recursive: { type: 'boolean', description: 'Walk subdirectories' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { entries: { type: 'array', required: true, items: { type: 'string' } }, truncated: { type: 'boolean', required: true }, userReplies: repliesSchema } },
      render: (_a, v) => [{ type: 'text', text: v.entries.join('\n') + (v.truncated ? '\n…(truncated)' : '') }, ...renderReplies(v)],
    },
    async execute(args) {
      return audited(env, 'wf_list', args, async () => {
        const base = await resolveInside(env.root, args.path ?? '.', 'read')
        const entries: string[] = []
        const walk = async (dir: string): Promise<void> => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (entries.length >= LIST_LIMIT) return
            if (entry.name === '.git' || entry.name === 'node_modules') continue
            const abs = join(dir, entry.name)
            const rel = relPosix(env.root, abs)
            if (entry.isDirectory()) {
              entries.push(`${rel}/`)
              if (args.recursive) await walk(abs)
            } else {
              entries.push(rel)
            }
          }
        }
        await walk(base)
        return { value: { entries, truncated: entries.length >= LIST_LIMIT, ...withReplies(env) } }
      })
    },
  })
}

export function wfSearch(env: ToolEnv) {
  return defineTool({
    name: 'wf_search',
    description: 'Search file contents in the workflow workspace with a JavaScript regular expression. Returns up to 200 "path:line: text" matches.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regular expression' },
      path: { type: 'string', description: 'Directory to search (default ".")' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { matches: { type: 'array', required: true, items: { type: 'string' } }, userReplies: repliesSchema } },
      render: (_a, v) => [{ type: 'text', text: v.matches.length ? v.matches.join('\n') : '(no matches)' }, ...renderReplies(v)],
    },
    async execute(args) {
      return audited(env, 'wf_search', args, async () => {
        const regex = new RegExp(args.pattern)
        const base = await resolveInside(env.root, args.path ?? '.', 'read')
        const matches: string[] = []
        const walk = async (dir: string): Promise<void> => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (matches.length >= 200) return
            if (entry.name === '.git' || entry.name === 'node_modules') continue
            const abs = join(dir, entry.name)
            if (entry.isDirectory()) { await walk(abs); continue }
            if (!entry.isFile() || (await stat(abs)).size > 1024 * 1024) continue
            const lines = (await readFile(abs, 'utf8')).split('\n')
            lines.forEach((line, i) => { if (matches.length < 200 && regex.test(line)) matches.push(`${relPosix(env.root, abs)}:${i + 1}: ${line.slice(0, 300)}`) })
          }
        }
        await walk(base)
        return { value: { matches, ...withReplies(env) } }
      })
    },
  })
}

// ── write-side tools ────────────────────────────────────────────────────────

/**
 * Writes stay inside the run workspace and out of .git. Roles are constrained
 * by their tool set and persona; a role with a write scope (Y, DR, A) is
 * also refused any path outside it.
 */
async function approveWrite(env: ToolEnv, path: string): Promise<string> {
  const target = await resolveInside(env.root, path, 'write')
  if (env.writeScope && !env.writeScope.includes(relPosix(env.root, target))) {
    throw new Error(`${relPosix(env.root, target)} is outside what this node may write: ${env.writeScope.join(', ')}`)
  }
  return target
}

export function wfWrite(env: ToolEnv) {
  return defineTool({
    name: 'wf_write',
    description: 'Create or overwrite a UTF-8 text file in the workflow workspace. Paths are relative to the workspace root; your role limits which paths you may write.',
    parameters: {
      path: { type: 'string', required: true, description: 'File path relative to the workspace root' },
      content: { type: 'string', required: true, description: 'Full file content' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, bytes: { type: 'integer', required: true }, userReplies: repliesSchema } },
      render: (_a, v) => [{ type: 'text', text: `wrote ${v.bytes} bytes to ${v.path}` }, ...renderReplies(v)],
    },
    async execute(args) {
      return audited(env, 'wf_write', { path: args.path, bytes: args.content.length }, async () => {
        const bytes = Buffer.byteLength(args.content, 'utf8')
        if (bytes > env.limits.maxWriteBytes) throw new Error(`content exceeds ${env.limits.maxWriteBytes} bytes`)
        const target = await approveWrite(env, args.path)
        await safeWriteFile(env.root, target, args.content)
        const rel = relPosix(env.root, target)
        return { value: { path: rel, bytes, ...withReplies(env) }, affected: [rel] }
      })
    },
  })
}

export function wfEdit(env: ToolEnv) {
  return defineTool({
    name: 'wf_edit',
    description: 'Replace exact text in an existing file. old_text must occur exactly once unless replace_all is true.',
    parameters: {
      path: { type: 'string', required: true, description: 'File path relative to the workspace root' },
      old_text: { type: 'string', required: true, description: 'Exact text to replace' },
      new_text: { type: 'string', required: true, description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, replacements: { type: 'integer', required: true }, userReplies: repliesSchema } },
      render: (_a, v) => [{ type: 'text', text: `edited ${v.path} (${v.replacements} replacement(s))` }, ...renderReplies(v)],
    },
    async execute(args) {
      return audited(env, 'wf_edit', { path: args.path }, async () => {
        const target = await approveWrite(env, args.path)
        let count = 0
        await safeEditFile(env.root, target, (current) => {
          count = current.split(args.old_text).length - 1
          if (count === 0) throw new Error('old_text not found')
          if (count > 1 && !args.replace_all) throw new Error(`old_text occurs ${count} times; pass replace_all or add context`)
          const updated = current.split(args.old_text).join(args.new_text)
          if (Buffer.byteLength(updated, 'utf8') > env.limits.maxWriteBytes) throw new Error(`result exceeds ${env.limits.maxWriteBytes} bytes`)
          return updated
        })
        const rel = relPosix(env.root, target)
        return { value: { path: rel, replacements: args.replace_all ? count : 1, ...withReplies(env) }, affected: [rel] }
      })
    },
  })
}

// ── execution ──────────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `…(${text.length - max} bytes truncated)…\n${text.slice(-max)}`
}

export function wfExec(env: ToolEnv) {
  return defineTool({
    name: 'wf_exec',
    description: 'Run a shell command in the workflow workspace (cwd is the workspace root), e.g. "npm test" or "go test ./... 2>&1 | tail -50". Use it for builds, tests, linters, inspection and dependency installs. Long-running servers are not supported: the command must finish (default timeout 10 minutes). Output is truncated to the tail.',
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command line' },
      reason: { type: 'string', description: 'Why you run it (shown in the workflow view)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { type: 'integer', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          timedOut: { type: 'boolean', required: true },
          durationMs: { type: 'integer', required: true },
          userReplies: repliesSchema,
        },
      },
      render: (a, v) => [{ type: 'text', text: `$ ${a.command}\nexit ${v.exitCode}${v.timedOut ? ' (timed out)' : ''} · ${v.durationMs}ms\n--- stdout ---\n${v.stdout}\n--- stderr ---\n${v.stderr}` }, ...renderReplies(v)],
    },
    async execute(args, exec) {
      const started = Date.now()
      const result = await new Promise<{ exitCode: number, stdout: string, stderr: string, timedOut: boolean }>((resolve) => {
        execShell(args.command, {
          cwd: env.root,
          timeout: env.limits.execTimeoutMs,
          maxBuffer: 64 * 1024 * 1024,
          signal: exec.signal,
          env: { ...process.env, CI: '1', RDFOE_WORKFLOW: env.runId },
        }, (error, stdout, stderr) => {
          const err = error as (NodeJS.ErrnoException & { killed?: boolean, signal?: string }) | null
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
          resolve({ exitCode: code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut: Boolean(err?.killed && err.signal === 'SIGTERM') })
        })
      })
      env.audit('wf_exec', args.command, [], result.exitCode, started)
      return {
        exitCode: result.exitCode,
        stdout: truncate(result.stdout, env.limits.execOutputBytes),
        stderr: truncate(result.stderr, env.limits.execOutputBytes),
        timedOut: result.timedOut,
        durationMs: Date.now() - started,
        ...withReplies(env),
      }
    },
  })
}

export function wfGit(env: ToolEnv) {
  return defineTool({
    name: 'wf_git',
    description: 'Read-only git inspection of the workflow branch: status, diff (working tree or against the run base), or log. You cannot commit; the workflow commits for you.',
    parameters: {
      action: { type: 'string', enum: ['status', 'diff', 'log'], required: true, description: 'status | diff | log' },
      path: { type: 'string', description: 'Limit diff to a path' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { output: { type: 'string', required: true }, userReplies: repliesSchema } },
      render: (_a, v) => [{ type: 'text', text: v.output || '(empty)' }, ...renderReplies(v)],
    },
    async execute(args, exec) {
      return audited(env, 'wf_git', args, async () => {
        const pathArgs = args.path ? ['--', relPosix(env.root, await resolveInside(env.root, args.path, 'read'))] : []
        const argv = args.action === 'status' ? ['status', '--short']
          : args.action === 'log' ? ['log', '--oneline', '-n', '30']
            : ['diff', 'HEAD', ...pathArgs]
        const r = await git(env.root, argv, { signal: exec.signal })
        return { value: { output: truncate(r.code === 0 ? r.stdout : r.stderr, env.limits.execOutputBytes), ...withReplies(env) }, exitCode: r.code }
      })
    },
  })
}

// ── human channel ───────────────────────────────────────────────────────────

export function wfAsk(env: ToolEnv) {
  return defineTool({
    name: 'wf_ask',
    description: 'Ask the user one or more questions through the workflow inbox. Only ask when a real ambiguity would change the result. By default the call blocks until the user answers; with blocking=false you continue on your own assumption and the answer arrives later with another wf_* tool result.',
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
    description: 'Send the user a non-blocking message (progress, risk, or a decision they should know about). Set expectReply when you want an answer; it will arrive with a later wf_* tool result. Do not use this for questions that block your work (use wf_ask).',
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
      env.report(args)
      env.audit('wf_report', digest({ summary: args.summary.slice(0, 80), verdict: args.verdict, blocked: args.blocked }), args.artifacts, 0, Date.now())
      return { accepted: true, ...withReplies(env) }
    },
  })
}

/** The tool set per role (§6.3 table, §17). Scoped roles (DR, Y, A) also carry a writeScope. */
export function toolsFor(env: ToolEnv) {
  const read = [wfRead(env), wfList(env), wfSearch(env)]
  const human = [wfAsk(env), wfMessage(env), wfReport(env)]
  switch (env.role) {
    case 'R':
    case 'C':
    case 'D':
    case 'T':
    case 'V':
    case 'S':
      return [...read, wfWrite(env), wfEdit(env), ...human]
    case 'X':
      return [...read, wfWrite(env), wfEdit(env), wfExec(env), wfGit(env), ...human]
    case 'Y':
      // Writes are scoped to its verification.md and the tasks.md it appends fix tasks to.
      return [...read, wfWrite(env), wfEdit(env), wfExec(env), wfGit(env), ...human]
    case 'DR':
      return [...read, wfWrite(env), wfReport(env)]
    case 'A':
      return [...read, wfWrite(env), wfGit(env), wfMessage(env), wfReport(env)]
  }
}
