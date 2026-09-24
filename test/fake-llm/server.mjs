#!/usr/bin/env node
/**
 * Keyless, rule-driven fake of the DeepSeek Messages endpoint (Anthropic SSE
 * wire, DSH 0.1.7) and of the OpenAI-style /chat/completions endpoint (DSH
 * 0.1.5's deepseek-official provider). Point DSH at it with
 * DEEPSEEK_BASE_URL=http://127.0.0.1:<port> and any DEEPSEEK_API_KEY.
 *
 * Two brains:
 *
 * 1. Workflow nodes. The fake recognises a node prompt from its ordinary
 *    content — no hidden metadata reaches the model: the role from the node
 *    persona in `system` (「（节点 R）」「（节点 DR）」…), run/title from
 *    「需求原文（工作流 …）」, node/version from 「本节点：…（D），第 N 版」, the
 *    template from 「流程模板：…（full）」, the round from 「循环第 N 轮」, the
 *    tasks.md path from the prompt, replied=1 when the prompt carries user
 *    replies, and resume from 「从中断处继续」. The latest user message with
 *    「本节点：」 is the anchor; its fields select a scenario rule (all `match`
 *    fields equal, most specific wins; built-in happy-path defaults cover every
 *    role). Each tool_result after the anchor consumes one scripted call; then
 *    the rule's `say` ends the turn. A rule may set `delayMs` to slow every step.
 *    Placeholders in call inputs: {run} {node} {v} {round} {template} {tasks}
 *    {dir} ({dir} = .rdfoe/runs/{run}/{node}/v{v}; {tasks} = the tasks.md
 *    path named in the prompt).
 *
 * 2. Plain conversations. Directive lines in the latest user text:
 *      @call <tool> <json-args>   one tool call per step, in order
 *      @say <text>                final text once calls are exhausted
 *      @title <text>              answer to DSH's session-title request
 *    and the start message /rdfoe-workflow submits (「【工作流】<需求>」 +
 *    「（用 RDFOE 工作流实现上面的需求…）」, session-command.ts startPrompt): one wf_start call with the
 *    requirement and template read back from it, then a one-line reply; its
 *    title request answers 「工作流 · <需求首行>」.
 *
 * Control: POST /scenario {rules:[…]} replaces the scenario rules;
 * GET /debug/requests lists every request (tools offered, decision, tool
 * results seen); POST /debug/reset clears it.
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const port = Number(process.env.FAKE_LLM_PORT ?? process.argv[2] ?? 18317)
let captured = []
let scenario = { rules: [] }
/** Per-request delay chosen by the matched rule. */
let decisionDelay = 0
if (process.env.FAKE_LLM_SCENARIO) scenario = JSON.parse(readFileSync(process.env.FAKE_LLM_SCENARIO, 'utf8'))

const report = (extra = {}) => ({ name: 'wf_report', input: { summary: '{node} v{v} done', artifacts: [], openIssues: [], confidence: 0.8, ...extra } })

const write = (file, content) => ({ name: 'write', input: { file_path: `{dir}/${file}`, content } })

const bash = (command) => ({ name: 'bash', input: { command, description: 'Run a command' } })

