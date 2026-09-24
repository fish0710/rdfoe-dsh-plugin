#!/usr/bin/env node
/** Manual UI check of §8.3 recovery: a workflow waits on a question, DSH restarts, the view shows 继续. Stays up until Ctrl-C. */
import { log, makeSampleRepo, makeWorkspace, setScenario, startDsh, startFake, startWorkflowSession, stopAll, stopDsh, waitItem } from './harness.mjs'

const ws = makeWorkspace()
await startFake()
await setScenario([
  { match: { title: 'INT', role: 'R', resume: 0 }, calls: [
    { name: 'wf_ask', input: { questions: [{ id: 'q1', question: '重启前提出的问题：输出目录用哪个？', options: [{ label: 'src' }, { label: 'lib' }] }] } },
    { name: 'wf_write', input: { path: '{dir}/requirement.md', content: '# 需求\n' } },
    { name: 'wf_report', input: { summary: '需求', artifacts: [], openIssues: [], confidence: 0.8 } },
  ], say: 'r done' },
  { match: { title: 'INT', role: 'R', resume: 1 }, calls: [
    { name: 'wf_write', input: { path: '{dir}/requirement.md', content: '# 需求（重启后续上）\n' } },
    { name: 'wf_report', input: { summary: '重启后续上完成需求录入', artifacts: [], openIssues: [], confidence: 0.8 } },
  ], say: 'r resumed' },
])
await startDsh(ws)
const repo = makeSampleRepo(ws.dir, 'restart-repo')
const { sessionId } = await startWorkflowSession(repo, 'INT', '演示重启恢复')
await waitItem(sessionId, i => i.kind === 'question', 'question')
await stopDsh()
const dsh = await startDsh(ws)
log(`restarted; open http://127.0.0.1:${process.env.PORT ?? 3181}/?token=${dsh.token} session ${sessionId}`)
process.on('SIGINT', async () => { await stopAll(); process.exit(0) })
process.on('SIGTERM', async () => { await stopAll(); process.exit(0) })
setInterval(() => {}, 1 << 30)
