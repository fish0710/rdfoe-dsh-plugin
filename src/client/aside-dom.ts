/**
 * DOM facts about DSH's right-sidebar toolbar that the injected buttons rely
 * on (0.1.5-rc.2 and 0.1.7-alpha.2 render the same markup). Kept free of
 * React so it is unit-testable; views/Aside.tsx does the mounting.
 */

/** DSH's own toolbar buttons (both 0.1.5 and 0.1.7 mark them this way). */
export const NATIVE_TOGGLE = '[data-sidebar-right-toggle]'
export const HOST_ATTR = 'data-rdfoe-aside-toolbar'

/**
 * Where the buttons go in one pane strip: in front of the 分栏 button when the
 * strip has one, else in front of the chrome group holding 全屏 / 收起.
 * @returns the strip and the node to insert before, or undefined when the DOM
 * no longer has the shape this was written against.
 */
export function toolbarAnchor(toggle: Element): { strip: Element, before: Element } | undefined {
  const chrome = toggle.closest('[data-dockkit-strip-chrome]') ?? toggle.parentElement
  const strip = chrome?.parentElement
  if (!chrome || !strip) return undefined
  const previous = chrome.previousElementSibling
  const before = previous?.hasAttribute('data-dockkit-split-button') ? previous : chrome
  return { strip, before }
}
