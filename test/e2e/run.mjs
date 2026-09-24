#!/usr/bin/env node
/**
 * Acceptance e2e (keyless, fake LLM). Usage: node test/e2e/run.mjs [a b c d n s m k q]
 *  a) full template R → C → D ⇄ DR → H1 → T → V → H2 → X ⇄ Y → H3 → A:
 *     C sends a message and asks (b: the reply rides the next wf_* result);
 *     DR finds a blocker → back to D; H1 reject → D; V reads tasks.md;
 *     Y fails (write outside its scope refused, fix task appended) → X;
 *     H3 shows acceptance.md, rejected → X → Y → approved → A writes
 *     archive.md with the human decisions → COMPLETED; commits + artifacts
 *  c) two sessions run concurrently; items handled through one inbox
 *  d) stop DSH mid-run → INTERRUPTED → continue → completes
 *  n) non-git project dir; non-blocking wf_ask
 *  s) /rdfoe-workflow in a blank session: usage when bare; with a requirement
 *     it submits one user message, the model calls wf_start once (typed
 *     requirement and template) and replies in one line; again → status only
 *  m) small template via `/rdfoe-workflow --small`: S → H2 → X → Y → H3
 *     reject → X → Y → H3 approve → A; wf_start's template parameter
 *  k) C blocked → BLOCKED + inbox notice → reply reruns C → blocked again →
 *     「按当前需求继续」 → D
 *  q) DR keeps blocking → design-loop stall → 「带着阻断交给我审核」 → H1
 *  v) a session started by /rdfoe-workflow is an ordinary session: DSH lists
 *     it as not blank with its generated title 「工作流 · <需求>」 (also after
 *     another session is created and after a DSH restart); a pre-beta.5 bound
 *     blank session heals via /session/engage without a model request
 *  u) the web UI in a fresh headless Chrome: DSH's sidebar 工作区 block and
 *     the plugin's 收件箱 entry render, and no slot entry crashed
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  api, assert, fakeRequests, git, log, makeSampleRepo, makeWorkspace, node, respond, runSnap, setScenario,
  dumpState, inspectUi, sessions, sleep, startDsh, startFake, startWorkflowSession, stopAll, stopDsh, waitFor, waitItem, waitNode,
} from './harness.mjs'

const selected = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['a', 'b', 'c', 'd', 'n', 's', 'm', 'k', 'q', 'v', 'u'])
const ws = makeWorkspace()
log('workspace', ws.dir)

const req = (content) => ({ name: 'wf_write', input: { path: '{dir}/requirement.md', content } })
const SCENARIO = [
  // a + b: C sends a message, then asks a blocking question.
  { match: { title: 'A', role: 'C' }, calls: [
    { name: 'wf_message', input: { text: '我先读了需求录入稿，准备确认数值范围。', level: 'info', expectReply: true } },
    { name: 'wf_ask', input: { questions: [{ id: 'q1', header: '范围', question: 'add 需要支持浮点数吗？', options: [{ label: '支持' }, { label: '不支持' }] }] } },
    req('# 需求（澄清后）\n\n- **FR-1**：add(a,b) 返回整数和。\n\n## 澄清记录\n- 问：支持浮点数吗？答：不支持。\n'),
    { name: 'wf_report', input: { summary: '澄清完成', artifacts: [], openIssues: [], confidence: 0.8, blocked: false } },
  ], say: 'clarified' },
  // a: the first design review blocks.
  { match: { title: 'A', role: 'DR', v: 1 }, calls: [
    { name: 'wf_write', input: { path: '{dir}/review.md', content: '# 设计评审\n\n- F-1（阻断）：没有说明非数字输入的处理。\n\n## 结论\n不通过\n' } },
    { name: 'wf_report', input: { summary: '设计审查：1 个阻断', artifacts: [], openIssues: [], confidence: 0.9, verdict: 'fail', items: [{ id: 'F-1', result: 'fail', evidence: 'design.md 未说明非数字输入的处理' }, { id: 'FR-1', result: 'pass', evidence: 'design.md 覆盖 FR-1' }] } },
  ], say: 'dr v1 blocked' },
  // a: X round 1 writes a bug, runs the test, then an unlisted shell pipeline.
  { match: { title: 'A', role: 'X', round: 1 }, calls: [
    { name: 'wf_write', input: { path: 'src/add.js', content: 'module.exports = (a, b) => a - b\n' } },
    { name: 'wf_exec', input: { command: 'npm test' } },
    { name: 'wf_exec', input: { command: 'node --version && echo "shell ok" | tr a-z A-Z', reason: '确认 Node 版本' } },
    { name: 'wf_write', input: { path: '{dir}/verification.md', content: '# 实施证据 第 {round} 轮\n' } },
    { name: 'wf_report', input: { summary: '实现 add', artifacts: ['src/add.js'], openIssues: [], confidence: 0.7 } },
  ], say: 'x r1 done' },
  // a: Y records, is refused an application-code write, appends a fix task, and fails the round.
  { match: { title: 'A', role: 'Y', round: 1 }, calls: [
    { name: 'wf_exec', input: { command: 'npm test' } },
    { name: 'wf_write', input: { path: '{dir}/verification.md', content: '# 验证记录 第 {round} 轮\n\n- VP-1：npm test exit 1（add(2,3) !== 5），失败 → F-1\n' } },
    { name: 'wf_write', input: { path: 'src/add.js', content: 'module.exports = (a, b) => a + b\n' } },
    { name: 'wf_edit', input: { path: '{tasks}', old_text: '完成判据：npm test 通过\n', new_text: '完成判据：npm test 通过\n- [ ] T2 修复 F-1（VP-1：add(2,3) !== 5）；完成判据：npm test 通过\n' } },
    { name: 'wf_report', input: { summary: '验证未通过', artifacts: [], openIssues: [], confidence: 0.9, verdict: 'fail', items: [{ id: 'VP-1', result: 'fail', evidence: 'npm test exit 1: add(2,3) !== 5' }] } },
  ], say: 'y r1 done' },
  { match: { title: 'A', role: 'X', round: 2 }, calls: [
    { name: 'wf_edit', input: { path: 'src/add.js', old_text: 'a - b', new_text: 'a + b' } },
    { name: 'wf_exec', input: { command: 'npm test' } },
    { name: 'wf_write', input: { path: '{dir}/verification.md', content: '# 实施证据 第 {round} 轮\nT2：修复减号。\n' } },
    { name: 'wf_report', input: { summary: '修复 F-1', artifacts: ['src/add.js'], openIssues: [], confidence: 0.9 } },
  ], say: 'x r2 done' },
  // d: R asks; the host restarts while it waits; the resumed agent finishes without asking again.
  { match: { title: 'R', role: 'R', resume: 0 }, calls: [
    { name: 'wf_ask', input: { questions: [{ id: 'q1', question: '重启前的问题：用哪个目录？', options: [{ label: 'src' }, { label: 'lib' }] }] } },
    req('# 需求\n'),
    { name: 'wf_report', input: { summary: '需求', artifacts: [], openIssues: [], confidence: 0.8 } },
  ], say: 'r done' },
  { match: { title: 'R', role: 'R', resume: 1 }, calls: [
    req('# 需求（恢复后完成）\n'),
    { name: 'wf_report', input: { summary: '恢复后完成需求录入', artifacts: [], openIssues: [], confidence: 0.8 } },
  ], say: 'r resumed done' },
  // n: non-blocking question answered while the agent keeps going, then a blocking one.
  { match: { title: 'N', role: 'R', v: 1 }, calls: [
    { name: 'wf_ask', input: { blocking: false, questions: [{ id: 'nb', question: '非阻塞：命名风格？', options: [{ label: 'camelCase' }, { label: 'snake_case' }] }] } },
    { name: 'wf_ask', input: { questions: [{ id: 'b', question: '阻塞：继续吗？', options: [{ label: '继续' }] }] } },
    req('# 需求\n'),
    { name: 'wf_report', input: { summary: '需求', artifacts: [], openIssues: [], confidence: 0.8 } },
  ], say: 'n r done' },
  // k: C stays blocked, with and without the user's reply.
  { match: { title: 'K', role: 'C' }, calls: [
    req('# 需求（澄清中）\n\n## 未决\n- 数据保留策略未定\n'),
    { name: 'wf_report', input: { summary: '仍有阻断', artifacts: [], openIssues: ['数据保留策略未定（replied={replied}）'], confidence: 0.4, blocked: true } },
  ], say: 'k blocked' },
  // q: DR blocks every time.
  { match: { title: 'Q', role: 'DR' }, calls: [
    { name: 'wf_write', input: { path: '{dir}/review.md', content: '# 设计评审 v{v}\n\n- F-1（阻断）：仍缺错误处理。\n' } },
    { name: 'wf_report', input: { summary: '仍有阻断', artifacts: [], openIssues: [], confidence: 0.9, verdict: 'fail', items: [{ id: 'F-1', result: 'fail', evidence: 'design.md 仍缺错误处理' }] } },
  ], say: 'q blocked' },
]

async function approveGate(sessionId, gate) {
  const item = await waitItem(sessionId, i => i.kind === 'review' && i.payload.gate === gate, `${gate} review item`)
  await respond(item.id, { action: 'approve' })
  return item
}

const reqOf = async (pred) => (await fakeRequests()).find(pred)

async function scenarioA() {
  log('── a) full template ──')
  const repo = makeSampleRepo(ws.dir, 'repo-a')
  const { sessionId, run } = await startWorkflowSession(repo, 'A', '实现一个 add(a,b) 函数并通过 npm test')
  assert(run.is_git === 1 && run.branch === `rdfoe/${run.id}` && run.template === 'full', 'run has a worktree branch and the full template')
  let s = await runSnap(sessionId)
  assert(s.nodes.map(n => n.node_key).join() === 'R,C,D,DR,H1,T,V,H2,X,Y,H3,A', 'full template nodes: R, C, D, DR, H1, T, V, H2, X, Y, H3, A')

  // b) message + reply; C asks one question
  const msg = await waitItem(sessionId, i => i.kind === 'message', 'C message item')
  assert(msg.payload.expectReply === true && msg.agentRole === 'C', 'b) wf_message landed in the inbox with source C')
  const q = await waitItem(sessionId, i => i.kind === 'question', 'C question item')
  await waitNode(sessionId, 'C', n => n.status === 'WAITING_ANSWER', 'C WAITING_ANSWER')
  await respond(msg.id, { action: 'reply', text: '好的，按整数来' })
  await respond(q.id, { action: 'answer', answers: { q1: { selected: ['不支持'] } } })

  // D ⇄ DR: the first review blocks, D v2 answers it, DR v2 passes
  const h1 = await waitItem(sessionId, i => i.kind === 'review' && i.payload.gate === 'H1', 'H1 review item')
  const reqs = await fakeRequests()
  assert(reqs.some(r => r.marker?.title === 'A' && r.marker.role === 'C' && r.lastToolResult.includes('答：不支持') && r.lastToolResult.includes('好的，按整数来')),
    'b) the reply to wf_message came back with the next wf_* tool result (wf_ask), together with the answer')
  assert(reqs.every(r => !r.hiddenMetadata) && reqs.some(r => r.marker?.role === 'R'), 'node prompts carry no hidden metadata; the fake recognises nodes from ordinary content')
  const rPrompt = (await reqOf(r => r.marker?.title === 'A' && r.marker.role === 'R'))?.prompt ?? ''
  assert(rPrompt.startsWith('本节点：需求录入（R），第 1 版，执行 PH ph-require。流程模板：完整流程（full）') && rPrompt.includes('# requirement-template.md'), 'R runs ph-require with the bundled PH template')
  const d2 = await reqOf(r => r.marker?.title === 'A' && r.marker.role === 'D' && r.marker.v === '2')
  assert(d2 && d2.prompt.includes('## 设计审查的阻断发现') && d2.prompt.includes('F-1：design.md 未说明非数字输入的处理') && d2.prompt.includes('/C/v1/requirement.md'),
    'DR blocked → D v2 got the finding and the clarified requirement (automatic D ⇄ DR loop)')
  s = await runSnap(sessionId)
  assert(node(s, 'D').current_version === 2 && node(s, 'DR').current_version === 2 && h1.payload.subjects.map(x => x.node).join() === 'C,D,DR', 'H1 opened after DR v2 passed; it shows C, D and DR')
  assert(s.designLoop.length === 2 && s.designLoop[0].failed === 1 && s.designLoop[1].failed === 0, 'design loop record: review 1 blocked, review 2 clean')

  // H1 reject → D v3 → DR v3 → H1 approve
  let rejected = false
  try { await respond(h1.id, { action: 'reject', comment: '' }) } catch { rejected = true }
  assert(rejected, 'rejection without a comment is refused')
  await respond(h1.id, { action: 'reject', comment: '请补充输入校验', rollbackTo: 'D' })
  const h1b = await waitItem(sessionId, i => i.kind === 'review' && i.payload.gate === 'H1', 'H1 again')
  const d3 = await reqOf(r => r.marker?.title === 'A' && r.marker.role === 'D' && r.marker.v === '3')
  assert(d3.prompt.includes('设计批准（H1）打回 v2：请补充输入校验') && d3.prompt.includes('上一版 v2 设计（design.md）'), 'D v3 got the H1 rejection and its previous version')
  assert(h1b.payload.subjects.find(x => x.node === 'D').version === 3, 'H1 now reviews D v3')
  await respond(h1b.id, { action: 'approve' })

  // T → V (sequential; V reads tasks.md) → H2
  const h2 = await waitItem(sessionId, i => i.kind === 'review' && i.payload.gate === 'H2', 'H2 review item')
  s = await runSnap(sessionId)
  const tasksPath = `.rdfoe/runs/${s.run.id}/T/v1/tasks.md`
  const tDone = s.versions.find(v => v.node_key === 'T').created_at
  const vStart = s.agents.find(a => a.role === 'V').started_at
  assert(tDone <= vStart && s.toolCalls.some(t => t.tool === 'wf_read' && t.args_digest.includes(tasksPath) && t.exit_code === 0), 'V ran after T and read tasks.md')
  assert(h2.payload.subjects.map(x => x.node).join() === 'T,V' && h2.payload.rollbackTargets.join() === 'T,V', 'H2 (授权实施) reviews T and V; rollback to T or V')
  await respond(h2.id, { action: 'approve' })

  // X ⇄ Y: Y fails round 1 → X round 2 → Y passes
  s = await waitFor('H3 review', async () => {
    const snap = await runSnap(sessionId)
    return snap.inbox.find(i => i.status === 'OPEN' && i.kind === 'review' && i.payload.gate === 'H3') ? snap : undefined
  })
  assert(s.loop.length === 2 && s.loop[0].failed === 1 && s.loop[1].failed === 0, 'loop record: round 1 failed 1 item, round 2 passed')
  const execs = s.toolCalls.filter(t => t.tool === 'wf_exec')
  assert(execs.some(t => t.args_digest.includes('npm') && t.exit_code === 1) && execs.some(t => t.args_digest.includes('npm') && t.exit_code === 0), 'wf_exec ran npm test (failing then passing), audited')
  assert(execs.some(t => t.args_digest.includes('shell ok') && t.exit_code === 0), 'wf_exec runs shell pipelines without approval items')
  assert(s.toolCalls.some(t => t.tool === 'wf_write' && t.args_digest.includes('src/add.js') && t.exit_code === -1 && s.agents.find(a => a.agent_session_id === t.agent_session_id)?.role === 'Y'),
    'Y was refused a write to application code (scoped to verification.md + tasks.md)')
  assert(readFileSync(join(s.run.worktree_path, tasksPath), 'utf8').includes('T2 修复 F-1'), 'Y appended the fix task to tasks.md')
  const x2 = await reqOf(r => r.marker?.title === 'A' && r.marker.role === 'X' && r.marker.round === '2')
  assert(x2 && x2.marker.tasks === tasksPath && x2.prompt.includes('上一轮验证记录') && x2.prompt.includes('VP-1：npm test exit 1'), 'X round 2 got tasks.md, the previous verification record and the failed item')
  const h3 = s.inbox.find(i => i.status === 'OPEN' && i.kind === 'review' && i.payload.gate === 'H3')
  assert(h3.payload.acceptanceGuide === `.rdfoe/runs/${s.run.id}/V/v1/acceptance.md` && h3.payload.rollbackTargets.join() === 'X', 'H3 (用户验收) shows acceptance.md; rejections go back to X')

  // H3 reject → X round 3 → Y → H3 approve → A
  await respond(h3.id, { action: 'reject', comment: '请在验证记录里写明 Node 版本' })
  await waitFor('X round 3', async () => (await fakeRequests()).some(r => r.marker?.title === 'A' && r.marker.role === 'X' && r.marker.round === '3'))
  const x3 = await reqOf(r => r.marker?.title === 'A' && r.marker.role === 'X' && r.marker.round === '3')
  assert(x3.prompt.includes('用户验收（H3）打回') && x3.prompt.includes('请在验证记录里写明 Node 版本'), 'the H3 rejection reached X (user acceptance feedback)')
  await approveGate(sessionId, 'H3')
  s = await waitFor('run COMPLETED', async () => { const snap = await runSnap(sessionId); return snap.run.status === 'COMPLETED' ? snap : undefined })
  const aPrompt = (await reqOf(r => r.marker?.title === 'A' && r.marker.role === 'A'))?.prompt ?? ''
  assert(aPrompt.includes('## 审核记录') && aPrompt.includes('用户验收（H3）') && aPrompt.includes('打回到 X，意见：请在验证记录里写明 Node 版本') && aPrompt.includes('最终验证记录'), 'A got every human decision and the final evidence')
  assert(true, 'a) run COMPLETED after A')

  // branch + artifacts
  const wt = s.run.worktree_path
  const log1 = git(wt, 'log', '--format=%s', `${s.run.base_ref}..HEAD`)
  log('branch log:\n' + log1)
  for (const pattern of [/DR design review blocked D v1/, /H1 approved C v1, D v3, DR v3/, /H2 approved T v1, V v1/, /X round 1/, /Y verification failed \(round 1\)/, /X round 2/, /Y verification passed \(round 2\)/, /X round 3/, /A archived/]) {
    assert(pattern.test(log1), `commit on ${s.run.branch}: ${pattern.source}`)
  }
  for (const f of ['R/v1/requirement.md', 'C/v1/requirement.md', 'D/v1/design.md', 'D/v3/design.md', 'DR/v1/review.md', 'DR/v3/review.md', 'T/v1/tasks.md', 'V/v1/verify-plan.md', 'V/v1/acceptance.md', 'X/v1/verification.md', 'X/v3/verification.md', 'Y/v1/verification.md', 'Y/v3/verification.md', 'Y/v3/acceptance-report.md', 'A/v1/archive.md']) {
    assert(existsSync(join(wt, '.rdfoe/runs', s.run.id, f)), `artifact ${f} exists`)
  }
  assert(readFileSync(join(wt, 'src/add.js'), 'utf8').includes('a + b'), 'code change is on the run branch')
  assert(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main' && !existsSync(join(repo, 'src/add.js')), 'the original checkout is untouched (no merge)')
  assert(git(wt, 'status', '--porcelain') === '', 'worktree clean after the final commit')
  const list = await api('/dev/sessions')
  const nodeSessions = s.agents.map(a => a.agent_session_id)
  const rows = list.filter(r => nodeSessions.includes(r.sessionId))
  assert(rows.length > 0 && rows.every(r => r.origin === 'subagent' && r.parentSessionId === sessionId), 'node sessions are subagent sessions of the main session')
}

async function scenarioC() {
  log('── c) two concurrent workflows, one inbox ──')
  const r1 = makeSampleRepo(ws.dir, 'repo-c1')
  const r2 = makeSampleRepo(ws.dir, 'repo-c2')
  // C1 starts through the model's wf_start; C2 through the workflow view's start form (POST /run/start).
  const plain = await api('/dev/session', { cwd: r2, text: '@title C2\n先聊聊需求。' })
  const [a, b] = await Promise.all([
    startWorkflowSession(r1, 'C1', '需求 C1：add'),
    (async () => {
      await waitFor('plain session idle', async () => (await api('/dev/sessions')).some(s => s.sessionId === plain.sessionId && !s.running))
      const started = await api('/run/start', { sessionId: plain.sessionId, requirement: '需求 C2：add', title: 'C2' })
      sessions.push(plain.sessionId)
      return { sessionId: plain.sessionId, runId: started.runId }
    })(),
  ])
  assert((await runSnap(b.sessionId)).run.worktree_path.includes(b.runId), 'c) the empty-state start form (POST /run/start) created a run with its own worktree')
  const handled = new Set()
  while (true) {
    const [sa, sb] = await Promise.all([runSnap(a.sessionId), runSnap(b.sessionId)])
    if (sa.run.status === 'COMPLETED' && sb.run.status === 'COMPLETED') break
    const inbox = await api('/inbox?status=open')
    const reviews = inbox.items.filter(i => i.kind === 'review' && (i.runId === a.runId || i.runId === b.runId) && !handled.has(i.id))
    for (const item of reviews) {
      handled.add(item.id)
      await respond(item.id, { action: 'approve' })
      log(`approved ${item.payload.gate} of ${item.runTitle} via the shared inbox (source session title: ${item.sessionTitle})`)
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  const titles = new Set([...handled].length ? (await api('/inbox?status=all')).items.filter(i => handled.has(i.id)).map(i => i.runId) : [])
  assert(titles.has(a.runId) && titles.has(b.runId) && handled.size === 6, 'c) six review items from two runs handled in one inbox; both runs COMPLETED')
  const sa = await runSnap(a.sessionId)
  const sb = await runSnap(b.sessionId)
  const overlap = sa.agents.some(x => sb.agents.some(y => x.started_at < (y.ended_at ?? '9') && y.started_at < (x.ended_at ?? '9')))
  assert(overlap, 'c) agents of the two runs overlapped in time (concurrent)')
}

async function scenarioD() {
  log('── d) restart recovery ──')
  const repo = makeSampleRepo(ws.dir, 'repo-d')
  const { sessionId, runId } = await startWorkflowSession(repo, 'R', '需求 R：重启恢复')
  const q = await waitItem(sessionId, i => i.kind === 'question', 'R question before restart')
  await stopDsh()
  log('DSH stopped while R waits on', q.id)
  await startDsh(ws)
  let s = await runSnap(sessionId)
  assert(s.run.status === 'INTERRUPTED' && node(s, 'R').status === 'INTERRUPTED', 'd) run and R are INTERRUPTED after restart')
  assert(s.inbox.find(i => i.id === q.id)?.status === 'OPEN', 'd) the unanswered question survived the restart')
  await respond(q.id, { action: 'answer', answers: { q1: { selected: ['src'] } } })
  await api('/run/continue', { runId })
  await waitNode(sessionId, 'R', n => n.status === 'SUCCEEDED', 'R completes after continue')
  const reqs = await fakeRequests()
  assert(reqs.some(r => r.marker?.title === 'R' && r.marker.resume === '1'), 'd) the R agent session was resumed with a continue prompt')
  s = await runSnap(sessionId)
  const dAgents = s.agents.filter(a => a.node_id === node(s, 'R').id && a.role === 'R')
  assert(dAgents.length === 1, 'd) the same agent row/session was resumed (no second R agent)')
  const starts = s.events.filter(e => e.type === 'agent:start').map(e => JSON.parse(e.payload_json))
  const resumed = starts.find(p => p.resume === true)
  assert(resumed && resumed.agentSessionId === dAgents[0].agent_session_id && !s.events.some(e => e.type === 'agent:resume-failed'), 'd) cold resume reused the original node session (no fallback)')
  log(`d) resumed attach mode: ${resumed.attach}`)
  const list = await api('/dev/sessions')
  const mainRow = list.find(r => r.sessionId === sessionId)
  log(`d) main session after resolveAgent: running=${mainRow?.running} agentAvailable=${mainRow?.agentAvailable}`)
  assert(mainRow && mainRow.running === false, 'd) resolving the main agent did not start a turn in the main session')
  for (const gate of ['H1', 'H2', 'H3']) await approveGate(sessionId, gate)
  await waitFor('run R COMPLETED', async () => (await runSnap(sessionId)).run.status === 'COMPLETED')
  assert(true, 'd) run completed after restart + continue')
}

async function scenarioN() {
  log('── n) non-git dir, non-blocking ask ──')
  const dir = join(ws.dir, 'plain-n')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'plain', scripts: { test: 'node -e 0' } }))
  const { sessionId, run } = await startWorkflowSession(dir, 'N', '非 git 目录')
  assert(run.is_git === 0 && run.worktree_path === dir && run.branch === null, 'n) non-git run works directly in the project directory')
  const nb = await waitItem(sessionId, i => i.kind === 'question' && !i.blocking, 'non-blocking question')
  const b = await waitItem(sessionId, i => i.kind === 'question' && i.blocking, 'blocking question after the non-blocking one')
  await respond(nb.id, { action: 'answer', answers: { nb: { selected: ['snake_case'] } } })
  await respond(b.id, { action: 'answer', answers: { b: { selected: ['继续'] } } })
  await waitNode(sessionId, 'R', n => n.status === 'SUCCEEDED', 'R done')
  const reqs = await fakeRequests()
  assert(reqs.some(r => r.marker?.title === 'N' && r.lastToolResult.includes('【用户的新回复】') && r.lastToolResult.includes('snake_case')), 'n) the non-blocking answer arrived with the next wf_* tool result')
  for (const gate of ['H1', 'H2', 'H3']) await approveGate(sessionId, gate)
  const s = await waitFor('run N COMPLETED', async () => { const snap = await runSnap(sessionId); return snap.run.status === 'COMPLETED' ? snap : undefined })
  assert(existsSync(join(dir, 'src/add.js')) && existsSync(join(dir, '.rdfoe/runs', s.run.id, 'D/v1/design.md')) && existsSync(join(dir, '.rdfoe/runs', s.run.id, 'A/v1/archive.md')), 'n) non-git run completed with files in the project directory')
}

/** Wait for the run a /rdfoe-workflow turn binds to the session. */
async function waitRun(sessionId, label) {
  return waitFor(label, async () => { const snap = await runSnap(sessionId); return snap.run ? snap : undefined })
}
const wfStartCalls = async sessionReqs => (await fakeRequests()).filter(r => r.marker === null && r.decision?.tool?.name === 'wf_start' && (!sessionReqs || sessionReqs(r)))

