/** Artifact reading and version comparison: Markdown rendering, or a DiffBlock between two versions of the same file. */
import { useEffect, useMemo, useState } from 'react'
import { DiffBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { getText } from '../api.ts'

/** PH artifact reading order (§17); other files follow alphabetically. */
const FILE_ORDER = ['requirement.md', 'change.md', 'design.md', 'review.md', 'tasks.md', 'verify-plan.md', 'acceptance.md', 'verification.md', 'acceptance-report.md']
const fileRank = (name: string) => { const i = FILE_ORDER.indexOf(name); return i < 0 ? FILE_ORDER.length : i }

export const MD_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }

const DIFF_LABELS = {
  codeLabel: '文本', wrapLabel: '自动换行', unwrapLabel: '不换行',
  copy: '复制', copied: '已复制', collapseAria: '收起', expandAria: (n: number) => `展开 ${n} 行`, collapse: '收起', expand: (n: number) => `展开 ${n} 行`,
  // DSH 0.1.5's DiffBlock footer calls labels.files(n); 0.1.7 ignores it.
  files: (n: number) => `${n} 个文件`,
}

export function Markdown({ text, compact }: { text: string, compact?: boolean }) {
  return <MarkdownText text={text} labels={MD_LABELS} variant={compact ? 'compact' : 'body'} />
}

const cache = new Map<string, Promise<string>>()
function load(runId: string, path: string): Promise<string> {
  const key = `${runId}::${path}`
  if (!cache.has(key)) {
    const p = getText(`/artifact?${new URLSearchParams({ runId, path })}`)
    p.catch(() => cache.delete(key))
    cache.set(key, p)
  }
  return cache.get(key)!
}

export function useArtifact(runId: string, path: string | null): { text: string | null, error: string | null } {
  const [state, setState] = useState<{ text: string | null, error: string | null }>({ text: null, error: null })
  useEffect(() => {
    setState({ text: null, error: null })
    if (!path) return
    let alive = true
    load(runId, path).then(text => alive && setState({ text, error: null }), e => alive && setState({ text: null, error: String((e as Error).message) }))
    return () => { alive = false }
  }, [runId, path])
  return state
}

export function Skeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="rwf-skeleton" aria-busy="true" aria-label="加载中">
      {Array.from({ length: lines }, (_, i) => <div key={i} className="bar" style={{ width: `${92 - (i * 17) % 40}%` }} />)}
    </div>
  )
}

export function ArtifactDoc({ runId, path }: { runId: string, path: string }) {
  const { text, error } = useArtifact(runId, path)
  if (error) return <p className="rwf-error">无法读取 {path}：{error}</p>
  if (text === null) return <Skeleton lines={6} />
  return path.endsWith('.md')
    ? <div className="rwf-doc" data-rdfoe-artifact={path}><Markdown text={text} /></div>
    : <pre className="rwf-pre" data-rdfoe-artifact={path}>{text}</pre>
}

function CompareDoc({ runId, oldPath, newPath }: { runId: string, oldPath: string, newPath: string }) {
  const before = useArtifact(runId, oldPath)
  const after = useArtifact(runId, newPath)
  if (before.error || after.error) return <p className="rwf-error">{before.error ?? after.error}</p>
  if (before.text === null || after.text === null) return <Skeleton lines={6} />
  if (before.text === after.text) return <p className="rwf-muted">两个版本内容相同。</p>
  return <DiffBlock diffs={[{ path: newPath.split('/').slice(-3).join('/'), oldText: before.text, newText: after.text }]} labels={DIFF_LABELS} maxLines={400} />
}

/**
 * All versions of one node's artifacts: pick the file and version to read,
 * or compare it with an earlier version.
 */
export function ArtifactBrowser({ runId, versions, initialVersion }: { runId: string, versions: { version: number, artifacts: string[] }[], initialVersion?: number }) {
  const files = useMemo(() => {
    const names = new Set<string>()
    for (const v of versions) for (const a of v.artifacts) if (a.startsWith('.rdfoe/')) names.add(a.split('/').at(-1)!)
    return [...names].filter(n => n !== 'report.json').sort((a, b) => fileRank(a) - fileRank(b) || a.localeCompare(b))
  }, [versions])
  const latest = versions.at(-1)?.version ?? 0
  const [file, setFile] = useState<string | null>(null)
  const [version, setVersion] = useState<number | null>(initialVersion && versions.some(v => v.version === initialVersion) ? initialVersion : null)
  const [compareTo, setCompareTo] = useState<number | null>(null)
  const activeFile = file && files.includes(file) ? file : files[0] ?? null
  const activeVersion = version ?? latest
  const pathOf = (v: number) => versions.find(x => x.version === v)?.artifacts.find(a => a.endsWith(`/${activeFile}`)) ?? null
  const path = activeFile ? pathOf(activeVersion) : null
  const older = versions.filter(v => v.version < activeVersion && pathOf(v.version))

  if (versions.length === 0) return <div className="rwf-empty small">还没有产物。节点完成后会出现在这里。</div>
  return (
    <div className="rwf-artifacts">
      <div className="rwf-toolbar">
        {files.map(f => <button key={f} type="button" className="rwf-chip" aria-pressed={f === activeFile} onClick={() => setFile(f)}>{f}</button>)}
        <span className="rwf-spacer" />
        <label className="rwf-row rwf-sub">查看
          <select className="rwf-select" value={activeVersion} onChange={(e) => { setVersion(Number(e.target.value)); setCompareTo(null) }}>
            {versions.slice().reverse().map(v => <option key={v.version} value={v.version}>v{v.version}{v.version === latest ? '（最新）' : ''}</option>)}
          </select>
        </label>
        {older.length > 0 && (
          <label className="rwf-row rwf-sub">对比
            <select className="rwf-select" value={compareTo ?? ''} onChange={e => setCompareTo(e.target.value ? Number(e.target.value) : null)} data-rdfoe-compare="">
              <option value="">不对比</option>
              {older.slice().reverse().map(v => <option key={v.version} value={v.version}>与 v{v.version} 对比</option>)}
            </select>
          </label>
        )}
      </div>
      {path === null
        ? <p className="rwf-muted">该版本没有 {activeFile}。</p>
        : compareTo !== null && pathOf(compareTo)
          ? <CompareDoc runId={runId} oldPath={pathOf(compareTo)!} newPath={path} />
          : <ArtifactDoc runId={runId} path={path} />}
    </div>
  )
}
