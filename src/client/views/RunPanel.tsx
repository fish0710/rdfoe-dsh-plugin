/**
 * Workflow entry points for sessions whose conversation is still blank (no
 * turn yet): DSH hides the View tabs and the View area until the first turn,
 * so the run opens in a `main` panel instead, and a banner above the composer
 * (`conversation.input.dock`) keeps the entry visible. The Host gives a
 * command-started session its first turn right away (session-engage.ts); the
 * banner asks for it once more for sessions started before 0.1.0-beta.5.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { NODE_LABEL, RUN_STATUS_LABEL, TEMPLATE_LABEL, postJson, templateId, useStream, type RunSnapshot } from '../api.ts'
import { WorkflowView, type WorkflowViewInjected } from './WorkflowView.tsx'

let target: string | null = null
const listeners = new Set<() => void>()

/** Point the run panel at one session's workflow. */
export function setRunPanelSession(sessionId: string) {
  target = sessionId
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export interface RunPanelInjected extends WorkflowViewInjected {
  backToConversation: () => void
}

export function RunPanel(props: RunPanelInjected) {
  const sessionId = useSyncExternalStore(subscribe, () => target)
  return (
    <div className="rwf rwf-panel" data-rdfoe-panel="run">
      <div className="rwf-panel-head">
        <Button size="sm" variant="ghost" data-rdfoe-back="" onClick={props.backToConversation}>← 返回会话</Button>
        <h3>工作流</h3>
        <span className="rwf-muted small">会话发出第一条消息后，也可以在会话顶部的「工作流」标签里查看</span>
      </div>
      <div className="rwf-panel-body">
        {sessionId === null
          ? <div className="rwf-view rwf-muted">没有选中的工作流。</div>
          : <WorkflowView key={sessionId} {...props} sessionId={sessionId} />}
      </div>
    </div>
  )
}

export interface RunDockInjected {
  openRun: (sessionId: string) => void
}

/** Banner above the composer while the bound session has no turn yet. */
export function RunDock({ sessionId, session, openRun }: RunDockInjected & { sessionId: string, session?: { blank?: boolean } }) {
  if (session?.blank !== true) return null
  return <BlankRunDock sessionId={sessionId} openRun={openRun} />
}

/** Sessions this page already asked the Host to engage. */
const engaged = new Set<string>()

function BlankRunDock({ sessionId, openRun }: RunDockInjected & { sessionId: string }) {
  const { data } = useStream<RunSnapshot & { type: string }>(`/events?sessionId=${encodeURIComponent(sessionId)}`, 'run')
  const run = data?.run
  useEffect(() => {
    if (!run || engaged.has(sessionId)) return
    engaged.add(sessionId)
    void postJson('/session/engage', { sessionId }).catch(() => undefined)
  }, [run, sessionId])
  if (!run) return null
  const pending = data?.inbox?.filter(i => i.status === 'OPEN').length ?? 0
  return (
    <div className="rwf rwf-tool-card rwf-dock" data-rdfoe-dock={run.id}>
      <div className="grow">
        <div className="title">本会话已开启工作流 {run.id}（{TEMPLATE_LABEL[templateId(run.template)]}）</div>
        <div className="rwf-muted small">
          {RUN_STATUS_LABEL[run.status] ?? run.status}
          {run.current_node ? ` · 当前：${NODE_LABEL[run.current_node] ?? run.current_node}` : ''}
          {pending > 0 ? ` · 待处理 ${pending}` : ''}
        </div>
      </div>
      <Button size="sm" variant="primary" data-rdfoe-open-run="" onClick={() => openRun(sessionId)}>打开工作流</Button>
    </div>
  )
}