async function scenarioS() {
  log('── s) /rdfoe-workflow slash command in a blank session ──')
  const repo = makeSampleRepo(ws.dir, 'repo-s')
  const { sessionId } = await api('/dev/session', { cwd: repo })
  sessions.push(sessionId)
  const command = line => api('/dev/command', { sessionId, line })
  const startsBefore = (await wfStartCalls()).length

  const bare = await command('/rdfoe-workflow')
  assert(bare.execution?.result.kind === 'success' && bare.execution.result.text.includes('用法：/rdfoe-workflow [--small] <需求>'), 's) bare command in a blank session prints usage, not an error')
  assert((await runSnap(sessionId)).run === null, 's) bare command starts nothing')

  const requirement = '实现一个 add(a,b) 函数并通过 npm test'
  const started = await command(`/rdfoe-workflow ${requirement}`)
  const text = started.execution?.result.text ?? ''
  assert(started.execution?.result.kind === 'success' && text.startsWith('正在开启工作流（完整流程）'), `s) command hands the requirement to the model: ${text}`)
  const snap = await waitRun(sessionId, 's) run bound by the model turn')
  assert(snap.run.requirement_text === requirement && snap.run.template === 'full' && snap.run.status === 'RUNNING', 's) wf_start bound the run with the typed requirement and template, RUNNING')
  assert(snap.run.is_git === 1 && snap.run.branch === `rdfoe/${snap.run.id}` && existsSync(snap.run.worktree_path), 's) same worktree rule as wf_start')
  const reqs = await fakeRequests()
  const startReq = reqs.find(r => r.marker === null && r.decision?.tool?.name === 'wf_start' && r.decision.tool.input.requirement === requirement)
  assert(startReq && startReq.tools.includes('wf_start'), 's) the model got the start message as a user turn and called wf_start')
  await waitFor('short reply', async () => (await fakeRequests()).some(r => r.marker === null && r.decision?.text === '工作流已启动，点下面的卡片可以查看进度。'))
  await waitNode(sessionId, 'R', n => n.status === 'RUNNING' || n.status === 'SUCCEEDED', 's) R node started')

  const again = await command('/rdfoe-workflow 另一个需求')
  assert(/^本会话的工作流 /u.test(again.execution?.result.text ?? '') && again.execution.result.text.includes('没有采用') && (await runSnap(sessionId)).run.id === snap.run.id, 's) repeating the command reports the bound run and submits nothing')
  const status = await command('/rdfoe-workflow')
  assert((status.execution?.result.text ?? '').startsWith(`本会话的工作流 ${snap.run.id}`), 's) bare command reports the bound run')
  await sleep(500)
  assert((await wfStartCalls()).length === startsBefore + 1, 's) exactly one wf_start call for this session')
  await api('/run/cancel', { runId: snap.run.id })
}

