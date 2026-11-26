// @ts-check
/** @import { ElementId } from "corten" */

/**
 * Let Corten keep focus on the active book tab when the link itself won't survive navigation.
 * @param {PointerEvent} event
 * @param {ElementId} tab
 */
export function keepFocus(event, tab) {
  if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return;
  document.getElementById(tab)?.focus({ preventScroll: true });
}
