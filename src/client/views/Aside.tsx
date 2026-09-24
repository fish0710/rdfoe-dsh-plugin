/**
 * Right-sidebar (aside) entries: the 工作流 and 收件箱 tab types with their
 * 开始-page cards (official `sidebarRightTabs` + `sidebar.right.pane.tab`),
 * and two icon buttons in the aside's top toolbar next to DSH's own 分栏 /
 * 全屏 / 收起. DSH has no seat for toolbar actions (sidebar-right README,
 * 扩展席位: "目前没有面向格级动作或折叠态控件的席位"), so the buttons are
 * mounted into the strip's DOM by mountAsideToolbar.
 */
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { HOST_ATTR, NATIVE_TOGGLE, toolbarAnchor } from '../aside-dom.ts'
import { InboxBadge, InboxGlyph, InboxPanel, useInboxOpenCount, type InboxActions } from './Inbox.tsx'
import { WorkflowView, type WorkflowViewInjected } from './WorkflowView.tsx'

export const ASIDE_WORKFLOW_KIND = 'rdfoe-workflow'
export const ASIDE_INBOX_KIND = 'rdfoe-inbox'

export function WorkflowGlyph({ size = 16, className }: { size?: number | undefined, className?: string | undefined }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className={className} aria-hidden="true">
      <circle cx="5" cy="12" r="2.2" /><circle cx="12" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" /><circle cx="19" cy="12" r="2.2" />
      <path d="M7 11l3-3.5M7 13l3 3.5M14 7.5l3 3M14 16.5l3-3" />
    </svg>
  )
}

/** 开始-page card glyphs (ui-primitives IconProps). */
export function WorkflowGuideIcon({ size, className }: { size?: number | undefined, className?: string | undefined }) {
  return <WorkflowGlyph size={size ?? 22} className={className} />
}
export function InboxGuideIcon({ size, className }: { size?: number | undefined, className?: string | undefined }) {
  return <span className={className} style={{ display: 'inline-flex' }}><InboxGlyph size={size ?? 22} /></span>
}

export function WorkflowAsideTab(props: WorkflowViewInjected & { sessionId: string }) {
  return <div className="rwf-aside-tab" data-rdfoe-aside-tab="workflow"><WorkflowView {...props} /></div>
}

export function InboxAsideTab(props: InboxActions) {
  return <div className="rwf-aside-tab" data-rdfoe-aside-tab="inbox"><InboxPanel {...props} /></div>
}

export interface AsideToolbarActions {
  openWorkflow: () => void
  openInbox: () => void
}

/**
 * The toolbar buttons. `buttonClass` is the class DSH puts on its own 全屏 /
 * 收起 buttons, read from the live DOM, so size, radius, color and hover are
 * theirs rather than a copy; the tooltip is the same primitive with the same
 * placement and delay.
 */
function AsideToolbar({ actions, buttonClass }: { actions: AsideToolbarActions, buttonClass: string }) {
  const { count, blocking } = useInboxOpenCount()
  const inboxLabel = count > 0 ? `收件箱（待处理 ${count}）` : '收件箱'
  return (
    <>
      <Tooltip label="工作流" side="bottom" delayMs={500}>
        <button type="button" className={`${buttonClass} rwf-aside-btn`} aria-label="打开本会话的工作流" data-rdfoe-aside-action="workflow" onClick={actions.openWorkflow}>
          <WorkflowGlyph />
        </button>
      </Tooltip>
      <Tooltip label={inboxLabel} side="bottom" delayMs={500}>
        <button type="button" className={`${buttonClass} rwf-aside-btn`} aria-label={inboxLabel} data-rdfoe-aside-action="inbox" onClick={actions.openInbox}>
          <span className="rwf rwf-inbox-icon"><InboxGlyph size={16} /><InboxBadge count={count} blocking={blocking} /></span>
        </button>
      </Tooltip>
    </>
  )
}

/**
 * Keep one toolbar in every aside strip that carries DSH's panel controls.
 * The strip belongs to DSH's React tree and is re-created on split, float and
 * session switch, so a MutationObserver (coalesced per animation frame)
 * re-attaches and cleans up; each toolbar is its own small React root.
 * @returns a disposer that removes every toolbar.
 */
export function mountAsideToolbar(actions: AsideToolbarActions): () => void {
  const mounted = new Map<HTMLElement, Root>()
  const sync = () => {
    for (const [host, root] of mounted) {
      if (host.isConnected && host.parentElement?.querySelector(NATIVE_TOGGLE)) continue
      root.unmount()
      host.remove()
      mounted.delete(host)
    }
    for (const toggle of document.querySelectorAll(NATIVE_TOGGLE)) {
      const anchor = toolbarAnchor(toggle)
      if (!anchor || anchor.strip.querySelector(`:scope > [${HOST_ATTR}]`)) continue
      const host = document.createElement('span')
      host.setAttribute(HOST_ATTR, '')
      host.className = 'rwf-aside-toolbar'
      anchor.strip.insertBefore(host, anchor.before)
      const root = createRoot(host)
      root.render(<AsideToolbar actions={actions} buttonClass={toggle.className} />)
      mounted.set(host, root)
    }
  }
  let frame = 0
  const observer = new MutationObserver(() => {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => { frame = 0; sync() })
  })
  observer.observe(document.body, { childList: true, subtree: true })
  sync()
  return () => {
    observer.disconnect()
    cancelAnimationFrame(frame)
    for (const [host, root] of mounted) {
      root.unmount()
      host.remove()
    }
    mounted.clear()
  }
}
