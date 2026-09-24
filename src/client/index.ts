/**
 * rdfoe-workflow browser entry: the per-session 工作流 view, the wf_start
 * card, and the unified inbox (sidebar entry + main panel). React, Cordis
 * and ui-primitives come from the DSH shell module table (externals).
 */
import type { Context } from '@deepseek-ai/cordis'
import { parseCommandRun, postJson } from './api.ts'
import { CSS } from './styles.ts'
import { ASIDE_INBOX_KIND, ASIDE_WORKFLOW_KIND, InboxAsideTab, InboxGuideIcon, WorkflowAsideTab, WorkflowGuideIcon, mountAsideToolbar } from './views/Aside.tsx'
import { InboxIcon, InboxPanel, type InboxActions } from './views/Inbox.tsx'
import { START_TURN_DEFINITION, WfCommandCard, WfStartCard, WfStartTail, selectStartTurn, type WfStartCardInjected } from './views/WfStartCard.tsx'
import { RunDock, RunPanel, setRunPanelSession, type RunDockInjected, type RunPanelInjected } from './views/RunPanel.tsx'
import { WorkflowView, type WorkflowViewInjected } from './views/WorkflowView.tsx'

export const VIEW_ID = 'rdfoe-workflow'
export const VIEW_LABEL = '工作流'
export const INBOX_PANEL_ID = 'rdfoe-inbox'
/** Main panel showing one session's run while that conversation is still blank (no View tabs yet). */
export const RUN_PANEL_ID = 'rdfoe-run'
export const COMMAND_NAME = 'rdfoe-workflow'
/** Right-sidebar tab type ids (the `sidebar.right.pane.tab` keys). */
export const ASIDE_WORKFLOW_ID = '@rdfoe/dsh-workflow/workflow'
export const ASIDE_INBOX_ID = '@rdfoe/dsh-workflow/inbox'
/** ui-conversation persists each session's View choice under this key (stores.ts, 0.1.7-alpha.2). */
const CONVERSATION_STORE_KEY = 'dsh.conversation'

export const inject = ['slots']

interface UiWorkspaceLike { openSession(target: string): void }
interface SidebarRightLike {
  openResource(url: string, options: { kind: string, preferNewPane?: boolean }): void
  openTab(kind: string, options?: { replaceTab?: string }): void
  active(): { id: string, kind: string } | undefined
}
interface GuideEntryLike { id: string, order: number, title: () => string, description?: () => string, icon?: unknown }
interface SidebarRightTabsLike {
  get(kind: string): unknown
  register(definition: { id: string, kind: string, title: (address: string) => string, guide?: GuideEntryLike[] }): () => void
}
interface LayoutLike { selectPanel(panelId: string | null): void }
interface SessionsLike { scope(sessionId: string): (Context & { get(name: 'conversation'): { input: { for(actx: unknown): { notify(level: 'info' | 'error', text: string): void } } } | undefined }) | undefined }
interface CommandResultLike { kind: 'success' | 'error', text?: string }

// The browser context is augmented by DSH client packages we only use by
// name; keep the surface local and untyped instead of importing them.
type ClientContext = Context & { slots: any }

/**
 * No public API switches the conversation View from outside its owner
 * (R9), so this clicks the owner's own tab button. 0.1.7 marks the tab list
 * with data-conversation-tabs; 0.1.5 only has the header slot around it.
 */
const CONVERSATION_TABS = '[data-conversation-tabs] [role="tab"], [data-slot="conversation.session.header"] [role="tab"]'
function clickWorkflowTab(): boolean {
  const tabs = document.querySelectorAll<HTMLButtonElement>(CONVERSATION_TABS)
  for (const tab of tabs) {
    if (tab.textContent?.trim() === VIEW_LABEL) { tab.click(); return true }
  }
  return false
}