async function scenarioM() {
  log('── m) small template via /rdfoe-workflow --small ──')
  const repo = makeSampleRepo(ws.dir, 'repo-m')
  const { sessionId } = await api('/dev/session', { cwd: repo })
  sessions.push(sessionId)
  const title = 'M：给 add 做小改动'
  const started = await api('/dev/command', { sessionId, line: `/rdfoe-workflow --small ${title}` })
  const text = started.execution?.result.text ?? ''
  assert(text.startsWith('正在开启工作流（小改动流程）'), `m) --small handed a small-change start to the model: ${text}`)
  let s = await waitRun(sessionId, 'm) small run bound')
  assert(s.run.template === 'small' && s.template.id === 'small' && s.nodes.map(n => n.node_key).join() === 'S,H2,X,Y,H3,A' && s.run.requirement_text === title,
    'm) run recorded as small with nodes S, H2, X, Y, H3, A and the flag stripped from the requirement')

  const h2 = await waitItem(sessionId, i => i.kind === 'review' && i.payload.gate === 'H2', 'H2 (small)')
  s = await runSnap(sessionId)
  const runId = s.run.id
  for (const f of ['change.md', 'tasks.md', 'verify-plan.md', 'acceptance.md']) assert(existsSync(join(s.run.worktree_path, '.rdfoe/runs', runId, 'S/v1', f)), `m) S wrote ${f}`)
  const sPrompt = (await reqOf(r => r.marker?.run === runId && r.marker.role === 'S'))?.prompt ?? ''
  assert(sPrompt.includes('执行 PH ph-small-change。流程模板：小改动（small）') && sPrompt.includes('# change-template.md') && sPrompt.includes('# acceptance-template.md'), 'm) S got the small template and the PH templates')
  assert(h2.payload.subjects.map(x => x.node).join() === 'S' && h2.payload.rollbackTargets.join() === 'S', 'm) H2 (授权实施) reviews S')
  await respond(h2.id, { action: 'approve' })

  const h3 = await waitItem(sessionId, i => i.kind === 'review' && i.payload.gate === 'H3', 'H3 (small)')
  assert(h3.payload.acceptanceGuide === `.rdfoe/runs/${runId}/S/v1/acceptance.md` && h3.payload.rollbackTargets.join() === 'X', 'm) H3 shows S\'s acceptance guide; rollback to X')
  const x1 = await reqOf(r => r.marker?.run === runId && r.marker.role === 'X')
  assert(x1.marker.tasks === `.rdfoe/runs/${runId}/S/v1/tasks.md` && x1.prompt.includes('小改动说明（change.md）'), 'm) X works from S\'s change.md and tasks.md')
  await respond(h3.id, { action: 'reject', comment: '请在验证记录里写明 Node 版本' })
  await waitFor('X round 2 after the H3 rejection', async () => (await fakeRequests()).some(r => r.marker?.run === runId && r.marker.role === 'X' && r.marker.round === '2'))
  const x2 = await reqOf(r => r.marker?.run === runId && r.marker.role === 'X' && r.marker.round === '2')
  assert(x2.prompt.includes('用户验收（H3）打回') && x2.prompt.includes('请在验证记录里写明 Node 版本'), 'm) the H3 rejection comment reached X')
  await approveGate(sessionId, 'H3')
  s = await waitFor('run M COMPLETED', async () => { const snap = await runSnap(sessionId); return snap.run.status === 'COMPLETED' ? snap : undefined })
  const log1 = git(s.run.worktree_path, 'log', '--format=%s', `${s.run.base_ref}..HEAD`)
  for (const pattern of [/H2 approved S v1/, /X round 1/, /X round 2/, /Y verification passed \(round 2\)/, /A archived/]) assert(pattern.test(log1), `m) commit: ${pattern.source}`)
  assert(existsSync(join(s.run.worktree_path, '.rdfoe/runs', runId, 'A/v1/archive.md')) && s.nodes.every(n => n.status === 'SUCCEEDED' || n.status === 'APPROVED'), 'm) small run COMPLETED with an archive')

  const viaTool = await startWorkflowSession(makeSampleRepo(ws.dir, 'repo-m2'), 'M2', '小改动 M2', 'small')
  assert(viaTool.run.template === 'small', 'm) wf_start {template: "small"} starts a small-change run')
  await api('/run/cancel', { runId: viaTool.runId })
}

