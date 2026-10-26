// @ts-check
// LiveStatus (live_status.rs): writes when the stream went stale, in the page's locale.
// The live, connecting and stale states are CSS on <corten-live>'s `status`.
/** @import { DateFormat, Message } from "corten" */

/**
 * Writes when the stream went stale, from <corten-live>'s `stale-since`, as the server writes a
 * time (admin-web's `formatDateTime`: "Oct 25, 2026, 3:04 PM UTC"). It runs on connect (for the
 * state before the scripts loaded) and on each `corten-status` the element dispatches.
 * @param {Element} target Inside the <corten-live>, or the element itself.
 * @param {HTMLElement} since @param {Message<"value">} staleSince @param {DateFormat} when
 */
export function stale(target, since, staleSince, when) {
  const at = target.closest("corten-live")?.getAttribute("stale-since");
  if (at) since.textContent = staleSince({ value: when(at) });
}
