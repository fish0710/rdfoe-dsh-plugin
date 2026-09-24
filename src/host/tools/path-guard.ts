/**
 * Path confinement for the controlled node tools (§6.3). These tools run in
 * the DSH Host process outside any workspace sandbox, so every path the model
 * supplies is resolved here and must stay inside the node's root after
 * symlinks are followed. Writes additionally close the check-then-write
 * window: parents are created component by component refusing symlinks, the
 * file is opened by its canonical parent with O_NOFOLLOW, hard links are
 * refused, and the parent identity is re-checked after the open.
 */
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathEscapeError'
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Workspace-relative POSIX form of a lexical path already proven inside root. */
export function relPosix(root: string, abs: string): string {
  return relative(resolve(root), abs).split(sep).join('/')
}

/**
 * Resolve `input` against `root` and prove the result stays inside it.
 *
 * - relative or absolute input is accepted, but the lexical result must be
 *   inside `root` (rejects `../` and foreign absolute paths);
 * - the deepest existing ancestor (the target itself when it exists) is
 *   canonicalized with realpath and must be inside realpath(root), which
 *   rejects symlink escapes at any depth;
 * - `mode: 'write'` also rejects `.git` segments, dangling symlinks and
 *   writing through a symlink at the final component.
 * @returns the absolute lexical path to operate on.
 */
export async function resolveInside(root: string, input: string, mode: 'read' | 'write'): Promise<string> {
  if (input.length === 0) throw new PathEscapeError('path must be non-empty')
  if (input.includes('\0')) throw new PathEscapeError('path must not contain NUL')
  const realRoot = await realpath(root)
  const lexical = resolve(root, input)
  if (!inside(resolve(root), lexical)) throw new PathEscapeError(`path escapes the workspace: ${input}`)
  const rel = relative(resolve(root), lexical)
  if (mode === 'write' && rel.split(sep).includes('.git')) {
    throw new PathEscapeError(`writes under .git are not allowed: ${input}`)
  }

  let probe = lexical
  while (true) {
    try {
      const st = await lstat(probe)
      if (mode === 'write' && probe === lexical && st.isSymbolicLink()) {
        throw new PathEscapeError(`refusing to write through a symlink: ${input}`)
      }
      const canonical = await realpath(probe)
      if (!inside(realRoot, canonical)) throw new PathEscapeError(`path resolves outside the workspace: ${input}`)
      return lexical
    } catch (error) {
      if (error instanceof PathEscapeError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        // A dangling symlink: lstat succeeds but realpath fails with ENOENT.
        try {
          if ((await lstat(probe)).isSymbolicLink()) throw new PathEscapeError(`dangling symlink in path: ${input}`)
        } catch (inner) {
          if (inner instanceof PathEscapeError) throw inner
        }
      } else if (code !== 'ENOTDIR') {
        throw error
      }
      const parent = resolve(probe, '..')
      if (parent === probe) throw new PathEscapeError(`no existing ancestor for: ${input}`)
      probe = parent
    }
  }
}

/** Create the parent directories of `abs` below `root`, refusing any symlink component. */
async function mkdirNoFollow(root: string, abs: string): Promise<void> {
  const parts = relative(resolve(root), dirname(abs)).split(sep).filter(p => p !== '')
  let current = resolve(root)
  for (const part of parts) {
    current = join(current, part)
    try {
      const st = await lstat(current)
      if (st.isSymbolicLink()) throw new PathEscapeError(`symlink in parent path: ${relPosix(root, current)}`)
      if (!st.isDirectory()) throw new PathEscapeError(`not a directory: ${relPosix(root, current)}`)
    } catch (error) {
      if (error instanceof PathEscapeError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(current)
    }
  }
}

/** Open an existing or new regular file for writing without following links. */
async function openForWrite(root: string, abs: string, create: boolean) {
  const realRoot = await realpath(root)
  const realParent = await realpath(dirname(abs))
  if (!inside(realRoot, realParent)) throw new PathEscapeError(`parent resolves outside the workspace: ${relPosix(root, abs)}`)
  const parentBefore = await stat(realParent)
  const flags = constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0)
  let handle
  try {
    handle = await open(join(realParent, basename(abs)), flags, 0o644)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new PathEscapeError(`refusing to write through a symlink: ${relPosix(root, abs)}`)
    throw error
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) throw new PathEscapeError(`not a regular file: ${relPosix(root, abs)}`)
    if (st.nlink > 1) throw new PathEscapeError(`refusing to write a hard-linked file: ${relPosix(root, abs)}`)
    const parentAfter = await stat(realParent)
    if (parentAfter.ino !== parentBefore.ino || parentAfter.dev !== parentBefore.dev) {
      throw new PathEscapeError(`parent directory changed during write: ${relPosix(root, abs)}`)
    }
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** Write `content` to a path already approved by resolveInside(…, 'write'). */
export async function safeWriteFile(root: string, abs: string, content: string): Promise<void> {
  await mkdirNoFollow(root, abs)
  const handle = await openForWrite(root, abs, true)
  try {
    await handle.truncate(0)
    await handle.write(content, 0, 'utf8')
  } finally {
    await handle.close()
  }
}

/** Read-modify-write on one descriptor; `edit` returns the new content or throws. */
export async function safeEditFile(root: string, abs: string, edit: (current: string) => string): Promise<void> {
  const handle = await openForWrite(root, abs, false)
  try {
    const current = await handle.readFile({ encoding: 'utf8' })
    const updated = edit(current)
    await handle.truncate(0)
    await handle.write(updated, 0, 'utf8')
  } finally {
    await handle.close()
  }
}