async function scenarioK() {
  log('── k) blocked clarification ──')
  const { sessionId, runId } = await startWorkflowSession(makeSampleRepo(ws.dir, 'repo-k'), 'K', '需求 K：数据保留')
  let s = await waitNode(sessionId, 'C', n => n.status === 'BLOCKED', 'C BLOCKED')
  const notice = await waitItem(sessionId, i => i.kind === 'message' && i.payload.blocked === true, 'blocked notice')
  assert(notice.payload.text.includes('数据保留策略未定') && s.run.current_node === 'C' && node(s, 'D').status === 'PENDING', 'k) C blocked: node BLOCKED, the blockers are in the inbox, D does not start')
  await respond(notice.id, { action: 'reply', text: '保留 30 天' })
  s = await waitFor('C rerun blocked again', async () => {
    const snap = await runSnap(sessionId)
    return node(snap, 'C').current_version === 2 && node(snap, 'C').status === 'BLOCKED' ? snap : undefined
  })
  const c2 = await reqOf(r => r.marker?.run === runId && r.marker.role === 'C' && r.marker.v === '2')
  assert(c2 && c2.marker.replied === '1' && c2.prompt.includes('保留 30 天'), 'k) replying to the notice reran C (v2) with the reply')
  await api('/node/accept', { runId, node: 'C' })
  await waitNode(sessionId, 'D', n => n.status === 'SUCCEEDED' || n.status === 'RUNNING', 'D after accept')
  s = await runSnap(sessionId)
  assert(node(s, 'C').status === 'SUCCEEDED' && !s.inbox.some(i => i.status === 'OPEN' && i.payload?.blocked), 'k) 「按当前需求继续」 moved on to D and withdrew the notice')
  await api('/run/cancel', { runId })
}

