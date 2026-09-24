import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changedPaths, snapshotTree } from '../src/host/git/git.ts'
import { guardNativeCall, nativeAudit, toolsFor, type NodeReport, type ToolEnv } from '../src/host/tools/node-tools.ts'
import type { Role } from '../src/host/workflow/template.ts'

describe('node tools: flow tools, native guard and required files (§17)', () => {
  let root: string
  let reports: NodeReport[]
  const exec = { signal: new AbortController().signal } as never

  const env = (role: Role, extra: Partial<ToolEnv> = {}): ToolEnv => ({
    runId: 'WF-T', nodeId: 'N-1', role, version: 1, round: 1, root,
    agentSessionId: () => 'agent-1',
    audit: () => {},
    takeReplies: () => [],
    ask: async () => '',
    message: async () => 'IB-1',
    report: (r) => { reports.push(r) },
    ...extra,
  })
  const tool = (e: ToolEnv, name: string) => {
    const t = toolsFor(e).find(x => x.name === name)
    if (!t) throw new Error(`${name} not offered to ${e.role}`)
    return t as unknown as { execute(args: unknown, exec: unknown): Promise<unknown> }
  }
  const names = (e: ToolEnv) => toolsFor(e).map(t => t.name)
  const put = (path: string, content: string) => mkdir(join(root, path, '..'), { recursive: true }).then(() => writeFile(join(root, path), content))

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rdfoe-tools-'))
    reports = []
    await put('src/app.js', 'x\n')
    await put('.rdfoe/runs/WF-T/T/v1/tasks.md', '- [ ] T1 做事\n')
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  const Y_SCOPE = ['.rdfoe/runs/WF-T/Y/v1/verification.md', '.rdfoe/runs/WF-T/T/v1/tasks.md']

  it('the plugin adds only flow tools; DR has no inbox tools and A only messages', () => {
    for (const role of ['R', 'C', 'D', 'T', 'V', 'S', 'X', 'Y'] as const) expect(names(env(role)), role).toEqual(['wf_ask', 'wf_message', 'wf_report'])
    expect(names(env('DR'))).toEqual(['wf_report'])
    expect(names(env('A'))).toEqual(['wf_message', 'wf_report'])
  })

  it('native write/edit: a scoped role (Y) may change only its record and tasks.md', async () => {
    const e = env('Y', { writeScope: Y_SCOPE })
    expect(await guardNativeCall(e, 'write', { file_path: Y_SCOPE[0], content: '# 验证记录\n' })).toBeUndefined()
    expect(await guardNativeCall(e, 'edit', { file_path: join(root, Y_SCOPE[1]!), old_string: 'a', new_string: 'b' })).toBeUndefined()
    expect(await guardNativeCall(e, 'write', { file_path: 'src/app.js', content: 'hacked' })).toMatch(/outside what this node may write/)
    expect(await guardNativeCall(e, 'edit', { file_path: 'src/app.js', old_string: 'x', new_string: 'y' })).toMatch(/outside/)
    expect(await guardNativeCall(e, 'write', { file_path: './src/../.rdfoe/runs/WF-T/V/v1/verify-plan.md', content: 'x' })).toMatch(/outside/)
    // Reads are not guarded.
    expect(await guardNativeCall(e, 'read', { file_path: 'src/app.js' })).toBeUndefined()
  })

  it('native write/edit: every role stays inside the workspace and out of .git', async () => {
    const e = env('X')
    expect(await guardNativeCall(e, 'write', { file_path: 'src/new.js', content: 'y' })).toBeUndefined()
    expect(await guardNativeCall(e, 'write', { file_path: '../outside.txt', content: 'y' })).toBeTruthy()
    expect(await guardNativeCall(e, 'write', { file_path: '/etc/hosts', content: 'y' })).toBeTruthy()
    expect(await guardNativeCall(e, 'edit', { file_path: '.git/config', old_string: 'a', new_string: 'b' })).toBeTruthy()
    await symlink(tmpdir(), join(root, 'escape'))
    expect(await guardNativeCall(e, 'write', { file_path: 'escape/x.txt', content: 'y' })).toBeTruthy()
  })

  it('native bash: the workflow owns commits and the branch', async () => {
    const e = env('X')
    for (const command of ['git commit -am x', 'npm test && git push', 'git -C . reset --hard HEAD~1', 'git switch main', 'cd src; git rebase main']) {
      expect(await guardNativeCall(e, 'bash', { command }), command).toMatch(/workflow owns commits/)
    }
    for (const command of ['npm test 2>&1 | tail -50', 'git status --short', 'git diff HEAD', 'git log --oneline -5', 'git restore -- src/app.js', 'echo "git commit"x']) {
      expect(await guardNativeCall(e, 'bash', { command }), command).toBeUndefined()
    }
  })

  it('audit rows: bash keeps the command and exit code, write drops the content', () => {
    expect(nativeAudit('bash', { command: 'npm test' }, { isError: false, value: { kind: 'foreground', exitCode: 1 } })).toEqual({ digest: 'npm test', affected: [], exitCode: 1 })
    const w = nativeAudit('write', { file_path: 'src/a.js', content: 'abc' }, { isError: false })
    expect(w).toEqual({ digest: '{"file_path":"src/a.js","bytes":3}', affected: ['src/a.js'], exitCode: 0 })
    expect(nativeAudit('edit', { file_path: 'src/a.js' }, { isError: true }).exitCode).toBe(-1)
  })

  it('wf_report refuses until every required file exists, then lists them', async () => {
    const e = env('Y', { writeScope: Y_SCOPE, required: [Y_SCOPE[0]!] })
    const report = { summary: 's', artifacts: [], openIssues: [], confidence: 0.9, verdict: 'pass', items: [{ id: 'VP-1', result: 'pass', evidence: 'npm test exit 0' }] }
    await expect(tool(e, 'wf_report').execute(report, exec)).rejects.toThrow(/write \.rdfoe\/runs\/WF-T\/Y\/v1\/verification\.md before reporting/)
    await put(Y_SCOPE[0]!, '# 验证记录\n')
    await tool(e, 'wf_report').execute(report, exec)
    expect(reports[0]!.artifacts).toEqual([Y_SCOPE[0]])
  })

  it('wf_report requires every required file (V writes two)', async () => {
    const required = ['.rdfoe/runs/WF-T/V/v1/verify-plan.md', '.rdfoe/runs/WF-T/V/v1/acceptance.md']
    const e = env('V', { required })
    await put(required[1]!, '# 验收\n')
    await expect(tool(e, 'wf_report').execute({ summary: 's', artifacts: [], openIssues: [], confidence: 0.8 }, exec)).rejects.toThrow(/verify-plan\.md before reporting/)
    await put(required[0]!, '# 验证计划\n')
    await tool(e, 'wf_report').execute({ summary: 's', artifacts: [], openIssues: [], confidence: 0.8 }, exec)
    expect(reports[0]!.artifacts).toEqual(required)
  })

  it('wf_report refuses changes outside the scope, whichever tool made them (git snapshot)', async () => {
    const g = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
    g('init', '-q')
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A')
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
    await put('src/uncommitted.js', 'from X\n') // an earlier node's change is part of the baseline
    const baseline = await snapshotTree(root)
    const e = env('Y', {
      writeScope: Y_SCOPE,
      required: [Y_SCOPE[0]!],
      outOfScope: async () => (await changedPaths(root, baseline, await snapshotTree(root))).filter(p => !Y_SCOPE.includes(p)),
    })
    await put(Y_SCOPE[0]!, '# 验证记录\n')
    await put(Y_SCOPE[1]!, '- [ ] T1 做事\n- [ ] T2 修复 F-1\n')
    await put('src/app.js', 'patched by bash\n')
    const report = { summary: 's', artifacts: [], openIssues: [], confidence: 0.9, verdict: 'fail', items: [{ id: 'VP-1', result: 'fail', evidence: 'npm test exit 1' }] }
    await expect(tool(e, 'wf_report').execute(report, exec)).rejects.toThrow(/may not change: src\/app\.js\. Restore/)
    await put('src/app.js', 'x\n')
    await tool(e, 'wf_report').execute(report, exec)
    expect(reports).toHaveLength(1)
    // The real index is untouched.
    expect(g('status', '--porcelain').toString()).not.toMatch(/^A /m)
  })

  it('DR reports a verdict with items', async () => {
    const review = '.rdfoe/runs/WF-T/DR/v1/review.md'
    const dr = env('DR', { writeScope: [review], required: [review] })
    await put(review, '# 评审\n')
    await expect(tool(dr, 'wf_report').execute({ summary: 's', artifacts: [], openIssues: [], confidence: 0.8, verdict: 'pass', items: [{ id: 'F-1', result: 'fail', evidence: '缺少错误处理' }] }, exec)).rejects.toThrow(/verdict must be "fail"/)
    await tool(dr, 'wf_report').execute({ summary: 's', artifacts: [], openIssues: [], confidence: 0.8, verdict: 'fail', items: [{ id: 'F-1', result: 'fail', evidence: '缺少错误处理' }] }, exec)
    expect(reports[0]!.verdict).toBe('fail')
  })

  it('C reports blocked, and blocked needs the blockers in openIssues', async () => {
    const req = '.rdfoe/runs/WF-T/C/v1/requirement.md'
    const c = env('C', { required: [req] })
    await put(req, '# 需求\n')
    await expect(tool(c, 'wf_report').execute({ summary: 's', artifacts: [], openIssues: [], confidence: 0.5, blocked: true }, exec)).rejects.toThrow(/openIssues/)
    await tool(c, 'wf_report').execute({ summary: 's', artifacts: [], openIssues: ['数据保留策略未定'], confidence: 0.5, blocked: true }, exec)
    expect(reports[0]!.blocked).toBe(true)
  })
})
