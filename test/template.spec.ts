import { describe, expect, it } from 'vitest'
import { Config, routeFor } from '../src/host/config.ts'
import { NODE_KIND, NODE_SKILL, ORDER, REQUIRED_ARTIFACTS, TEMPLATES, downstreamFrom, isGate, templateOf, type AiKey, type GateKey } from '../src/host/workflow/template.ts'

describe('templates (§17: one PH skill per node)', () => {
  it('full: R → C → D ⇄ DR → H1 → T → V → H2 → X ⇄ Y → H3 → A; small: S → H2 → X ⇄ Y → H3 → A', () => {
    expect(TEMPLATES.full.order).toEqual(['R', 'C', 'D', 'DR', 'H1', 'T', 'V', 'H2', 'X', 'Y', 'H3', 'A'])
    expect(ORDER).toBe(TEMPLATES.full.order)
    expect(TEMPLATES.small.order).toEqual(['S', 'H2', 'X', 'Y', 'H3', 'A'])
    expect(TEMPLATES.full.loops).toEqual([{ fix: 'D', check: 'DR' }, { fix: 'X', check: 'Y' }])
    expect(TEMPLATES.small.loops).toEqual([{ fix: 'X', check: 'Y' }])
    expect([TEMPLATES.full.tasksNode, TEMPLATES.full.verifyPlanNode, TEMPLATES.small.tasksNode, TEMPLATES.small.verifyPlanNode]).toEqual(['T', 'V', 'S', 'S'])
  })

  it('maps each AI node to its PH skill', () => {
    expect(NODE_SKILL).toEqual({ R: 'ph-require', C: 'ph-clarify', D: 'ph-design', DR: 'ph-design-review', T: 'ph-tasks', V: 'ph-verify-plan', X: 'ph-implement', Y: 'ph-verify', A: 'ph-archive', S: 'ph-small-change' })
  })

  it('reads rows from before 0.1.0-beta.4 (standard, unknown) as the read-only legacy template', () => {
    expect(templateOf({ template: 'standard' }).id).toBe('legacy')
    expect(templateOf({ template: undefined }).id).toBe('legacy')
    expect(templateOf({ template: 'full' }).id).toBe('full')
    expect(templateOf({ template: 'small' }).id).toBe('small')
    expect(TEMPLATES.legacy.order).toEqual(['D', 'R1', 'P', 'R2', 'X1', 'X2', 'R3'])
    expect(TEMPLATES.legacy.gateSubject).toEqual({})
  })

  for (const template of [TEMPLATES.full, TEMPLATES.small]) {
    it(`${template.id}: gates review and roll back to earlier AI nodes; H3 rolls back to X`, () => {
      const gates = template.order.filter(isGate) as GateKey[]
      expect(Object.keys(template.gateSubject).sort()).toEqual([...gates].sort())
      for (const gate of gates) {
        const at = template.order.indexOf(gate)
        for (const key of [...template.gateSubject[gate]!, ...template.rollbackTargets[gate]!]) {
          expect(NODE_KIND[key]).toBe('ai')
          expect(template.order.indexOf(key)).toBeGreaterThanOrEqual(0)
          expect(template.order.indexOf(key)).toBeLessThan(at)
        }
      }
      expect(template.rollbackTargets.H3).toEqual(['X'])
    })
  }

  it('gates sit where PH asks for approval', () => {
    expect(TEMPLATES.full.rollbackTargets).toEqual({ H1: ['D', 'C'], H2: ['T', 'V'], H3: ['X'] })
    expect(TEMPLATES.small.rollbackTargets).toEqual({ H2: ['S'], H3: ['X'] })
  })

  it('downstreamFrom follows the run template', () => {
    expect(downstreamFrom(TEMPLATES.full, 'V')).toEqual(['V', 'H2', 'X', 'Y', 'H3', 'A'])
    expect(downstreamFrom(TEMPLATES.small, 'X')).toEqual(['X', 'Y', 'H3', 'A'])
  })

  it('uses the PH artifact names', () => {
    expect(REQUIRED_ARTIFACTS).toEqual({
      R: ['requirement.md'], C: ['requirement.md'], D: ['design.md'], DR: ['review.md'], T: ['tasks.md'],
      V: ['verify-plan.md', 'acceptance.md'], X: ['verification.md'], Y: ['verification.md'], A: ['archive.md'],
      S: ['change.md', 'tasks.md', 'verify-plan.md', 'acceptance.md'],
    })
  })
})

describe('node model routes', () => {
  const route = (model: string) => ({ provider: 'p', model })
  it('prefer the node ID, then the legacy key that used to cover the node', () => {
    const nodes = { D: route('d'), P: route('p'), X1: route('x1'), X2: route('x2'), prereview: route('pre'), Y: route('y') }
    const got = (key: AiKey) => routeFor(nodes, key)?.model
    expect([got('R'), got('C'), got('D'), got('DR'), got('T'), got('V'), got('X'), got('Y'), got('A'), got('S')])
      .toEqual(['d', 'd', 'd', 'pre', 'p', 'p', 'x1', 'y', undefined, undefined])
  })
})

describe('Config migration', () => {
  it('accepts configs without the deprecated switches, and old ones that still carry them', () => {
    expect(() => Config({} as never)).not.toThrow()
    const old = Config({ review: { aiPreReview: false }, plan: { split: true }, nodes: { X1: { provider: 'p', model: 'm' } } } as never)
    expect(routeFor(old.nodes, 'X')?.model).toBe('m')
  })
})