/** Happy path for every node; scenarios override per node/version/round/title. File names follow PH (§17). */
const DEFAULT_RULES = [
  { match: { role: 'R' }, calls: [write('requirement.md', '# 需求 v{v}\n\n- **FR-1**：提供 add(a,b)。\n- **AC-1**：用户运行 npm test 看到 ok。\n'), report()], say: 'requirement recorded' },
  { match: { role: 'C' }, calls: [write('requirement.md', '# 需求（澄清后）v{v}\n\n- **FR-1**：提供 add(a,b)。\n\n## 澄清记录\n- 无阻断。\n'), report({ blocked: false })], say: 'requirement clarified' },
  { match: { role: 'D' }, calls: [write('design.md', '# 设计 v{v}\n\n方案：实现 src/add.js 的 add(a,b)（FR-1）。\n'), report()], say: 'design done' },
  { match: { role: 'DR' }, calls: [
    write('review.md', '# 设计评审\n\n## 评审发现\n未发现阻断问题（核查了 FR-1 覆盖与 src/ 结构）。\n\n## 结论\n通过\n'),
    report({ summary: '设计审查：无阻断。', verdict: 'pass', items: [{ id: 'FR-1', result: 'pass', evidence: 'design.md 覆盖 FR-1' }] }),
  ], say: 'design review done' },
  { match: { role: 'T' }, calls: [write('tasks.md', '# 任务清单\n\n- [ ] T1 实现 FR-1：新建 src/add.js 并补单测；完成判据：npm test 通过\n'), report()], say: 'tasks done' },
  { match: { role: 'V' }, calls: [
    { name: 'read', input: { file_path: '{tasks}' } },
    write('verify-plan.md', '# 验证计划\n\n- VP-1：验证 FR-1（T1）—— 运行 npm test；期望退出码 0。\n'),
    write('acceptance.md', '# 验收指引\n\n- AC-1：在工作流分支运行 npm test，看到 ok。\n'),
    report(),
  ], say: 'verify plan done' },
  { match: { role: 'S' }, calls: [
    write('change.md', '# 小改动 v{v}\n\n- **FR-1**：提供 add(a,b)。\n- **AC-1**：npm test 输出 ok。\n'),
    write('tasks.md', '# 任务清单\n\n- [ ] T1 实现 FR-1：新建 src/add.js；完成判据：npm test 通过\n'),
    write('verify-plan.md', '# 验证计划\n\n- VP-1：运行 npm test；期望退出码 0。\n'),
    write('acceptance.md', '# 验收指引（小改动）\n\n- AC-1：运行 npm test，看到 ok。\n'),
    report(),
  ], say: 'small change prepared' },
  { match: { role: 'X' }, calls: [
    { name: 'write', input: { file_path: 'src/add.js', content: 'module.exports = (a, b) => a + b\n' } },
    bash('npm test'),
    write('verification.md', '# 实施证据 第 {round} 轮\n\n- T1：npm test exit 0\n'),
    report(),
  ], say: 'implementation done' },
  { match: { role: 'Y' }, calls: [
    bash('npm test'),
    write('verification.md', '# 验证记录 第 {round} 轮\n\n- VP-1：npm test exit 0，通过\n'),
    report({ verdict: 'pass', items: [{ id: 'VP-1', result: 'pass', evidence: 'npm test exit 0' }] }),
  ], say: 'verification done' },
  { match: { role: 'A' }, calls: [
    write('archive.md', '# 归档摘要\n\n## 交付范围\nFR-1\n\n## 用户结论\n用户验收通过。\n'),
    report(),
  ], say: 'archived' },
]

function textOf(content) {
  if (typeof content === 'string') return content
  return (content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')
}

function resultText(block) {
  const c = block.content
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x.text ?? '').join('\n') : ''
}

function systemText(system) {
  if (typeof system === 'string') return system
  return (system ?? []).map(b => b.text ?? '').join('\n')
}

/** Recognise a workflow node request from its ordinary prompt content. */
function parseNode(text, system) {
  const node = /本节点：[^\n]*（(\w+)），第 (\d+) 版/.exec(text)
  if (!node) return undefined
  const req = /## 需求原文（工作流 (\S+?)(?: · ([^）]+))?）/.exec(text)
  const round = /循环第 (\d+) 轮/.exec(text)
  const template = /流程模板：[^（\n]*（(full|small)）/.exec(text)
  const tasks = /(\.rdfoe\/\S+?\/tasks\.md)/.exec(text)
  const sys = systemText(system)
  const role = (/（节点 (DR|R|C|D|T|V|X|Y|A|S)）/.exec(sys) ?? [])[1]
  return {
    run: req?.[1] ?? '', title: req?.[2] ?? req?.[1] ?? '', node: node[1], v: node[2], round: round?.[1] ?? '0', role: role ?? 'unknown',
    template: template?.[1] ?? 'full', tasks: tasks?.[1] ?? '', replied: /## 用户的答复与回复/.test(text) ? '1' : '0', resume: /## 从中断处继续/.test(text) ? '1' : '0',
  }
}