export function apply(ctx: ClientContext) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = '@rdfoe/dsh-workflow'
    style.textContent = CSS
    document.head.append(style)
    return () => style.remove()
  })

  const service = <T>(name: string) => ctx.get(name as never) as T | undefined

  const openRunPanel = (sessionId: string) => {
    setRunPanelSession(sessionId)
    service<LayoutLike>('layout')?.selectPanel(RUN_PANEL_ID)
  }
  /** Click the 工作流 tab once the session renders it; a blank session never does, so fall back to the run panel. */
  const showWorkflow = (sessionId: string, delays = [300, 900, 1800]) => {
    const [delay, ...rest] = delays
    setTimeout(() => {
      if (clickWorkflowTab()) return
      if (rest.length > 0) showWorkflow(sessionId, rest)
      else openRunPanel(sessionId)
    }, delay)
  }
  /** Composer notice on one session (the channel DSH uses for detached command results). */
  const notice = (sessionId: string, level: 'info' | 'error', text: string) => {
    try {
      const actx = service<SessionsLike>('sessions')?.scope(sessionId)
      actx?.get('conversation')?.input.for(actx).notify(level, text)
    } catch { /* notice is best effort; the command row and dock still show the outcome */ }
  }

  const inboxActions: InboxActions = {
    openSessionWorkflow(sessionId) {
      // A run's session DSH still lists as blank (pre-beta.5 command) gets its title and first turn.
      void postJson('/session/engage', { sessionId }).catch(() => undefined)
      // A session not yet bound in this page reads its View preference on first bind.
      try {
        const key = `${CONVERSATION_STORE_KEY}.${sessionId}`
        const stored = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>
        // DSH reads `draft` back unguarded (setDraft(undefined) crashes the session pane), so seed it.
        localStorage.setItem(key, JSON.stringify({ draft: '', ...stored, view: VIEW_ID }))
      } catch { /* storage unavailable: the tab click below still applies */ }
      service<UiWorkspaceLike>('uiWorkspace')?.openSession(sessionId)
      // A session already bound in this page keeps its in-memory choice.
      showWorkflow(sessionId)
    },
    openAgentAside(parentSessionId, agentSessionId) {
      // DSH 0.1.5 has no subagentchat tab type: open the node session in the main area instead.
      if (service<SidebarRightTabsLike>('sidebarRightTabs')?.get('subagentchat') === undefined) {
        service<UiWorkspaceLike>('uiWorkspace')?.openSession(agentSessionId)
        return
      }
      const url = `dsh-resource://subagentchat/session/${encodeURIComponent(agentSessionId)}?${new URLSearchParams({ parent: parentSessionId, mode: 'one-shot' })}`
      service<SidebarRightLike>('sidebarRight')?.openResource(url, { kind: 'subagentchat', preferNewPane: true })
    },
  }
  const viewActions = (): WorkflowViewInjected => ({
    ...inboxActions,
    openInbox() { service<LayoutLike>('layout')?.selectPanel(INBOX_PANEL_ID) },
  })

  // Right sidebar (aside): 工作流 / 收件箱 tab types, their 开始-page cards,
  // and the toolbar buttons next to DSH's 分栏 / 全屏 / 收起.
  ctx.inject(['sidebarRight', 'sidebarRightTabs'] as never, ((scope: ClientContext & { sidebarRight: SidebarRightLike, sidebarRightTabs: SidebarRightTabsLike }) => {
    /** Open a tab in the active pane; a 开始 page there gives way to it, as its own cards do. */
    const openAside = (kind: string) => {
      const active = scope.sidebarRight.active()
      scope.sidebarRight.openTab(kind, active?.kind === 'guide' ? { replaceTab: active.id } : {})
    }
    scope.effect(() => scope.sidebarRightTabs.register({
      id: ASIDE_WORKFLOW_ID,
      kind: ASIDE_WORKFLOW_KIND,
      title: () => VIEW_LABEL,
      guide: [{ id: 'workflow', order: 30, title: () => VIEW_LABEL, description: () => '查看本会话的工作流，或为它开启一条', icon: WorkflowGuideIcon }],
    }))
    scope.effect(() => scope.sidebarRightTabs.register({
      id: ASIDE_INBOX_ID,
      kind: ASIDE_INBOX_KIND,
      title: () => '收件箱',
      guide: [{ id: 'inbox', order: 31, title: () => '收件箱', description: () => '所有工作流待你回答和审核的事项', icon: InboxGuideIcon }],
    }))
    const asideViewActions = (): WorkflowViewInjected => ({ ...inboxActions, openInbox: () => openAside(ASIDE_INBOX_KIND) })
    scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register(
      { name: 'sidebar.right.pane.tab', key: ASIDE_WORKFLOW_ID, inject: asideViewActions },
      WorkflowAsideTab,
    ))
    scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register(
      { name: 'sidebar.right.pane.tab', key: ASIDE_INBOX_ID, inject: () => inboxActions },
      InboxAsideTab,
    ))
    scope.effect(() => mountAsideToolbar({
      openWorkflow: () => openAside(ASIDE_WORKFLOW_KIND),
      openInbox: () => openAside(ASIDE_INBOX_KIND),
    }))
  }) as never)

  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    { name: 'conversation.view', id: VIEW_ID, order: 50, label: VIEW_LABEL, inject: viewActions },
    WorkflowView,
  ))

  const cardActions = (): WfStartCardInjected => ({ openWorkflowView: clickWorkflowTab })
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'wf_start', inject: cardActions },
    WfStartCard,
  ))
  // `/rdfoe-workflow` (Host command): its command/done row renders as the same card.
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register(
    { name: 'conversation.chat.commandview', key: COMMAND_NAME, inject: cardActions },
    WfCommandCard,
  ))

  // DSH folds a completed turn's tool calls, wf_start's card included, so the
  // turn that started a workflow also ends with a live card under the reply.
  // `conversation.chat.turnTail` is a list in 0.1.7 (id) and a chain in 0.1.5
  // (select; first match wins, and ours matches only wf_start turns).
  ctx.inject(['uiConversation'] as never, ((scope: ClientContext & { uiConversation: { events: { register(definition: unknown): () => void } } }) => {
    // Bound to this scope's lifetime by the registry itself (as ui-deliverables relies on).
    scope.uiConversation.events.register(START_TURN_DEFINITION)
    scope.slots.inject('conversation.chat.turnTail', () => scope.slots.register(
      { name: 'conversation.chat.turnTail', id: '@rdfoe/dsh-workflow', select: selectStartTurn, inject: cardActions },
      WfStartTail,
    ))
  }) as never)

  // `/rdfoe-workflow` answers at once (the start itself is a model turn that
  // calls wf_start, whose card opens the view). The acknowledgment becomes a
  // composer notice; for an already bound session it also opens the 工作流 tab.
  ctx.on('command/executed' as never, ((sessionId: string, name: string, result: CommandResultLike) => {
    if (name !== COMMAND_NAME) return
    const text = result.text ?? ''
    const bound = result.kind === 'success' && parseCommandRun(text) !== null
    // The start acknowledgment already shows as the command row above the turn it starts.
    if (result.kind === 'success' && text.startsWith('正在开启工作流')) return
    notice(sessionId, result.kind === 'error' ? 'error' : 'info', bound ? text.split('\n')[0]! : text)
    if (bound) showWorkflow(sessionId, [150, 600, 1200])
  }) as never)

  const runPanelActions = (): RunPanelInjected => ({
    ...viewActions(),
    backToConversation() { service<LayoutLike>('layout')?.selectPanel(null) },
  })
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: RUN_PANEL_ID, inject: runPanelActions },
    RunPanel,
  ))
  const dockActions = (): RunDockInjected => ({ openRun: openRunPanel })
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: RUN_PANEL_ID, order: 5, inject: dockActions },
    RunDock,
  ))

  // Unified inbox (§9.3): the sidebar owns the entry button and selects the
  // `main` panel whose key equals the panellist id.
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: INBOX_PANEL_ID, inject: () => inboxActions },
    InboxPanel,
  ))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: INBOX_PANEL_ID, order: 10, label: '收件箱' },
    InboxIcon,
  ))
}