async function scenarioQ() {
  log('── q) design loop stall ──')
  const { sessionId, runId } = await startWorkflowSession(makeSampleRepo(ws.dir, 'repo-q'), 'Q', '需求 Q：设计总被挡')
  const stall = await waitItem(sessionId, i => i.kind === 'loop_stall', 'design loop stall', 90_000)
  let s = await runSnap(sessionId)
  assert(stall.payload.loop === 'design' && s.run.status === 'PAUSED' && node(s, 'D').current_version === 3 && node(s, 'DR').current_version === 3, 'q) three blocking reviews in a row paused the run with a design-loop stall')
  await respond(stall.id, { action: 'to_review' })
  const h1 = await waitItem(sessionId, i => i.kind === 'review' && i.payload.gate === 'H1', 'H1 after to_review')
  assert(h1.payload.subjects.find(x => x.node === 'DR').verdict === 'fail', 'q) 「带着阻断交给我审核」 opened H1 with the blocking review visible')
  await api('/run/cancel', { runId })
}

async function scenarioV() {
  log('── v) command-started session is an ordinary, listed session ──')
  const summary = async id => (await api('/dev/sessions')).find(i => i.sessionId === id)
  const repo = makeSampleRepo(ws.dir, 'repo-v')
  const { sessionId } = await api('/dev/session', { cwd: repo })
  sessions.push(sessionId)
  assert((await summary(sessionId))?.blank === true, 'v) a new session starts blank (DSH hides blank sessions it is not showing)')
  const requirement = '给 capitalize 增加一个 titleCase(str) 函数，并补上单元测试'
  await api('/dev/command', { sessionId, line: `/rdfoe-workflow ${requirement}` })
  await waitRun(sessionId, 'v) run bound')
  const title = `工作流 · ${requirement.slice(0, 24)}`
  const listed = await waitFor('session titled and not blank', async () => { const s = await summary(sessionId); if (s?.blank === false && s.title === title) return s; throw new Error(JSON.stringify(s)) }, 20_000)
  assert(listed.title === title, `v) DSH lists the session as an ordinary session with DSH's own title 「${listed.title}」`)
  const other = await api('/dev/session', { cwd: repo })
  const after = await summary(sessionId)
  assert(after?.blank === false && after.title === title && (await summary(other.sessionId))?.blank === true, 'v) after another session is created it is still listed (not blank) with the same title')
  assert((await wfStartCalls()).filter(r => r.decision.tool.input.requirement === requirement).length === 1, 'v) one wf_start for the command')

  // Pre-beta.5 state: a run bound to a session DSH still lists as blank.
  const mainRequests = async () => (await fakeRequests()).filter(r => r.marker === null).length
  const before = await mainRequests()
  const legacy = await api('/dev/session', { cwd: repo })
  sessions.push(legacy.sessionId)
  await api('/dev/bind', { sessionId: legacy.sessionId, cwd: repo, requirement: '旧会话里的需求' })
  assert((await summary(legacy.sessionId))?.blank === true, 'v) a pre-beta.5 command session is blank')
  const runs = await api('/runs')
  assert(runs.runs.some(r => r.sessionId === legacy.sessionId) && runs.runs.some(r => r.sessionId === sessionId), 'v) /runs lists both runs with their sessions (本机的工作流)')
  const healed = await api('/session/engage', { sessionId: legacy.sessionId })
  assert(healed.titled && healed.engaged, 'v) /session/engage titled the old session and gave it its first turn')
  assert((await summary(legacy.sessionId))?.blank === false && (await summary(legacy.sessionId))?.title === '工作流 · 旧会话里的需求', 'v) the old session is listed again with its title')
  const again = await api('/session/engage', { sessionId: legacy.sessionId })
  assert(!again.titled && !again.engaged, 'v) engaging twice is a no-op')
  assert(await mainRequests() === before, 'v) healing an old session made no model request')

  await stopDsh()
  await startDsh(ws)
  const cold = await summary(sessionId)
  assert(cold?.blank === false && cold.title === title && (await summary(legacy.sessionId))?.blank === false, 'v) after a DSH restart both sessions are still listed with their titles')
  for (const id of [sessionId, legacy.sessionId]) await api('/run/cancel', { runId: (await runSnap(id)).run.id })
}

