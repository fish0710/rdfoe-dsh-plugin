import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PathEscapeError, resolveInside, safeEditFile, safeWriteFile } from '../src/host/tools/path-guard.ts'

describe('resolveInside', () => {
  let base: string
  let root: string
  let outside: string

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'rdfoe-guard-'))
    root = join(base, 'ws')
    outside = join(base, 'outside')
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(root, 'src', 'a.txt'), 'a')
    await writeFile(join(outside, 'secret.txt'), 's')
    await symlink(outside, join(root, 'link-out'))
    await symlink(join(outside, 'secret.txt'), join(root, 'file-link-out'))
    await symlink(join(root, 'src'), join(root, 'link-in'))
    await symlink(join(base, 'missing'), join(root, 'dangling'))
  })
  afterAll(async () => { await rm(base, { recursive: true, force: true }) })

  it('accepts normal relative paths for read and write', async () => {
    await expect(resolveInside(root, 'src/a.txt', 'read')).resolves.toBe(join(root, 'src', 'a.txt'))
    await expect(resolveInside(root, 'new/dir/file.md', 'write')).resolves.toBe(join(root, 'new', 'dir', 'file.md'))
    await expect(resolveInside(root, './src/../src/a.txt', 'read')).resolves.toBe(join(root, 'src', 'a.txt'))
  })

  it('accepts an absolute path that is inside the root', async () => {
    await expect(resolveInside(root, join(root, 'src', 'a.txt'), 'read')).resolves.toBe(join(root, 'src', 'a.txt'))
  })

  it.each(['../outside/secret.txt', 'src/../../outside/secret.txt', '..', '/etc/passwd'])('rejects lexical escape %s', async (p) => {
    await expect(resolveInside(root, p, 'read')).rejects.toBeInstanceOf(PathEscapeError)
    await expect(resolveInside(root, p, 'write')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('rejects symlink escapes through a directory link, for existing and new files', async () => {
    await expect(resolveInside(root, 'link-out/secret.txt', 'read')).rejects.toBeInstanceOf(PathEscapeError)
    await expect(resolveInside(root, 'link-out/new.txt', 'write')).rejects.toBeInstanceOf(PathEscapeError)
    await expect(resolveInside(root, 'link-out/deeper/new.txt', 'write')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('rejects a file symlink pointing outside', async () => {
    await expect(resolveInside(root, 'file-link-out', 'read')).rejects.toBeInstanceOf(PathEscapeError)
    await expect(resolveInside(root, 'file-link-out', 'write')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('rejects dangling symlinks', async () => {
    await expect(resolveInside(root, 'dangling', 'write')).rejects.toBeInstanceOf(PathEscapeError)
    await expect(resolveInside(root, 'dangling/x.txt', 'write')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('allows reading through an in-root symlink but not writing through the link itself', async () => {
    await expect(resolveInside(root, 'link-in/a.txt', 'read')).resolves.toBe(join(root, 'link-in', 'a.txt'))
    await expect(resolveInside(root, 'link-in', 'write')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('rejects writes under .git and empty or NUL paths', async () => {
    await expect(resolveInside(root, '.git/config', 'write')).rejects.toBeInstanceOf(PathEscapeError)
    await expect(resolveInside(root, 'sub/.git/hooks/x', 'write')).rejects.toBeInstanceOf(PathEscapeError)
    await expect(resolveInside(root, '', 'read')).rejects.toBeInstanceOf(PathEscapeError)
    await expect(resolveInside(root, 'a\0b', 'read')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('safeWriteFile creates parents and writes inside the root', async () => {
    const target = await resolveInside(root, 'deep/new/dir/f.txt', 'write')
    await safeWriteFile(root, target, 'hello')
    expect(await readFile(join(root, 'deep/new/dir/f.txt'), 'utf8')).toBe('hello')
    await safeEditFile(root, target, s => s.replace('hello', 'bye'))
    expect(await readFile(join(root, 'deep/new/dir/f.txt'), 'utf8')).toBe('bye')
  })

  it('safeWriteFile refuses a symlink swapped in after the check (O_NOFOLLOW)', async () => {
    const target = await resolveInside(root, 'swap.txt', 'write')
    // Simulate the race: the path was approved while absent, then a link appears.
    await symlink(join(outside, 'secret.txt'), join(root, 'swap.txt'))
    await expect(safeWriteFile(root, target, 'pwned')).rejects.toBeInstanceOf(PathEscapeError)
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('s')
  })

  it('safeWriteFile refuses a parent directory swapped for a symlink after the check', async () => {
    const target = await resolveInside(root, 'later/x.txt', 'write')
    await symlink(outside, join(root, 'later'))
    await expect(safeWriteFile(root, target, 'pwned')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('safeWriteFile refuses hard links to files outside the root', async () => {
    await link(join(outside, 'secret.txt'), join(root, 'hard.txt'))
    const target = await resolveInside(root, 'hard.txt', 'write')
    await expect(safeWriteFile(root, target, 'pwned')).rejects.toBeInstanceOf(PathEscapeError)
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('s')
  })
})
