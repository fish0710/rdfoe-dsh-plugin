import { describe, expect, it } from 'vitest'
import { toolbarAnchor } from '../src/client/aside-dom.ts'

/** Just enough of Element for toolbarAnchor, shaped like DSH's pane strip. */
class Node {
  parentElement: Node | null = null
  children: Node[] = []
  constructor(readonly attrs: string[] = []) {}
  append(...nodes: Node[]) { for (const n of nodes) { n.parentElement = this; this.children.push(n) } return this }
  hasAttribute(name: string) { return this.attrs.includes(name) }
  get previousElementSibling(): Node | null {
    const siblings = this.parentElement?.children ?? []
    return siblings[siblings.indexOf(this) - 1] ?? null
  }
  closest(selector: string): Node | null {
    const name = selector.slice(1, -1)
    for (let n: Node | null = this; n; n = n.parentElement) if (n.hasAttribute(name)) return n
    return null
  }
}

function strip(withSplit: boolean) {
  const toggle = new Node(['data-sidebar-right-toggle'])
  const chrome = new Node(['data-dockkit-strip-chrome']).append(new Node(['data-sidebar-right-mode']), toggle)
  const split = new Node(['data-dockkit-split-button'])
  const root = new Node(['data-dockkit-strip']).append(new Node(['data-dockkit-strip-tabs']), new Node(['data-dockkit-strip-fill']), ...(withSplit ? [split] : []), chrome)
  return { root, chrome, split, toggle }
}

describe('toolbarAnchor', () => {
  it('goes in front of 分栏 when the strip has it', () => {
    const s = strip(true)
    const anchor = toolbarAnchor(s.toggle as unknown as Element)
    expect(anchor?.strip).toBe(s.root)
    expect(anchor?.before).toBe(s.split)
  })

  it('goes in front of 全屏 / 收起 when 分栏 is hidden (two panes)', () => {
    const s = strip(false)
    expect(toolbarAnchor(s.toggle as unknown as Element)?.before).toBe(s.chrome)
  })

  it('gives up on a detached toggle', () => {
    expect(toolbarAnchor(new Node(['data-sidebar-right-toggle']) as unknown as Element)).toBeUndefined()
  })
})
