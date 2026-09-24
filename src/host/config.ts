/** Plugin Config (§4.3 switches plus node routes and personas). */
import Schema from '@deepseek-ai/schemastery'
import { LEGACY_ROUTE_KEYS, type AiKey } from './workflow/template.ts'

export interface ModelRouteConfig { provider?: string, model?: string }

export interface Config {
  dbPath?: string
  worktreeRoot?: string
  /** Deprecated (0.1.0-beta.4): the gates' AI pre-review is replaced by the DR design-review node; ignored. */
  review?: { aiPreReview?: boolean }
  /** Deprecated (0.1.0-beta.4): T and V now run one after the other; ignored. */
  plan?: { split?: boolean }
  loop: { stallRounds: number, remindAt: number }
  run: { autoResume: boolean }
  /** Deprecated (0.1.0-beta.6): nodes use DSH's native bash and file tools with their own limits; ignored. */
  exec?: { timeoutMs?: number, outputBytes?: number }
  /** Deprecated (0.1.0-beta.6): see exec; ignored. */
  write?: { maxBytes?: number }
  message: { maxPerAgent: number }
  maxConcurrentAgents: number
  defaultModel?: ModelRouteConfig
  /** Model route per node ID (R, C, D, DR, T, V, X, Y, A, S); legacy keys D, P, X1, X2, prereview still apply (see routeFor). */
  nodes: Partial<Record<string, ModelRouteConfig>>
  /** Persona override per node ID. */
  personas: Partial<Record<AiKey, string>>
  devRoutes: boolean
}

const route = Schema.object({ provider: Schema.string(), model: Schema.string() })

export const Config: Schema<Config> = Schema.object({
  dbPath: Schema.string().description('SQLite path; default $DSH_HOME/rdfoe-workflow/state.db'),
  worktreeRoot: Schema.string().description('Worktree directory; default $DSH_HOME/rdfoe-workflow/worktrees'),
  review: Schema.object({ aiPreReview: Schema.boolean() }).description('Deprecated: replaced by the DR design-review node; ignored'),
  plan: Schema.object({ split: Schema.boolean() }).description('Deprecated: T and V run in sequence; ignored'),
  loop: Schema.object({
    stallRounds: Schema.natural().min(1).default(3),
    remindAt: Schema.natural().min(1).default(10),
  }).default({ stallRounds: 3, remindAt: 10 }),
  run: Schema.object({ autoResume: Schema.boolean().default(false) }).default({ autoResume: false }),
  exec: Schema.object({ timeoutMs: Schema.natural(), outputBytes: Schema.natural() }).description('Deprecated: nodes use DSH\'s native bash (its own timeout and output limits); ignored'),
  write: Schema.object({ maxBytes: Schema.natural() }).description('Deprecated: nodes use DSH\'s native file tools; ignored'),
  message: Schema.object({ maxPerAgent: Schema.natural().min(1).default(20) }).default({ maxPerAgent: 20 }),
  maxConcurrentAgents: Schema.natural().min(1).default(4),
  defaultModel: route.description('Fallback route when neither the node config nor the main session supplies one'),
  nodes: Schema.dict(route).default({}).description('Per-node model route: R, C, D, DR, T, V, X, Y, A, S (legacy D→R/C, P→T/V, X1→X, X2→Y, prereview→DR)'),
  personas: Schema.dict(Schema.string()).default({}).description('Per-node persona override: R, C, D, DR, T, V, X, Y, A, S'),
  devRoutes: Schema.boolean().default(false).description('Expose /api/rdfoe-wf/dev/* test routes'),
}) as unknown as Schema<Config>

/** The configured route of a node: its own key first, then the legacy key that used to cover it. */
export function routeFor(nodes: Config['nodes'], key: AiKey): ModelRouteConfig | undefined {
  if (nodes[key]) return nodes[key]
  const legacy = Object.entries(LEGACY_ROUTE_KEYS).find(([old, keys]) => keys.includes(key) && nodes[old])
  return legacy ? nodes[legacy[0]] : undefined
}
