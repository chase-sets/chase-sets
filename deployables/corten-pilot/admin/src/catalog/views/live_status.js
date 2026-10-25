// @ts-check
// LiveStatus (live_status.rs): writes when the list's stream went stale, in the page's locale.
// The live, connecting and stale states are CSS on <corten-live>'s `status`.
/** @import { Message } from "corten" */

/** admin-web's `formatDateTime`: "Oct 25, 2026, 3:04 PM UTC". */
const format = new Intl.DateTimeFormat(document.documentElement.lang || "en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/**
 * Writes when the stream went stale, from <corten-live>'s `stale-since`. It runs on connect (for
 * the state before the scripts loaded) and on each `corten-status` the element dispatches.
 * @param {Element} target Inside the <corten-live>, or the element itself.
 * @param {HTMLElement} since @param {Message<"value">} staleSince
 */
export function stale(target, since, staleSince) {
  const at = target.closest("corten-live")?.getAttribute("stale-since");
  if (at) since.textContent = staleSince({ value: `${format.format(new Date(at))} UTC` });
}
