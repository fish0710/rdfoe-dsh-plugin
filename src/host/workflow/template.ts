/**
 * Templates (§17) and their artifact layout (§6.1). The node chain follows
 * project-harness (PH): one PH skill per AI node, human gates where PH asks
 * for an explicit approval.
 *
 * - full (default): R → C → D ⇄ DR → H1 → T → V → H2 → X ⇄ Y → H3 → A
 * - small:          S → H2 → X ⇄ Y → H3 → A
 * - legacy:         D → R1 → P → R2 → X1 ⇄ X2 → R3 (runs created before
 *   0.1.0-beta.4, stored as `standard`); shown read-only, never driven.
 */

export type TemplateId = 'full' | 'small' | 'legacy'
/** Templates a new run can use. */
export type StartTemplateId = 'full' | 'small'

export type AiKey = 'R' | 'C' | 'D' | 'DR' | 'T' | 'V' | 'X' | 'Y' | 'A' | 'S'
export type GateKey = 'H1' | 'H2' | 'H3'
type LegacyKey = 'R1' | 'P' | 'R2' | 'X1' | 'X2' | 'R3'
export type NodeKey = AiKey | GateKey | LegacyKey

/** One agent per AI node: the role is the node key. */
export type Role = AiKey

/** A fix ⇄ check loop: a failed check stales both and reruns the fix node. */
export interface Loop { fix: AiKey, check: AiKey }

export interface Template {
  id: TemplateId
  label: string
  order: readonly NodeKey[]
  /** What each gate reviews (all subjects are finalised on approval). */
  gateSubject: Partial<Record<GateKey, AiKey[]>>
  /** Legal rollback targets per gate; the first is the default. */
  rollbackTargets: Partial<Record<GateKey, AiKey[]>>
  /** Loops in template order. */
  loops: readonly Loop[]
  /** Holds tasks.md (and restarts the X ⇄ Y loop count). */
  tasksNode: AiKey | null
  /** Holds verify-plan.md and acceptance.md. */
  verifyPlanNode: AiKey | null
}

export const TEMPLATES: Record<TemplateId, Template> = {
  full: {
    id: 'full',
    label: '完整流程',
    order: ['R', 'C', 'D', 'DR', 'H1', 'T', 'V', 'H2', 'X', 'Y', 'H3', 'A'],
    gateSubject: { H1: ['C', 'D', 'DR'], H2: ['T', 'V'], H3: ['X', 'Y'] },
    rollbackTargets: { H1: ['D', 'C'], H2: ['T', 'V'], H3: ['X'] },
    loops: [{ fix: 'D', check: 'DR' }, { fix: 'X', check: 'Y' }],
    tasksNode: 'T',
    verifyPlanNode: 'V',
  },
  small: {
    id: 'small',
    label: '小改动',
    order: ['S', 'H2', 'X', 'Y', 'H3', 'A'],
    gateSubject: { H2: ['S'], H3: ['X', 'Y'] },
    rollbackTargets: { H2: ['S'], H3: ['X'] },
    loops: [{ fix: 'X', check: 'Y' }],
    tasksNode: 'S',
    verifyPlanNode: 'S',
  },
  legacy: {
    id: 'legacy',
    label: '旧版流程（只读）',
    order: ['D', 'R1', 'P', 'R2', 'X1', 'X2', 'R3'],
    gateSubject: {},
    rollbackTargets: {},
    loops: [],
    tasksNode: null,
    verifyPlanNode: null,
  },
}

export const ORDER: readonly NodeKey[] = TEMPLATES.full.order

export function isStartTemplate(value: unknown): value is StartTemplateId {
  return value === 'full' || value === 'small'
}

/** Template of a stored run; rows from before 0.1.0-beta.4 (`standard`, or anything unknown) are legacy. */
export function templateOf(run: { template?: string | null }): Template {
  return isStartTemplate(run.template) ? TEMPLATES[run.template] : TEMPLATES.legacy
}

export const NODE_KIND: Record<NodeKey, 'ai' | 'review'> = {
  R: 'ai', C: 'ai', D: 'ai', DR: 'ai', T: 'ai', V: 'ai', X: 'ai', Y: 'ai', A: 'ai', S: 'ai',
  H1: 'review', H2: 'review', H3: 'review',
  R1: 'review', P: 'ai', R2: 'review', X1: 'ai', X2: 'ai', R3: 'review',
}

export const NODE_LABEL: Record<NodeKey, string> = {
  R: '需求录入', C: '需求澄清', D: '设计', DR: '设计审查', H1: '设计批准', T: '任务规划', V: '验证计划', H2: '授权实施',
  X: '实施', Y: '验证', H3: '用户验收', A: '归档', S: '小改动',
  R1: '设计审核', P: '计划生成', R2: '计划审核', X1: '实施（旧）', X2: '验收（旧）', R3: '结果审核',
}

/** The PH skill each AI node runs. */
export const NODE_SKILL: Record<AiKey, string> = {
  R: 'ph-require', C: 'ph-clarify', D: 'ph-design', DR: 'ph-design-review', T: 'ph-tasks', V: 'ph-verify-plan',
  X: 'ph-implement', Y: 'ph-verify', A: 'ph-archive', S: 'ph-small-change',
}

export function isGate(key: NodeKey): key is GateKey {
  return key === 'H1' || key === 'H2' || key === 'H3'
}

/** The target node and everything after it in template order. */
export function downstreamFrom(template: Template, key: NodeKey): NodeKey[] {
  return template.order.slice(template.order.indexOf(key))
}

export function artifactDir(runId: string, node: AiKey, version: number): string {
  return `.rdfoe/runs/${runId}/${node}/v${version}`
}

/** Files each node must write inside its artifact directory before wf_report. */
export const REQUIRED_ARTIFACTS: Record<AiKey, readonly string[]> = {
  R: ['requirement.md'],
  C: ['requirement.md'],
  D: ['design.md'],
  DR: ['review.md'],
  T: ['tasks.md'],
  V: ['verify-plan.md', 'acceptance.md'],
  X: ['verification.md'],
  Y: ['verification.md'],
  A: ['archive.md'],
  S: ['change.md', 'tasks.md', 'verify-plan.md', 'acceptance.md'],
}

/** Nodes whose wf_report carries verdict + items (the check side of a loop). */
export const CHECK_ROLES: readonly AiKey[] = ['DR', 'Y']

/** Legacy `nodes.<key>` model routes → the new nodes they apply to when those have no route of their own. */
export const LEGACY_ROUTE_KEYS: Record<string, AiKey[]> = {
  D: ['R', 'C'],
  P: ['T', 'V'],
  X1: ['X'],
  X2: ['Y'],
  prereview: ['DR'],
}
