/**
 * Plugin-owned SQLite state (`node:sqlite`, §8). Every status change goes
 * through `transition()`, which applies the transition table and appends an
 * `event` row in the same transaction.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { apply, type MachineKind } from '../workflow/machine.ts'
import type { NodeKey } from '../workflow/template.ts'

export interface RunRow {
  id: string
  session_id: string
  project_path: string
  worktree_path: string
  branch: string | null
  base_ref: string | null
  is_git: number
  title: string
  requirement_text: string
  template: string
  config_json: string
  status: string
  current_node: string | null
  loop_round: number
  stall_ack_round: number
  created_at: string
  updated_at: string
}

export interface NodeRow {
  id: string
  run_id: string
  node_key: NodeKey
  kind: 'ai' | 'review'
  status: string
  attempt: number
  current_version: number
  final_version: number | null
  agent_session_id: string | null
  started_at: string | null
  ended_at: string | null
  error: string | null
}

export interface NodeAgentRow {
  id: string
  run_id: string
  node_id: string
  version: number
  role: string
  agent_session_id: string | null
  /** provider/model the agent ran on. */
  model: string | null
  status: string
  report_json: string | null
  error: string | null
  started_at: string
  ended_at: string | null
}

export interface NodeVersionRow {
  id: string
  node_id: string
  version: number
  round: number
  origin: 'generated' | 'revised' | 'loop_fix'
  artifacts_json: string
  summary: string
  structured_json: string
  commit_sha: string | null
  created_at: string
}

export type InboxKind = 'question' | 'message' | 'review' | 'loop_stall'

export interface InboxRow {
  id: string
  run_id: string
  session_id: string
  node_id: string | null
  agent_session_id: string | null
  round: number
  kind: InboxKind
  blocking: number
  payload_json: string
  status: 'OPEN' | 'RESOLVED' | 'CANCELLED'
  response_json: string | null
  delivered_at: string | null
  created_at: string
  resolved_at: string | null
}

export interface ReviewRow {
  id: string
  node_id: string
  target_version: number
  decision: 'APPROVED' | 'REJECTED'
  comment: string
  rollback_to: string | null
  created_at: string
}

export interface EventRow {
  id: number
  run_id: string
  node_id: string | null
  type: string
  before: string | null
  after: string | null
  payload_json: string | null
  ts: string
}

export interface ToolCallRow {
  id: number
  run_id: string
  node_id: string | null
  agent_session_id: string | null
  tool: string
  args_digest: string
  affected_paths: string | null
  exit_code: number | null
  duration_ms: number
  ts: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  project_path TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch TEXT,
  base_ref TEXT,
  is_git INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  requirement_text TEXT NOT NULL DEFAULT '',
  template TEXT NOT NULL DEFAULT 'standard',
  config_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  current_node TEXT,
  loop_round INTEGER NOT NULL DEFAULT 0,
  stall_ack_round INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS node (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id),
  node_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  current_version INTEGER NOT NULL DEFAULT 0,
  final_version INTEGER,
  agent_session_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  error TEXT,
  UNIQUE (run_id, node_key)
);
CREATE TABLE IF NOT EXISTS node_agent (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id),
  node_id TEXT NOT NULL REFERENCES node(id),
  version INTEGER NOT NULL,
  role TEXT NOT NULL,
  agent_session_id TEXT,
  status TEXT NOT NULL,
  report_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS node_version (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES node(id),
  version INTEGER NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  structured_json TEXT NOT NULL DEFAULT '{}',
  commit_sha TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (node_id, version)
);
CREATE TABLE IF NOT EXISTS inbox_item (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id),
  session_id TEXT NOT NULL,
  node_id TEXT,
  agent_session_id TEXT,
  round INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  blocking INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  response_json TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS inbox_open ON inbox_item(status, run_id);
