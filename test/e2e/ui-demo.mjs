#!/usr/bin/env node
/**
 * Manual UI walkthrough: boots fake LLM + DSH like the e2e, starts one
 * workflow whose script produces all five inbox kinds (message, question,
 * review, loop_stall after three failing verification rounds; approve the
 * gates in the browser to get there),
 * prints the login URL and stays up until Ctrl-C.
 */
import { makeSampleRepo, makeWorkspace, log, setScenario, startDsh, startFake, startWorkflowSession, stopAll } from './harness.mjs'

const fail = round => ({
  match: { title: 'UI', role: 'Y', round },
  calls: [
    { name: 'wf_exec', input: { command: 'npm test' } },
    { name: 'wf_write', input: { path: '{dir}/verification.md', content: `# 验证记录 第 ${round} 轮\n\n- VP-1：add(0.1,0.2) 精度不符 → F-1\n- VP-2：npm test exit 0\n` } },
    { name: 'wf_report', input: { summary: `第 ${round} 轮验证未通过`, artifacts: [], openIssues: [], confidence: 0.9, verdict: 'fail', items: [{ id: 'VP-1', result: 'fail', evidence: 'add(0.1,0.2) 返回 0.30000000000000004' }, { id: 'VP-2', result: 'pass', evidence: 'npm test exit 0' }] } },
  ],
  say: `y r${round} fail`,
})

const ws = makeWorkspace()
await startFake()
await setScenario([
  { match: { title: 'UI', role: 'C', v: 1 }, calls: [
    { name: 'wf_message', input: { text: '我注意到仓库里没有 **src/** 目录，计划新建 `src/add.js`。', level: 'decision', expectReply: true } },
    { name: 'wf_ask', input: { questions: [{ id: 'q1', header: '范围', question: 'add 需要支持浮点数吗？', detail: '会影响验收用例。', options: [{ label: '支持', description: '按 IEEE 754 处理' }, { label: '不支持' }] }] } },
    { name: 'wf_write', input: { path: '{dir}/requirement.md', content: '# 需求 v1\n\n- **FR-1**：实现 `add(a, b)`。\n- **AC-1**：运行 npm test 看到 ok。\n' } },
    { name: 'wf_report', input: { summary: '澄清：整数加法', artifacts: [], openIssues: ['浮点精度未处理'], confidence: 0.65, blocked: false } },
  ], say: 'clarified' },
  { match: { title: 'UI', role: 'X', round: 1 }, delayMs: 2500, calls: [
    { name: 'wf_write', input: { path: 'src/add.js', content: 'module.exports = (a, b) => a + b\n' } },
    { name: 'wf_exec', input: { command: 'npm test' } },
    { name: 'wf_exec', input: { command: 'node --version && ls -la src', reason: '确认运行时版本与产物' } },
    { name: 'wf_write', input: { path: '{dir}/verification.md', content: '# 实施证据 第 {round} 轮\n' } },
    { name: 'wf_report', input: { summary: '实现 add', artifacts: ['src/add.js'], openIssues: [], confidence: 0.7 } },
  ], say: 'x r1 done' },
  fail(1), fail(2), fail(3),
])
const dsh = await startDsh(ws)
const repo = makeSampleRepo(ws.dir, 'demo-repo')
const { sessionId, runId } = await startWorkflowSession(repo, 'UI', '实现 add(a,b) 并通过 npm test（UI 演示）')
log(`demo run ${runId} in session ${sessionId}`)
log(`open http://127.0.0.1:${process.env.PORT ?? 3181}/?token=${dsh.token}`)
process.on('SIGINT', async () => { await stopAll(); process.exit(0) })
process.on('SIGTERM', async () => { await stopAll(); process.exit(0) })
setInterval(() => {}, 1 << 30)
