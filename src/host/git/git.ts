/**
 * Git operations owned by the orchestrator (§6.2 / decision 3): worktree per
 * run, commits after each approval, each X/Y round, a blocked design review
 * and the archive. Never push, never merge. Everything runs through execFile (no shell).
 */
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface GitResult { code: number, stdout: string, stderr: string }

export function git(cwd: string, args: string[], options: { signal?: AbortSignal, maxBuffer?: number } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024, signal: options.signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

async function ok(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`)
  return r.stdout.trim()
}

/** The repository top level when `dir` is inside a git work tree with at least one commit. */
export async function repoRoot(dir: string): Promise<string | undefined> {
  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) return undefined
  const head = await git(dir, ['rev-parse', '--verify', 'HEAD'])
  return head.code === 0 ? top.stdout.trim() : undefined
}

/** Create `rdfoe/<runId>` at the current HEAD and check it out into `worktreePath`. */
export async function createWorktree(repo: string, worktreePath: string, branch: string): Promise<{ baseRef: string }> {
  const baseRef = await ok(repo, ['rev-parse', 'HEAD'])
  await mkdir(dirname(worktreePath), { recursive: true })
  await ok(repo, ['worktree', 'add', '-b', branch, worktreePath, baseRef])
  return { baseRef }
}

/**
 * Stage everything and commit when there is something to commit. Uses the
 * repository's configured identity and falls back to a plugin identity only
 * when none is configured.
 * @returns the new commit sha, or undefined when the tree was clean.
 */
export async function commitAll(worktree: string, message: string): Promise<string | undefined> {
  await ok(worktree, ['add', '-A'])
  const status = await ok(worktree, ['status', '--porcelain'])
  if (status === '') return undefined
  let result = await git(worktree, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message])
  if (result.code !== 0 && /user\.(email|name)|identity/i.test(result.stderr)) {
    result = await git(worktree, ['-c', 'user.name=RDFOE Workflow', '-c', 'user.email=rdfoe-workflow@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message])
  }
  if (result.code !== 0) throw new Error(`git commit failed: ${result.stderr.trim()}`)
  return ok(worktree, ['rev-parse', 'HEAD'])
}

export async function diffSinceBase(worktree: string, baseRef: string, maxBytes = 200_000): Promise<string> {
  const r = await git(worktree, ['diff', `${baseRef}...HEAD`, '--stat', '--patch', '--', '.', ':(exclude).rdfoe'])
  return r.stdout.length > maxBytes ? `${r.stdout.slice(0, maxBytes)}\n…(truncated)` : r.stdout
}

export async function branchLog(worktree: string, baseRef: string): Promise<string[]> {
  const r = await git(worktree, ['log', '--format=%h %s', `${baseRef}..HEAD`])
  return r.stdout.trim() === '' ? [] : r.stdout.trim().split('\n')
}
