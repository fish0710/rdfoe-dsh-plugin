/**
 * End-to-end harness: boots the fake LLM and DSH 0.1.7-alpha.2 (profile
 * rdfoe-dev under the repo's isolated .dsh-dev; see dshCommand for other
 * versions) with an overlay that points
 * the plugin at a throwaway database and worktree root, and drives the
 * workflow over /api/rdfoe-wf/*.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PORT = Number(process.env.PORT ?? 3181)
const FAKE_PORT = Number(process.env.FAKE_LLM_PORT ?? 18317)
const BASE = `http://127.0.0.1:${PORT}`
const FAKE = `http://127.0.0.1:${FAKE_PORT}`

export function log(...args) { console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...args) }

export function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
  log(`✓ ${message}`)
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function waitFor(label, fn, timeoutMs = 60_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    } catch (error) { last = error }
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${label}; last=${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 500)}`)
}

/** A fresh workspace directory for this e2e run. */
export function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'rdfoe-e2e-'))
  const state = join(dir, 'state')
  mkdirSync(state)
  const patch = join(dir, 'e2e.patch.yml')
  writeFileSync(patch, `- id: rdfoe-workflow\n  config:\n    devRoutes: true\n    dbPath: ${JSON.stringify(join(state, 'state.db'))}\n    worktreeRoot: ${JSON.stringify(join(state, 'worktrees'))}\n`)
  return { dir, patch, state }
}

/** A small git repository with an npm test script. */
export function makeSampleRepo(parent, name) {
  const repo = join(parent, name)
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2))
  writeFileSync(join(repo, 'test.js'), "let add\ntry { add = require('./src/add.js') } catch { console.log('no add yet'); process.exit(0) }\nif (add(2, 3) !== 5) { console.error('add(2,3) !== 5'); process.exit(1) }\nconsole.log('ok')\n")
  const git = (...args) => execFileSync('git', ['-c', 'user.email=seed@example.com', '-c', 'user.name=seed', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')
  return repo
}

/** Main sessions created in this e2e run (for failure dumps). */
export const sessions = []

export async function dumpState() {
  for (const id of sessions) {
    try {
      const s = await runSnap(id)
      console.error(`--- ${s.run?.id} ${s.run?.status} round=${s.run?.loop_round}`)
      console.error('nodes', s.nodes?.map(n => `${n.node_key}:${n.status}:v${n.current_version}${n.error ? `(${n.error})` : ''}`).join(' '))
      console.error('agents', s.agents?.map(a => `${a.role}:${a.status}:v${a.version}${a.error ? `(${a.error})` : ''}`).join(' '))
      console.error('inbox', s.inbox?.map(i => `${i.kind}:${i.status}`).join(' '))
      console.error('events', s.events?.slice(0, 15).map(e => `${e.type} ${e.before}->${e.after} ${e.payload_json ?? ''}`).join('\n  '))
    } catch (error) { console.error('dump failed', error) }
  }
  try { const r = await fakeRequests(); console.error('fake tail', JSON.stringify(r.slice(-4), null, 1).slice(0, 3000)) } catch {}
}

let fakeProc
let dshProc
let cookie = ''
let uiToken = ''

export async function startFake() {
  fakeProc = spawn(process.execPath, [join(ROOT, 'test/fake-llm/server.mjs')], { env: { ...process.env, FAKE_LLM_PORT: String(FAKE_PORT) }, stdio: ['ignore', 'pipe', 'inherit'] })
  await waitFor('fake llm', () => fetch(`${FAKE}/scenario`).then(r => r.ok), 10_000)
}

export async function setScenario(rules) {
  await fetch(`${FAKE}/scenario`, { method: 'POST', body: JSON.stringify({ rules }) })
}

export async function fakeRequests() {
  return (await fetch(`${FAKE}/debug/requests`)).json()
}

/**
 * DSH runtime: the repo's devDependency by default; E2E_DSH_VERSION=0.1.5-rc.2
 * runs `npx @deepseek-ai/dsh@<version>` instead, with E2E_DSH_HOME pointing
 * at a DSH_HOME whose profile rdfoe-dev was created by that version:
 *
 *   export DSH_HOME=$PWD/.dsh-dev-015
 *   npx -y @deepseek-ai/dsh@0.1.5-rc.2 --profile rdfoe-dev --from-default-profile web --dump-config >/dev/null
 *   npx -y @deepseek-ai/dsh@0.1.5-rc.2 plugin --profile rdfoe-dev add $PWD/<packed .tgz>
 *   E2E_DSH_VERSION=0.1.5-rc.2 E2E_DSH_HOME=$DSH_HOME PORT=3191 pnpm e2e
 *
 * Installing the packed tarball (not the repo link) makes the plugin resolve
 * its @deepseek-ai peers from that DSH rather than the repo's node_modules.
 */
export const DSH_HOME = process.env.E2E_DSH_HOME ?? join(ROOT, '.dsh-dev')
function dshCommand(args) {
  const version = process.env.E2E_DSH_VERSION
  return version ? ['npx', ['-y', `@deepseek-ai/dsh@${version}`, ...args]] : [join(ROOT, 'node_modules/.bin/dsh'), args]
}

export async function startDsh(ws) {
  let output = ''
  const [cmd, args] = dshCommand(['--profile', 'rdfoe-dev', '--patch', ws.patch, '--no-open', '--port', String(PORT)])
  dshProc = spawn(cmd, args, {
    env: { ...process.env, DSH_HOME, DEEPSEEK_BASE_URL: FAKE, DEEPSEEK_API_KEY: 'fake-key', NO_PROXY: '127.0.0.1,localhost' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group so npx and the DSH it spawns stop together.
    detached: true,
  })
  dshProc.stdout.on('data', (d) => { output += d; if (process.env.E2E_VERBOSE) process.stdout.write(d) })
  dshProc.stderr.on('data', (d) => { output += d; if (process.env.E2E_VERBOSE) process.stderr.write(d) })
  const token = await waitFor('dsh boot', () => /token=([\w-]+)/.exec(output)?.[1], 90_000)
  const res = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual' })
  cookie = res.headers.get('set-cookie').split(';')[0]
  uiToken = token
  log('dsh up', /rdfoe-workflow\] loaded[^\n]*/.exec(output)?.[0])
  return { output: () => output, token }
}

const CHROME = process.env.E2E_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/**
 * Open the running DSH's web UI in a throwaway headless Chrome (fresh profile, so no
 * localStorage from other DSH versions) and evaluate `expression` (an async
 * function body) once the page has loaded. Returns its value and the
 * console errors seen until then.
 */
export async function inspectUi(expression) {
  if (!existsSync(CHROME)) throw new Error(`no Chrome at ${CHROME}; set E2E_CHROME`)
  const profile = mkdtempSync(join(tmpdir(), 'rdfoe-e2e-chrome-'))
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,900', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  try {
    let stderr = ''
    chrome.stderr.on('data', (d) => { stderr += d })
    const browserWs = await waitFor('chrome devtools', () => /DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1], 20_000)
    const http = browserWs.replace(/^ws:\/\/([^/]+).*$/, 'http://$1')
    const target = await (await fetch(`${http}/json/new?about:blank`, { method: 'PUT' })).json()
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    let nextId = 0
    const pending = new Map()
    const errors = []
    socket.onmessage = ({ data }) => {
      const msg = JSON.parse(data)
      if (msg.id !== undefined) pending.get(msg.id)?.(msg)
      else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map(a => a.value ?? a.description).join(' '))
      else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
    }
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, (msg) => { pending.delete(id); msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result) })
      socket.send(JSON.stringify({ id, method, params }))
    })
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Page.navigate', { url: `${BASE}/?token=${uiToken}` })
    const loaded = `location.origin === ${JSON.stringify(BASE)} && document.readyState === 'complete'`
    await waitFor('ui page load', async () => (await send('Runtime.evaluate', { expression: loaded, returnByValue: true })).result.value, 30_000)
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true })
    if (exceptionDetails) throw new Error(`page script: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`)
    socket.close()
    return { value: result.value, errors }
  } finally {
    chrome.kill('SIGKILL')
    rmSync(profile, { recursive: true, force: true })
  }
}