function pickRule(fields) {
  const candidates = [...scenario.rules, ...DEFAULT_RULES.map(r => ({ ...r, isDefault: true }))]
    .filter(r => Object.entries(r.match).every(([k, v]) => String(fields[k]) === String(v)))
  candidates.sort((a, b) => (Object.keys(b.match).length - (b.isDefault ? 100 : 0)) - (Object.keys(a.match).length - (a.isDefault ? 100 : 0)))
  return candidates[0]
}

function fill(value, fields) {
  if (typeof value === 'string') {
    const dir = `.rdfoe/runs/${fields.run}/${fields.node}/v${fields.v}`
    return value.replace(/\{dir\}/g, dir).replace(/\{(run|node|v|round|role|title|template|tasks|replied)\}/g, (_m, k) => fields[k] ?? '')
  }
  if (Array.isArray(value)) return value.map(v => fill(v, fields))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, fields)]))
  return value
}

/** Mirror of parseStartPrompt in src/host/tools/session-command.ts. */
function parseStart(text) {
  const match = /【工作流】([\s\S]*)\n\n（用 RDFOE 工作流实现上面的需求，[^：]*：请只调用一次 wf_start，template 传 "(full|small)"/u.exec(text)
  return match ? { requirement: match[1], template: match[2] } : null
}
const START_REPLY = '工作流已启动，点下面的卡片可以查看进度。'

function directivesOf(text) {
  const calls = []
  let say
  for (const line of text.split('\n')) {
    const call = /^\s*@call\s+(\S+)\s*(.*)$/.exec(line)
    if (call) { calls.push({ name: call[1], input: call[2].trim() === '' ? {} : JSON.parse(call[2]) }); continue }
    const s = /^\s*@say\s+(.*)$/.exec(line)
    if (s) say = s[1]
  }
  return { calls, say }
}

