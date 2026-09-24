import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toolsFor, type NodeReport, type ToolEnv } from '../src/host/tools/node-tools.ts'
import type { Role } from '../src/host/workflow/template.ts'

describe('node tools: write scope and required files (§17)', () => {
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
    limits: { maxWriteBytes: 1 << 20, execTimeoutMs: 10_000, execOutputBytes: 4096 },
    ...extra,
  })
  const tool = (e: ToolEnv, name: string) => {
    const t = toolsFor(e).find(x => x.name === name)
    if (!t) throw new Error(`${name} not offered to ${e.role}`)
    return t as unknown as { execute(args: unknown, exec: unknown): Promise<unknown> }
  }
  const names = (e: ToolEnv) => toolsFor(e).map(t => t.name)

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rdfoe-tools-'))
    reports = []
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, '.rdfoe/runs/WF-T/T/v1'), { recursive: true })
    await writeFile(join(root, 'src/app.js'), 'x\n')
    await writeFile(join(root, '.rdfoe/runs/WF-T/T/v1/tasks.md'), '- [ ] T1 做事\n')
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  const Y_SCOPE = ['.rdfoe/runs/WF-T/Y/v1/verification.md', '.rdfoe/runs/WF-T/T/v1/tasks.md']

  it('Y may write its record and append fix tasks, and nothing else', async () => {
    const e = env('Y', { writeScope: Y_SCOPE, required: [Y_SCOPE[0]!] })
    expect(names(e)).toEqual(expect.arrayContaining(['wf_write', 'wf_edit', 'wf_exec', 'wf_git', 'wf_ask', 'wf_report']))
    await tool(e, 'wf_write').execute({ path: Y_SCOPE[0], content: '# 验证记录\n' }, exec)
    await tool(e, 'wf_edit').execute({ path: Y_SCOPE[1], old_text: '- [ ] T1 做事\n', new_text: '- [ ] T1 做事\n- [ ] T2 修复 F-1\n' }, exec)
    expect(await readFile(join(root, Y_SCOPE[1]!), 'utf8')).toContain('T2 修复 F-1')
    await expect(tool(e, 'wf_write').execute({ path: 'src/app.js', content: 'hacked' }, exec)).rejects.toThrow(/outside what this node may write/)
    await expect(tool(e, 'wf_edit').execute({ path: 'src/app.js', old_text: 'x', new_text: 'y' }, exec)).rejects.toThrow(/outside/)
    await expect(tool(e, 'wf_write').execute({ path: './src/../.rdfoe/runs/WF-T/V/v1/verify-plan.md', content: 'x' }, exec)).rejects.toThrow(/outside/)
    expect(await readFile(join(root, 'src/app.js'), 'utf8')).toBe('x\n')
  })

  it('wf_report refuses until every required file exists, then lists them', async () => {
    const e = env('Y', { writeScope: Y_SCOPE, required: [Y_SCOPE[0]!] })
    const report = { summary: 's', artifacts: [], openIssues: [], confidence: 0.9, verdict: 'pass', items: [{ id: 'VP-1', result: 'pass', evidence: 'npm test exit 0' }] }
    await expect(tool(e, 'wf_report').execute(report, exec)).rejects.toThrow(/write \.rdfoe\/runs\/WF-T\/Y\/v1\/verification\.md before reporting/)
    await tool(e, 'wf_write').execute({ path: Y_SCOPE[0], content: '# 验证记录\n' }, exec)
    await tool(e, 'wf_report').execute(report, exec)
    expect(reports[0]!.artifacts).toEqual([Y_SCOPE[0]])
  })

  it('wf_report requires every required file (V writes two)', async () => {
    const required = ['.rdfoe/runs/WF-T/V/v1/verify-plan.md', '.rdfoe/runs/WF-T/V/v1/acceptance.md']
    const e = env('V', { required })
    await tool(e, 'wf_write').execute({ path: required[1], content: '# 设计\n' }, exec)
    await expect(tool(e, 'wf_report').execute({ summary: 's', artifacts: [], openIssues: [], confidence: 0.8 }, exec)).rejects.toThrow(/verify-plan\.md before reporting/)
    await tool(e, 'wf_write').execute({ path: required[0], content: '# 需求\n' }, exec)
    await tool(e, 'wf_report').execute({ summary: 's', artifacts: [], openIssues: [], confidence: 0.8 }, exec)
    expect(reports[0]!.artifacts).toEqual(required)
  })

  it('DR and A may write only their own record; DR offers no inbox tools', async () => {
    const review = '.rdfoe/runs/WF-T/DR/v1/review.md'
    const dr = env('DR', { writeScope: [review], required: [review] })
    expect(names(dr)).toEqual(['wf_read', 'wf_list', 'wf_search', 'wf_write', 'wf_report'])
    await expect(tool(dr, 'wf_write').execute({ path: '.rdfoe/runs/WF-T/D/v1/design.md', content: 'x' }, exec)).rejects.toThrow(/outside/)
    await tool(dr, 'wf_write').execute({ path: review, content: '# 评审\n' }, exec)
    const archive = '.rdfoe/runs/WF-T/A/v1/archive.md'
    const a = env('A', { writeScope: [archive], required: [archive] })
    expect(names(a)).toEqual(['wf_read', 'wf_list', 'wf_search', 'wf_write', 'wf_git', 'wf_message', 'wf_report'])
    await expect(tool(a, 'wf_write').execute({ path: 'README.md', content: 'x' }, exec)).rejects.toThrow(/outside/)
  })

  it('DR reports a verdict with items', async () => {
    const review = '.rdfoe/runs/WF-T/DR/v1/review.md'
    const dr = env('DR', { writeScope: [review], required: [review] })
    await tool(dr, 'wf_write').execute({ path: review, content: '# 评审\n' }, exec)
    await expect(tool(dr, 'wf_report').execute({ summary: 's', artifacts: [], openIssues: [], confidence: 0.8, verdict: 'pass', items: [{ id: 'F-1', result: 'fail', evidence: '缺少错误处理' }] }, exec)).rejects.toThrow(/verdict must be "fail"/)
    await tool(dr, 'wf_report').execute({ summary: 's', artifacts: [], openIssues: [], confidence: 0.8, verdict: 'fail', items: [{ id: 'F-1', result: 'fail', evidence: '缺少错误处理' }] }, exec)
    expect(reports[0]!.verdict).toBe('fail')
  })

  it('C reports blocked, and blocked needs the blockers in openIssues', async () => {
    const req = '.rdfoe/runs/WF-T/C/v1/requirement.md'
    const c = env('C', { required: [req] })
    await tool(c, 'wf_write').execute({ path: req, content: '# 需求\n' }, exec)
    await expect(tool(c, 'wf_report').execute({ summary: 's', artifacts: [], openIssues: [], confidence: 0.5, blocked: true }, exec)).rejects.toThrow(/openIssues/)
    await tool(c, 'wf_report').execute({ summary: 's', artifacts: [], openIssues: ['数据保留策略未定'], confidence: 0.5, blocked: true }, exec)
    expect(reports[0]!.blocked).toBe(true)
  })

  it('planning nodes (R, C, D, T, V, S) have no exec and no git', () => {
    for (const role of ['R', 'C', 'D', 'T', 'V', 'S'] as const) {
      const tools = names(env(role))
      expect(tools, role).toEqual(expect.arrayContaining(['wf_write', 'wf_edit', 'wf_ask', 'wf_message', 'wf_report']))
      expect(tools, role).not.toContain('wf_exec')
      expect(tools, role).not.toContain('wf_git')
    }
  })

  it('X keeps unscoped writes', async () => {
    const e = env('X')
    await tool(e, 'wf_write').execute({ path: 'src/app.js', content: 'y\n' }, exec)
    expect(await readFile(join(root, 'src/app.js'), 'utf8')).toBe('y\n')
  })
})