export async function stopDsh() {
  if (!dshProc) return
  const proc = dshProc
  dshProc = undefined
  const signal = (sig) => { try { process.kill(-proc.pid, sig) } catch { proc.kill(sig) } }
  signal('SIGTERM')
  await Promise.race([new Promise(resolve => proc.once('exit', resolve)), sleep(15_000)])
  if (proc.exitCode === null) signal('SIGKILL')
  // Wait until the port is free for the next boot.
  await waitFor('port released', async () => { try { await fetch(`${BASE}/`); return false } catch { return true } }, 15_000)
}

export async function stopAll() {
  await stopDsh()
  fakeProc?.kill('SIGTERM')
}

export async function api(path, body) {
  const res = await fetch(`${BASE}/api/rdfoe-wf${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let value
  try { value = JSON.parse(text) } catch { value = text }
  if (!res.ok) throw new Error(`${path} → ${res.status} ${text.slice(0, 300)}`)
  return value
}

/** Create a main session in `cwd` whose model calls wf_start (template: full | small). */
export async function startWorkflowSession(cwd, title, requirement, template) {
  const text = `@title ${title}\n@call wf_start ${JSON.stringify({ title, requirement, ...(template ? { template } : {}) })}\n@say 工作流已启动`
  const { sessionId } = await api('/dev/session', { cwd, text })
  const snap = await waitFor(`run for ${title}`, async () => {
    const s = await api(`/run?sessionId=${encodeURIComponent(sessionId)}`)
    return s.run ? s : undefined
  })
  log(`session ${sessionId} → ${snap.run.id} (${snap.run.worktree_path})`)
  sessions.push(sessionId)
  return { sessionId, runId: snap.run.id, run: snap.run }
}

export const runSnap = sessionId => api(`/run?sessionId=${encodeURIComponent(sessionId)}`)
export const node = (snap, key) => snap.nodes.find(n => n.node_key === key)

export async function waitNode(sessionId, key, predicate, label, timeoutMs = 60_000) {
  return waitFor(label ?? `${key}`, async () => {
    const s = await runSnap(sessionId)
    const n = node(s, key)
    return predicate(n, s) ? s : undefined
  }, timeoutMs)
}

export async function waitItem(sessionId, predicate, label, timeoutMs = 60_000) {
  return waitFor(label, async () => {
    const s = await runSnap(sessionId)
    return s.inbox.find(i => i.status === 'OPEN' && predicate(i))
  }, timeoutMs)
}

export const respond = (id, body) => api('/inbox/respond', { id, ...body })

export function git(repoOrWorktree, ...args) {
  return execFileSync('git', args, { cwd: repoOrWorktree, encoding: 'utf8' }).trim()
}