CREATE TABLE IF NOT EXISTS review (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES node(id),
  target_version INTEGER NOT NULL,
  decision TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  rollback_to TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_call (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  node_id TEXT,
  agent_session_id TEXT,
  tool TEXT NOT NULL,
  args_digest TEXT NOT NULL,
  affected_paths TEXT,
  exit_code INTEGER,
  duration_ms INTEGER NOT NULL,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  node_id TEXT,
  type TEXT NOT NULL,
  before TEXT,
  after TEXT,
  payload_json TEXT,
  ts TEXT NOT NULL
);
`

const now = (): string => new Date().toISOString()
const shortId = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`

/** Which transition table governs a row. */
export type Subject =
  | { table: 'run', id: string }
  | { table: 'node', id: string }
  | { table: 'inbox_item', id: string }

export class Store {
  readonly db: DatabaseSync
  private depth = 0

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.db.exec(SCHEMA)
    // Additive columns for databases created by earlier builds.
    const agentColumns = (this.db.prepare('PRAGMA table_info(node_agent)').all() as { name: string }[]).map(c => c.name)
    if (!agentColumns.includes('model')) this.db.exec('ALTER TABLE node_agent ADD COLUMN model TEXT')
  }

  close(): void {
    this.db.close()
  }

  /** Run `fn` in one transaction; nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++
      try { return fn() } finally { this.depth-- }
    }
    this.db.exec('BEGIN IMMEDIATE')
    this.depth = 1
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.depth = 0
    }
  }

  private get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[]
  }

  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...params).changes)
  }

  // ── events ───────────────────────────────────────────────────────────────

  event(runId: string, nodeId: string | null, type: string, before: string | null, after: string | null, payload?: unknown): void {
    this.run(
      'INSERT INTO event (run_id, node_id, type, before, after, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
      runId, nodeId, type, before, after, payload === undefined ? null : JSON.stringify(payload), now(),
    )
  }

  events(runId: string, limit = 200): EventRow[] {
    return this.all<EventRow>('SELECT * FROM event WHERE run_id = ? ORDER BY id DESC LIMIT ?', runId, limit)
  }

  /**
   * The single status write path: look up the governing table, apply the
   * transition (throws on illegal), persist, and append an event, atomically.
   * `extra` columns are written in the same UPDATE.
   */
  transition(subject: Subject, event: string, extra: Record<string, SQLInputValue> = {}, payload?: unknown): string {
    return this.tx(() => {
      const row = this.get<{ status: string, run_id?: string, id: string, kind?: string }>(`SELECT * FROM ${subject.table} WHERE id = ?`, subject.id)
      if (!row) throw new Error(`${subject.table} ${subject.id} not found`)
      const kind: MachineKind = subject.table === 'run' ? 'run' : subject.table === 'inbox_item' ? 'inbox' : row.kind === 'review' ? 'review' : 'ai'
      const to = apply(kind, row.status, event)
      const columns = { status: to, ...extra, ...(subject.table === 'run' ? { updated_at: now() } : {}) }
      const keys = Object.keys(columns)
      this.run(`UPDATE ${subject.table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => (columns as Record<string, SQLInputValue>)[k]!), subject.id)
      const runId = subject.table === 'run' ? subject.id : row.run_id!
      const nodeId = subject.table === 'node' ? subject.id : subject.table === 'inbox_item' ? (row as unknown as InboxRow).node_id : null
      this.event(runId, nodeId, `${subject.table}:${event}`, row.status, to, payload)
      return to
    })
  }

  // ── runs ─────────────────────────────────────────────────────────────────

  runBySession(sessionId: string): RunRow | undefined {
    return this.get<RunRow>('SELECT * FROM run WHERE session_id = ?', sessionId)
  }

  runById(id: string): RunRow | undefined {
    return this.get<RunRow>('SELECT * FROM run WHERE id = ?', id)
  }

  runs(): RunRow[] {
    return this.all<RunRow>('SELECT * FROM run ORDER BY created_at')
  }

  runsByStatus(...statuses: string[]): RunRow[] {
    return this.all<RunRow>(`SELECT * FROM run WHERE status IN (${statuses.map(() => '?').join(',')})`, ...statuses)
  }

  /**
   * Bind a run to a session: return the existing row, or create one with its
   * template nodes. session_id UNIQUE is the authority.
   */
  getOrCreateRun(input: {
    sessionId: string
    projectPath: string
    worktreePath?: string
    branch?: string | null
    baseRef?: string | null
    isGit?: boolean
    title: string
    requirement?: string
    config?: unknown
    id?: string
    /** Template id (full | small); defaults to full. */
    template?: string
  }, nodeKeys: readonly { key: string, kind: 'ai' | 'review' }[] = []): { run: RunRow, created: boolean } {
    return this.tx(() => {
      const existing = this.runBySession(input.sessionId)
      if (existing) return { run: existing, created: false }
      const id = input.id ?? shortId('WF')
      const t = now()
      const changes = this.run(
        `INSERT INTO run (id, session_id, project_path, worktree_path, branch, base_ref, is_git, title, requirement_text, template, config_json, status, current_node, loop_round, stall_ack_round, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', NULL, 0, 0, ?, ?) ON CONFLICT(session_id) DO NOTHING`,
        id, input.sessionId, input.projectPath, input.worktreePath ?? input.projectPath, input.branch ?? null, input.baseRef ?? null,
        input.isGit ? 1 : 0, input.title, input.requirement ?? '', input.template ?? 'full', JSON.stringify(input.config ?? {}), t, t,
      )
      if (changes === 1) {
        for (const n of nodeKeys) {
          this.run('INSERT INTO node (id, run_id, node_key, kind, status) VALUES (?, ?, ?, ?, ?)', shortId('N'), id, n.key, n.kind, 'PENDING')
        }
        this.event(id, null, 'run:create', null, 'CREATED', { sessionId: input.sessionId, template: input.template ?? 'full' })
      }
      return { run: this.runBySession(input.sessionId)!, created: changes === 1 }
    })
  }

  /** Test hook proving the UNIQUE constraint at the SQL level. */
  insertRawRun(row: Pick<RunRow, 'id' | 'session_id'>): void {
    const t = now()
    this.run(`INSERT INTO run (id, session_id, project_path, worktree_path, status, created_at, updated_at) VALUES (?, ?, '/', '/', 'CREATED', ?, ?)`, row.id, row.session_id, t, t)
  }

  updateRun(id: string, patch: Partial<Pick<RunRow, 'current_node' | 'loop_round' | 'stall_ack_round' | 'config_json' | 'worktree_path' | 'branch' | 'base_ref' | 'is_git'>>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[]
    if (keys.length === 0) return
    this.run(`UPDATE run SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map(k => patch[k] as SQLInputValue), now(), id)
  }

  // ── nodes ────────────────────────────────────────────────────────────────

  nodes(runId: string): NodeRow[] {
    return this.all<NodeRow>('SELECT * FROM node WHERE run_id = ?', runId)
  }

  node(runId: string, key: NodeKey): NodeRow {
    const row = this.get<NodeRow>('SELECT * FROM node WHERE run_id = ? AND node_key = ?', runId, key)
    if (!row) throw new Error(`node ${key} of ${runId} not found`)
    return row
  }

  nodeById(id: string): NodeRow | undefined {
    return this.get<NodeRow>('SELECT * FROM node WHERE id = ?', id)
  }

  patchNode(id: string, patch: Partial<Pick<NodeRow, 'attempt' | 'current_version' | 'final_version' | 'agent_session_id' | 'started_at' | 'ended_at' | 'error'>>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[]
    if (keys.length === 0) return
    this.run(`UPDATE node SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => patch[k] as SQLInputValue), id)
  }

  // ── node agents ──────────────────────────────────────────────────────────

  createAgentRow(input: { runId: string, nodeId: string, version: number, role: string }): NodeAgentRow {
    const id = shortId('A')
    this.run('INSERT INTO node_agent (id, run_id, node_id, version, role, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, input.runId, input.nodeId, input.version, input.role, 'RUNNING', now())
    return this.agentRow(id)!
  }

  agentRow(id: string): NodeAgentRow | undefined {
    return this.get<NodeAgentRow>('SELECT * FROM node_agent WHERE id = ?', id)
  }

  agentBySession(agentSessionId: string): NodeAgentRow | undefined {
    return this.get<NodeAgentRow>('SELECT * FROM node_agent WHERE agent_session_id = ?', agentSessionId)
  }

  agentsOfNode(nodeId: string, version?: number): NodeAgentRow[] {
    return version === undefined
      ? this.all<NodeAgentRow>('SELECT * FROM node_agent WHERE node_id = ? ORDER BY started_at', nodeId)
      : this.all<NodeAgentRow>('SELECT * FROM node_agent WHERE node_id = ? AND version = ? ORDER BY started_at', nodeId, version)
  }

  agentsOfRun(runId: string): NodeAgentRow[] {
    return this.all<NodeAgentRow>('SELECT * FROM node_agent WHERE run_id = ? ORDER BY started_at', runId)
  }

  agentsByStatus(...statuses: string[]): NodeAgentRow[] {
    return this.all<NodeAgentRow>(`SELECT * FROM node_agent WHERE status IN (${statuses.map(() => '?').join(',')})`, ...statuses)
  }

  patchAgent(id: string, patch: Partial<Pick<NodeAgentRow, 'agent_session_id' | 'model' | 'status' | 'report_json' | 'error' | 'ended_at'>>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[]
    if (keys.length === 0) return
    this.run(`UPDATE node_agent SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => patch[k] as SQLInputValue), id)
  }

  // ── versions ─────────────────────────────────────────────────────────────

  addVersion(input: Omit<NodeVersionRow, 'id' | 'created_at' | 'commit_sha'>): NodeVersionRow {
    const id = shortId('V')
    this.run(
      'INSERT INTO node_version (id, node_id, version, round, origin, artifacts_json, summary, structured_json, commit_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)',
      id, input.node_id, input.version, input.round, input.origin, input.artifacts_json, input.summary, input.structured_json, now(),
    )
    return this.get<NodeVersionRow>('SELECT * FROM node_version WHERE id = ?', id)!
  }

  /** Files attached after the version was recorded (the design review's review.md). */
  setVersionArtifacts(nodeId: string, version: number, artifacts: string[]): void {
    this.run('UPDATE node_version SET artifacts_json = ? WHERE node_id = ? AND version = ?', JSON.stringify(artifacts), nodeId, version)
  }

  setVersionCommit(nodeId: string, version: number, sha: string): void {
    this.run('UPDATE node_version SET commit_sha = ? WHERE node_id = ? AND version = ?', sha, nodeId, version)
  }

  versions(nodeId: string): NodeVersionRow[] {
    return this.all<NodeVersionRow>('SELECT * FROM node_version WHERE node_id = ? ORDER BY version', nodeId)
  }

  version(nodeId: string, version: number): NodeVersionRow | undefined {
    return this.get<NodeVersionRow>('SELECT * FROM node_version WHERE node_id = ? AND version = ?', nodeId, version)
  }

  versionsOfRun(runId: string): (NodeVersionRow & { node_key: string })[] {
    return this.all('SELECT v.*, n.node_key FROM node_version v JOIN node n ON n.id = v.node_id WHERE n.run_id = ? ORDER BY v.created_at', runId)
  }

  // ── reviews ──────────────────────────────────────────────────────────────

  addReview(input: Omit<ReviewRow, 'id' | 'created_at'>): void {
    this.run('INSERT INTO review (id, node_id, target_version, decision, comment, rollback_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      shortId('RV'), input.node_id, input.target_version, input.decision, input.comment, input.rollback_to, now())
  }

  reviewsOfRun(runId: string): (ReviewRow & { node_key: string })[] {
    return this.all('SELECT r.*, n.node_key FROM review r JOIN node n ON n.id = r.node_id WHERE n.run_id = ? ORDER BY r.created_at', runId)
  }

  // ── inbox ────────────────────────────────────────────────────────────────

  addInbox(input: Omit<InboxRow, 'id' | 'status' | 'response_json' | 'delivered_at' | 'created_at' | 'resolved_at'>): InboxRow {
    const id = shortId('IB')
    this.tx(() => {
      this.run(
        `INSERT INTO inbox_item (id, run_id, session_id, node_id, agent_session_id, round, kind, blocking, payload_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
        id, input.run_id, input.session_id, input.node_id, input.agent_session_id, input.round, input.kind, input.blocking, input.payload_json, now(),
      )
      this.event(input.run_id, input.node_id, `inbox_item:create:${input.kind}`, null, 'OPEN', { id })
    })
    return this.inboxItem(id)!
  }

  inboxItem(id: string): InboxRow | undefined {
    return this.get<InboxRow>('SELECT * FROM inbox_item WHERE id = ?', id)
  }

  patchInboxPayload(id: string, payload: unknown): void {
    this.run('UPDATE inbox_item SET payload_json = ? WHERE id = ?', JSON.stringify(payload), id)
  }

  inbox(filter: { runId?: string, status?: string, kind?: string } = {}): InboxRow[] {
    const where: string[] = []
    const params: SQLInputValue[] = []
    if (filter.runId) { where.push('run_id = ?'); params.push(filter.runId) }
    if (filter.status) { where.push('status = ?'); params.push(filter.status) }
    if (filter.kind) { where.push('kind = ?'); params.push(filter.kind) }
    return this.all<InboxRow>(`SELECT * FROM inbox_item ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`, ...params)
  }

  /** Non-blocking answers not yet handed to their agent. */
  undelivered(filter: { agentSessionId?: string, nodeId?: string }): InboxRow[] {
    if (filter.agentSessionId) {
      return this.all<InboxRow>(`SELECT * FROM inbox_item WHERE agent_session_id = ? AND status = 'RESOLVED' AND response_json IS NOT NULL AND delivered_at IS NULL AND blocking = 0 ORDER BY resolved_at`, filter.agentSessionId)
    }
    return this.all<InboxRow>(`SELECT * FROM inbox_item WHERE node_id = ? AND status = 'RESOLVED' AND response_json IS NOT NULL AND delivered_at IS NULL AND blocking = 0 ORDER BY resolved_at`, filter.nodeId ?? '')
  }

  markDelivered(ids: string[]): void {
    const t = now()
    for (const id of ids) this.run('UPDATE inbox_item SET delivered_at = ? WHERE id = ?', t, id)
  }

  // ── audit ────────────────────────────────────────────────────────────────

  toolCall(input: Omit<ToolCallRow, 'id' | 'ts'>): void {
    this.run('INSERT INTO tool_call (run_id, node_id, agent_session_id, tool, args_digest, affected_paths, exit_code, duration_ms, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      input.run_id, input.node_id, input.agent_session_id, input.tool, input.args_digest, input.affected_paths, input.exit_code, input.duration_ms, now())
  }

  toolCalls(runId: string, limit = 200): ToolCallRow[] {
    return this.all<ToolCallRow>('SELECT * FROM tool_call WHERE run_id = ? ORDER BY id DESC LIMIT ?', runId, limit)
  }
}