/** Decide the next assistant step for one Messages request body. */
function decide(body) {
  const messages = body.messages ?? []
  const offered = new Set((body.tools ?? []).map(t => t.name))
  const isTitle = messages.length > 0 && textOf(messages[0].content).startsWith('Generate the session title')
  if (isTitle) {
    const all = messages.map(m => textOf(m.content)).join('\n')
    const title = /@title\s+([^"\\\n]+)/.exec(all)
    if (title) return { text: title[1].trim() }
    // The title request may quote the prompt JSON-escaped (a literal \n).
    const start = /【工作流】([^\n\\"]+)/u.exec(all)
    return { text: start ? `工作流 · ${start[1].trim().slice(0, 24)}` : 'FINAL' }
  }
  let anchor = -1
  let fields
  let startCall
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const text = textOf(m.content)
    const node = parseNode(text, body.system)
    if (node) { anchor = i; fields = node; break }
    if (/@(call|say)\b/.test(text)) { anchor = i; break }
    const start = parseStart(text)
    if (start) { anchor = i; startCall = start; break }
  }
  if (anchor < 0) return { text: 'ok' }
  let calls
  let say
  if (fields) {
    const rule = pickRule(fields)
    if (!rule) return { text: `NO_RULE ${JSON.stringify(fields)}` }
    if (rule.delayMs) decisionDelay = rule.delayMs
    calls = fill(rule.calls, fields)
    say = fill(rule.say ?? 'done', fields)
  } else if (startCall) {
    calls = [{ name: 'wf_start', input: { requirement: startCall.requirement, template: startCall.template } }]
    say = START_REPLY
  } else {
    ({ calls, say } = directivesOf(textOf(messages[anchor].content)))
  }
  const results = []
  for (const m of messages.slice(anchor + 1)) {
    if (m.role !== 'user' || typeof m.content === 'string') continue
    for (const b of m.content) if (b.type === 'tool_result') results.push(b)
  }
  if (results.length < calls.length) {
    const next = calls[results.length]
    if (!offered.has(next.name)) return { text: `TOOL_NOT_OFFERED ${next.name}; offered=${[...offered].join(',')}` }
    return { tool: { id: `fake-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: next.name, input: next.input } }
  }
  const last = results.at(-1)
  return { text: (say ?? 'FINAL') + (startCall || last === undefined ? '' : ` | last_result=${resultText(last).slice(0, 400)}`) }
}

/** Reshape a /chat/completions body into the Messages shape decide() reads. */
function fromChatCompletions(body) {
  const system = []
  const messages = []
  for (const m of body.messages ?? []) {
    const text = typeof m.content === 'string' ? m.content : textOf(m.content)
    if (m.role === 'system') system.push(text)
    else if (m.role === 'tool') messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: text }] })
    else if (m.role === 'assistant') messages.push({ role: 'assistant', content: [{ type: 'text', text: text ?? '' }, ...(m.tool_calls ?? []).map(c => ({ type: 'tool_use', id: c.id, name: c.function.name }))] })
    else messages.push({ role: 'user', content: text })
  }
  return { model: body.model, system: system.join('\n'), messages, tools: (body.tools ?? []).map(t => ({ name: t.function?.name ?? t.name })) }
}

function chunk(res, choice, extra = {}) {
  res.write(`data: ${JSON.stringify({ id: `fake-${captured.length}`, object: 'chat.completion.chunk', choices: choice ? [{ index: 0, ...choice }] : [], ...extra })}\n\n`)
}

function sse(res, payload) { res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`) }

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/debug/requests')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(captured))
    return
  }
  if (req.method === 'POST' && req.url === '/debug/reset') { captured = []; res.writeHead(204).end(); return }
  if (req.url === '/scenario') {
    if (req.method === 'POST') scenario = await readJson(req)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(scenario))
    return
  }
  const chat = req.method === 'POST' && req.url?.endsWith('/chat/completions')
  if (!chat && (req.method !== 'POST' || !req.url?.endsWith('/v1/messages'))) { res.writeHead(404).end(); return }
  const raw = await readJson(req)
  const body = chat ? fromChatCompletions(raw) : raw
  decisionDelay = 0
  const decision = decide(body)
  if (decisionDelay > 0) await new Promise(resolve => setTimeout(resolve, decisionDelay))
  const messages = body.messages ?? []
  const anchorText = [...messages].reverse().map(m => textOf(m.content)).find(t => t.includes('本节点：')) ?? ''
  const lastUser = messages.at(-1)
  captured.push({
    at: new Date().toISOString(),
    model: body.model,
    marker: parseNode(anchorText, body.system) ?? null,
    // The node prompt itself, so e2e can assert on what the node was told.
    prompt: anchorText.slice(0, 20_000),
    hiddenMetadata: JSON.stringify(body).includes('⟦rdfoe'),
    tools: (body.tools ?? []).map(t => t.name),
    lastToolResult: lastUser && Array.isArray(lastUser.content) ? lastUser.content.filter(b => b.type === 'tool_result').map(resultText).join('\n').slice(0, 2000) : '',
    // Text the host added to the last user message (steered replies ride here).
    lastUserText: lastUser ? textOf(lastUser.content).slice(0, 2000) : '',
    decision,
  })
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
  if (chat) {
    if (decision.tool) {
      chunk(res, { delta: { role: 'assistant', tool_calls: [{ index: 0, id: decision.tool.id, type: 'function', function: { name: decision.tool.name, arguments: JSON.stringify(decision.tool.input) } }] } })
      chunk(res, { delta: {}, finish_reason: 'tool_calls' })
    } else {
      chunk(res, { delta: { role: 'assistant', content: decision.text } })
      chunk(res, { delta: {}, finish_reason: 'stop' })
    }
    chunk(res, undefined, { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    res.end('data: [DONE]\n\n')
    return
  }
  sse(res, { type: 'message_start', message: { id: `fake-${captured.length}`, type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
  if (decision.tool) {
    sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: decision.tool.id, name: decision.tool.name, input: {} } })
    sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(decision.tool.input) } })
    sse(res, { type: 'content_block_stop', index: 0 })
    sse(res, { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })
  } else {
    sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: decision.text } })
    sse(res, { type: 'content_block_stop', index: 0 })
    sse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
  }
  sse(res, { type: 'message_stop' })
  res.end()
})

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ ready: true, baseURL: `http://127.0.0.1:${port}` }))
})