// u) Sidebar check. A crashed slot entry leaves an empty [data-slot-error]
// in place of its content (e.g. the whole 工作区 block).
async function scenarioU() {
  const { value, errors } = await inspectUi(`
    const deadline = Date.now() + 20000
    const facts = () => {
      const workspaces = document.querySelector('[data-slot="sidebar.workspaces"]')
      return {
        workspaces: !!workspaces && workspaces.querySelector('[data-slot-error]') === null && workspaces.innerText.includes('工作区'),
        inbox: [...document.querySelectorAll('[data-slot="sidebar"] button, [data-slot="sidebar"] [role=button]')].some(b => b.textContent.trim() === '收件箱'),
        crashed: [...document.querySelectorAll('[data-slot-error]')].map(e => e.getAttribute('data-slot-error')),
      }
    }
    while (Date.now() < deadline) {
      const f = facts()
      if (f.workspaces && f.inbox) return f
      await new Promise(r => setTimeout(r, 250))
    }
    return facts()
  `)
  log('u) ui', JSON.stringify(value), errors.length ? `console errors: ${errors.join(' | ').slice(0, 500)}` : '')
  assert(value.workspaces, 'u) the sidebar shows DSH\'s 工作区 block')
  assert(value.inbox, 'u) the sidebar shows the plugin\'s 收件箱 entry')
  assert(value.crashed.length === 0 && !errors.some(e => e.includes('slot entry crashed')), 'u) no slot entry crashed')
}

const started = Date.now()
let failed = false
try {
  await startFake()
  await setScenario(SCENARIO)
  await startDsh(ws)
  if (selected.has('a') || selected.has('b')) await scenarioA()
  if (selected.has('c')) await scenarioC()
  if (selected.has('d')) await scenarioD()
  if (selected.has('n')) await scenarioN()
  if (selected.has('s')) await scenarioS()
  if (selected.has('m')) await scenarioM()
  if (selected.has('k')) await scenarioK()
  if (selected.has('q')) await scenarioQ()
  if (selected.has('v')) await scenarioV()
  if (selected.has('u')) await scenarioU()
  log(`ALL PASSED in ${Math.round((Date.now() - started) / 1000)}s`)
} catch (error) {
  failed = true
  console.error(error)
  await dumpState()
} finally {
  await stopAll()
}
process.exit(failed ? 1 : 0)
