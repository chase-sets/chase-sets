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
 * Follows the element's `stale-since`. <corten-live> fires no event when its status changes, so
 * this observes the attribute (todd-skelton/corten, see README.md, Corten gaps).
 * @param {HTMLElement} root @param {HTMLElement} since @param {AbortSignal} signal
 * @param {Message<"value">} staleSince
 */
export function watch(root, since, signal, staleSince) {
  const live = root.closest("corten-live");
  if (!live) return;
  const show = () => {
    const at = live.getAttribute("stale-since");
    if (at) since.textContent = staleSince({ value: `${format.format(new Date(at))} UTC` });
  };
  const observer = new MutationObserver(show);
  observer.observe(live, { attributes: true, attributeFilter: ["stale-since"] });
  signal.addEventListener("abort", () => observer.disconnect(), { once: true });
  show();
}
