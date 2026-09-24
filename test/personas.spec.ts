import { describe, expect, it } from 'vitest'
import { PH_TEMPLATES } from '../src/host/prompts/ph/templates.ts'
import { DEFAULT_PERSONAS, personaFor } from '../src/host/prompts/personas.ts'
import { NODE_SKILL, type AiKey } from '../src/host/workflow/template.ts'

const KEYS = Object.keys(NODE_SKILL) as AiKey[]
const TALKING = ['R', 'C', 'D', 'T', 'V', 'S', 'X', 'Y'] as const

describe('personas (one PH skill per node, §17)', () => {
  it('exist for every AI node, name their node and their PH skill', () => {
    expect(Object.keys(DEFAULT_PERSONAS).sort()).toEqual([...KEYS].sort())
    for (const key of KEYS) {
      expect(DEFAULT_PERSONAS[key], key).toContain(`（节点 ${key}）`)
      expect(DEFAULT_PERSONAS[key], key).toContain(NODE_SKILL[key])
    }
  })

  it('never contain {{ (DSH interpolates persona templates strictly)', () => {
    for (const [key, text] of Object.entries(DEFAULT_PERSONAS)) expect(text.includes('{{'), key).toBe(false)
  })

  it('drop the PH scripts, companion docs, skill gates and .agents paths', () => {
    for (const [key, text] of Object.entries(DEFAULT_PERSONAS)) {
      for (const banned of ['ph_sdd', 'ph_human', 'ph-human', '伴读', '.agents/', 'ph-worktree', 'constitution', '仅当用户明确点名', '宿主问答', '宿主实际问答']) {
        expect(text.includes(banned), `${key} mentions ${banned}`).toBe(false)
      }
    }
  })

  it('carry the rewritten common process; talking nodes get the inbox rules', () => {
    for (const key of KEYS) {
      expect(DEFAULT_PERSONAS[key], key).toContain('PH 开发共同约定（工作流版）')
      expect(DEFAULT_PERSONAS[key], key).toContain('缺失时不编造规则')
      expect(DEFAULT_PERSONAS[key], key).toContain('你不做 git 提交、合并或推送')
    }
    for (const key of TALKING) expect(DEFAULT_PERSONAS[key], key).toContain('wf_ask：一次只提交一个独立决定')
    expect(DEFAULT_PERSONAS.DR).not.toContain('wf_ask：')
    expect(DEFAULT_PERSONAS.A).not.toContain('wf_ask：')
  })

  it('keep the PH substance per node', () => {
    expect(DEFAULT_PERSONAS.C).toContain('blocked 设为 true')
    expect(DEFAULT_PERSONAS.DR).toContain('有任何阻断发现就是 "fail"')
    expect(DEFAULT_PERSONAS.T).toContain('每个适用的实现任务内包含单测')
    expect(DEFAULT_PERSONAS.V).toContain('tasks.md')
    expect(DEFAULT_PERSONAS.V).toContain('VP-1')
    expect(DEFAULT_PERSONAS.Y).toContain('在 tasks.md 末尾追加修复任务')
    expect(DEFAULT_PERSONAS.Y).toContain('不能凭实施说明或代码「看起来对」就判 pass')
    expect(DEFAULT_PERSONAS.A).toContain('用户结论')
    expect(DEFAULT_PERSONAS.A).toContain('不修改项目文档')
  })

  it('honours per-node overrides', () => {
    expect(personaFor('S', { S: 'custom' })).toBe('custom')
    expect(personaFor('DR', {})).toBe(DEFAULT_PERSONAS.DR)
  })
})

describe('bundled PH templates', () => {
  it('cover the artifacts that have a PH template, with the PH script references rewritten', () => {
    expect(Object.keys(PH_TEMPLATES).sort()).toEqual(['acceptance.md', 'change.md', 'design.md', 'requirement.md', 'review.md', 'tasks.md', 'verification.md', 'verify-plan.md'])
    for (const [name, text] of Object.entries(PH_TEMPLATES)) {
      expect(text.startsWith('# '), name).toBe(true)
      expect(text.includes('ph_sdd'), name).toBe(false)
      expect(text.includes('功能目录'), name).toBe(false)
    }
  })
})
