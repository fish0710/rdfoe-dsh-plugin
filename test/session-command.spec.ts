import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/host/store/store.ts'
import { COMMAND_NAME, parseCommandInput, parseStartPrompt, pendingStarts, registerWorkflowCommand, runWorkflowCommand, startPrompt, USAGE } from '../src/host/tools/session-command.ts'
import { NODE_KIND, ORDER } from '../src/host/workflow/template.ts'

const NODES = ORDER.map(key => ({ key, kind: NODE_KIND[key] }))

describe('/rdfoe-workflow', () => {
  let dir: string
  let store: Store
  let service: { pendingCount: () => number }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rdfoe-cmd-'))
    store = new Store(join(dir, 'state.db'))
    service = {
      pendingCount: () => 0,
    }
  })
  afterEach(async () => {
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  const submitted: string[] = []
  const submit = (text: string) => { submitted.push(text) }
  const run = (sessionId: string, rawInput: string, cwd: string | null = '/p') => runWorkflowCommand(store, service as never, { sessionId, cwd: cwd ?? undefined, rawInput }, submit)
  const bind = (sessionId: string, template = 'full') => {
    const { run: row } = store.getOrCreateRun({ id: 'WF-TEST1', sessionId, projectPath: '/p', branch: 'rdfoe/WF-TEST1', title: 't', requirement: 'r', template }, NODES)
    store.transition({ table: 'run', id: row.id }, 'start')
  }
  beforeEach(() => { submitted.length = 0; pendingStarts.clear() })

  it('prints usage (not an error) when there is no requirement and no run', () => {
    expect(run('s-1', '   ')).toEqual({ kind: 'success', text: USAGE })
    expect(submitted).toEqual([])
  })

  it('submits one start message instead of starting the run itself', () => {
    const result = run('s-1', ' 实现 add 函数\n并写测试 ')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('需求已作为消息发给模型')
    expect(store.runBySession('s-1')).toBeUndefined()
    expect(submitted).toEqual([startPrompt('实现 add 函数\n并写测试', 'full')])
    expect(pendingStarts.get('s-1')).toEqual({ requirement: '实现 add 函数\n并写测试', template: 'full' })
  })

  it('--small reaches the message and the parked template; the prompt round-trips', () => {
    run('s-1', ' --small  修正按钮文案 ')
    expect(pendingStarts.get('s-1')).toEqual({ requirement: '修正按钮文案', template: 'small' })
    expect(submitted[0]).toContain('template 传 "small"')
    expect(parseStartPrompt(submitted[0]!)).toEqual({ requirement: '修正按钮文案', template: 'small' })
    expect(parseStartPrompt(startPrompt('多行\n\n需求', 'full'))).toEqual({ requirement: '多行\n\n需求', template: 'full' })
    expect(parseStartPrompt('随便说点什么')).toBeNull()
  })

  it('does not submit twice while a start is on its way', () => {
    run('s-1', ' a')
    expect(run('s-1', ' b').text).toBe('本会话的工作流正在开启，请稍候。')
    expect(submitted).toHaveLength(1)
  })

  it('parses the template flag only at the start and only as a whole word', () => {
    expect(parseCommandInput('--small 做点事')).toEqual({ template: 'small', requirement: '做点事' })
    expect(parseCommandInput('--full 做点事')).toEqual({ template: 'full', requirement: '做点事' })
    expect(parseCommandInput('  --small')).toEqual({ template: 'small', requirement: '' })
    expect(parseCommandInput('--smaller 做点事')).toEqual({ template: 'full', requirement: '--smaller 做点事' })
    expect(parseCommandInput('做点事 --small')).toEqual({ template: 'full', requirement: '做点事 --small' })
  })

  it('--small without a requirement prints usage and submits nothing', () => {
    expect(run('s-1', '--small')).toEqual({ kind: 'success', text: USAGE })
    expect(USAGE).toContain('/rdfoe-workflow [--small] <需求>')
    expect(submitted).toEqual([])
  })

  it('reports the bound run, bare or with text, and never submits for it', async () => {
    bind('s-1', 'small')
    const bare = run('s-1', '')
    expect(bare.text).toMatch(/^本会话的工作流 WF-TEST1 · /u)
    const { parseCommandRun } = await import('../src/client/api.ts')
    expect(parseCommandRun(bare.text)?.template).toBe('small')
    const again = run('s-1', ' 另一个需求')
    expect(again.text).toMatch(/^本会话的工作流 WF-TEST1/u)
    expect(again.text).toContain('这次输入的需求没有采用')
    expect(submitted).toEqual([])
  })

  it('needs a working directory', () => {
    expect(run('s-2', ' x', null)).toMatchObject({ kind: 'error' })
    expect(submitted).toEqual([])
  })

  it('registers with a Chinese description and follows up on the agent after the handler returns', async () => {
    vi.useFakeTimers()
    try {
      const register = vi.fn(() => () => {})
      registerWorkflowCommand({ register }, store, service as never)
      const definition = (register.mock.calls[0] as unknown as [Parameters<Parameters<typeof registerWorkflowCommand>[0]['register']>[0]])[0]
      expect(definition).toMatchObject({ name: COMMAND_NAME, description: '用 RDFOE 工作流实现需求：/rdfoe-workflow [--small] <需求>', input: { hint: '[--small] <需求>' } })
      let idle!: () => void
      const agent = { id: 's-9', session: { header: { cwd: '/repo' } }, followup: vi.fn(), whenIdle: () => new Promise<void>(resolve => { idle = resolve }) }
      const result = await definition.handler({ agent, rawInput: ' 做点事' })
      expect(result.kind).toBe('success')
      expect(agent.followup).not.toHaveBeenCalled()
      vi.runAllTimers()
      expect(agent.followup).toHaveBeenCalledTimes(1)
      const message = agent.followup.mock.calls[0]![0]
      expect(message.source).toEqual({ kind: 'user' })
      expect(message.content[0].text).toBe(startPrompt('做点事', 'full'))
      expect(pendingStarts.has('s-9')).toBe(true)
      idle()
      await vi.waitFor(() => expect(pendingStarts.has('s-9')).toBe(false))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('client parse of the command result', () => {
  it('reads what the Host writes', async () => {
    const { parseCommandRun } = await import('../src/client/api.ts')
    expect(parseCommandRun('已开启工作流 WF-AB12CD34 · 运行中 · 当前节点 设计批准 · 待处理 1 · 分支 rdfoe/WF-AB12CD34\n项目 /p。')).toEqual({
      verb: '已开启', runId: 'WF-AB12CD34', status: '运行中', node: 'H1', template: 'full', facts: '运行中 · 当前节点 设计批准 · 待处理 1 · 分支 rdfoe/WF-AB12CD34',
    })
    expect(parseCommandRun('本会话的工作流 WF-X1 · 已完成 · 待处理 0')).toMatchObject({ verb: '本会话的', node: null })
    expect(parseCommandRun('已开启工作流 WF-S1 · 运行中 · 当前节点 小改动 · 待处理 0 · 流程 小改动')).toMatchObject({ node: 'S', template: 'small' })
    expect(parseCommandRun('已开启工作流 WF-F1 · 运行中 · 当前节点 需求录入 · 待处理 0 · 流程 完整')).toMatchObject({ node: 'R', template: 'full' })
    expect(parseCommandRun('本会话的工作流 WF-O1 · 只读 · 当前节点 结果审核 · 待处理 0 · 流程 旧版')).toMatchObject({ node: 'R3', template: 'legacy' })
    expect(parseCommandRun(USAGE)).toBeNull()
  })
})
