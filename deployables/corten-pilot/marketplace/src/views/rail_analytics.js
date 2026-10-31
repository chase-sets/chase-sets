// @ts-check
// The item page's and search's analytics, after marketplace-web's (`trackItemDetailRailEvent` and
// the bridge its root installs): each event goes to window listeners and dataLayer, and its
// allowlisted labels to /analytics/item-detail-rail with sendBeacon. Nothing on either page needs
// it: without it a link is still a link.

const ENDPOINT = "/analytics/item-detail-rail";

/** A label marketplace's bridge keeps: ASCII, 80 characters or fewer. @param {unknown} value */
function label(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= 80 && /^[a-zA-Z0-9_.-]+$/.test(text) ? text : null;
}

/** A SHA-256 correlation key. @param {unknown} value */
function sha256(value) {
  const text = label(value);
  return text && /^[a-f0-9]{64}$/.test(text) ? text : null;
}

/** `trackItemDetailRailEvent`, then the bridge's post. @param {Record<string, unknown>} detail */
function track(detail) {
  window.dispatchEvent(new CustomEvent("chase-sets:item-detail-rail-analytics", { detail }));
  /** @type {any} */ (window).dataLayer?.push(detail);
  const position = detail.position;
  const body = JSON.stringify({
    event: detail.event,
    intent: label(detail.intent),
    workflow: label(detail.workflow),
    selection: label(detail.selection),
    topic: label(detail.topic),
    outcome: label(detail.outcome),
    gate: label(detail.gate),
    viewer: label(detail.viewer),
    surface: label(detail.surface),
    position: typeof position === "number" && Number.isInteger(position) && position > 0 ? position : null,
    queryHash: sha256(detail.queryHash),
    resultSetKey: sha256(detail.resultSetKey),
  });
  if (navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: "application/json" }))) return;
  fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    credentials: "same-origin",
    keepalive: true,
  }).catch(() => undefined);
}

/**
 * A search result's link to its item: where it was in the results, and the search's keys (none
 * when the API sent none, and then nothing is sent, as marketplace's card does).
 * @param {number} position
 * @param {string} queryHash
 * @param {string} resultSetKey
 */
export function searchResult(position, queryHash, resultSetKey) {
  if (!queryHash || !resultSetKey) return;
  track({ event: "search_result_selected", position, queryHash, resultSetKey, surface: "search_results" });
}

/** A similar item's link: which one is never sent. */
export function similarItem() {
  track({ event: "similar_item_selected", surface: "similar_items", selection: "implicit" });
}

/**
 * Buy, Sell or Watch: the side, the workflow and selection the page's choices give it, who is
 * looking, and where. The rail's links count only a change of side, as marketplace's segmented
 * control does; the mobile dock's count every tap, as its sheet opens each time.
 * @param {boolean} changed
 * @param {string} intent
 * @param {string} workflow
 * @param {string} selection
 * @param {string} viewer
 * @param {string} surface
 */
export function railIntent(changed, intent, workflow, selection, viewer, surface) {
  if (!changed) return;
  track({ event: "rail_intent_selected", intent, workflow, selection, viewer, surface });
}
