import { describe, expect, it } from 'vitest'
import type { ReviewRow, RunRow } from '../src/host/store/store.ts'
import { buildPrompt } from '../src/host/workflow/prompt.ts'

const run = (template: string): RunRow => ({
  id: 'WF-T', session_id: 's', project_path: '/p', worktree_path: '/w', branch: 'rdfoe/WF-T', base_ref: 'abc', is_git: 1,
  title: '标题', requirement_text: '需求正文', template, config_json: '{}', status: 'RUNNING', current_node: null,
  loop_round: 0, stall_ack_round: 0, created_at: '', updated_at: '',
})

const base = { upstream: [], rejections: [], replies: [] }

describe('buildPrompt (§6.1, §17)', () => {
  it('names the node, its PH skill and the template; lists outputs and appends each PH template once', () => {
    const text = buildPrompt({ ...base, run: run('full'), role: 'D', version: 1, round: 0, outputs: ['.rdfoe/runs/WF-T/D/v1/design.md'] })
    expect(text).toMatch(/^本节点：设计（D），第 1 版，执行 PH ph-design。流程模板：完整流程（full）。/)
    expect(text).toContain('## 你要写的文件\n- .rdfoe/runs/WF-T/D/v1/design.md')
    expect(text).toContain('### design.md\n~~~markdown\n# design-template.md')
    expect(text.match(/### design\.md/g)).toHaveLength(1)
  })

  it('gives the date to use in dated entries (澄清记录, archive)', () => {
    expect(buildPrompt({ ...base, run: run('full'), role: 'C', version: 1, round: 0, today: '2026-09-23' })).toContain('今天是 2026-09-23，文档里要写日期时用它。')
    expect(buildPrompt({ ...base, run: run('full'), role: 'C', version: 1, round: 0 })).toMatch(/今天是 \d{4}-\d{2}-\d{2}，/)
  })

  it('gives D the blocking findings of the design review', () => {
    const text = buildPrompt({ ...base, run: run('full'), role: 'D', version: 2, round: 0, failedItems: [{ id: 'F-1', evidence: '缺少错误处理' }] })
    expect(text).toContain('## 设计审查的阻断发现（逐条回应）\n- F-1：缺少错误处理')
  })

  it('names the small template and the S node with its four templates', () => {
    const text = buildPrompt({ ...base, run: run('small'), role: 'S', version: 2, round: 0, outputs: ['x/change.md', 'x/tasks.md', 'x/verify-plan.md', 'x/acceptance.md'] })
    expect(text).toMatch(/^本节点：小改动（S），第 2 版，执行 PH ph-small-change。流程模板：小改动（small）。/)
    for (const name of ['change', 'tasks', 'verify-plan', 'acceptance']) expect(text).toContain(`# ${name}-template.md`)
  })

  it('tells Y where its record goes and which tasks.md takes the fix tasks', () => {
    const text = buildPrompt({ ...base, run: run('full'), role: 'Y', version: 1, round: 1, outputs: ['.rdfoe/runs/WF-T/Y/v1/verification.md'], tasksPath: '.rdfoe/runs/WF-T/T/v1/tasks.md' })
    expect(text).toContain('把记录写进 .rdfoe/runs/WF-T/Y/v1/verification.md')
    expect(text).toContain('把修复任务追加到 .rdfoe/runs/WF-T/T/v1/tasks.md 末尾')
    expect(text).toContain('当前是实施⇄验证循环第 1 轮。')
  })

  it('gives A the human decisions; archive.md has no PH template', () => {
    const reviews = [
      { id: 'a', node_id: 'n', node_key: 'H3', target_version: 1, decision: 'REJECTED', comment: '按钮文案不对', rollback_to: 'X', created_at: '2026-09-23T08:00:00.000Z' },
      { id: 'b', node_id: 'n', node_key: 'H3', target_version: 2, decision: 'APPROVED', comment: '', rollback_to: null, created_at: '2026-09-23T09:00:00.000Z' },
    ] as (ReviewRow & { node_key: string })[]
    const text = buildPrompt({ ...base, run: run('full'), role: 'A', version: 1, round: 2, reviews, outputs: ['.rdfoe/runs/WF-T/A/v1/archive.md'] })
    expect(text).toContain('## 审核记录')
    expect(text).toContain('用户验收（H3）v1：打回到 X，意见：按钮文案不对')
    expect(text).toContain('用户验收（H3）v2：通过')
    expect(text).not.toContain('## 模板参考')
  })
})
