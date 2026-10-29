// @ts-check

/** The browser's record of a shipment's write the page has not settled, one per shipment. */
function key(/** @type {string} */ account, /** @type {string} */ shipment) {
  return `shipment-mutation/v1:${encodeURIComponent(account)}:${encodeURIComponent(shipment)}`;
}

/**
 * The fields of the hidden form that asks the page to check a write.
 * @typedef {object} Check
 * @property {HTMLFormElement} form
 * @property {HTMLInputElement} attempt
 */

/**
 * When the status joins the page: forget the write this answer settles, and ask the page to check
 * any other the browser remembers for this shipment. A write the page checked and could not
 * confirm stays remembered, and is not asked about again until the seller asks.
 *
 * @param {Check} check
 * @param {string} account
 * @param {string} shipment
 * @param {string} settled the attempt this answer settles, or ""
 * @param {string} unsettled the attempt this page could not confirm, or ""
 */
export function restore(check, account, shipment, settled, unsettled) {
  /** @type {Storage} */
  let storage;
  try {
    storage = window.sessionStorage;
  } catch {
    return;
  }
  const raw = storage.getItem(key(account, shipment));
  if (raw === null) return;
  /** @type {{ attemptId?: unknown } | null} */
  let record = null;
  try {
    record = raw.length <= 2048 ? JSON.parse(raw) : null;
  } catch {
    record = null;
  }
  const attempt = typeof record?.attemptId === "string" && record.attemptId ? record.attemptId : "unreadable";
  if (attempt === settled) {
    storage.removeItem(key(account, shipment));
    return;
  }
  if (attempt === unsettled) return;
  check.attempt.value = attempt;
  // Before the page's load event this is a full page load, not a swap (Corten's on:connect).
  check.form.requestSubmit();
}

/**
 * Before a write form is sent: remember its attempt (the form's `SubmitKey`), so the next page
 * can check it if the answer is lost. A browser that cannot remember it sends nothing and says so.
 *
 * @param {SubmitEvent} event
 * @param {string} account
 * @param {string} shipment
 * @param {HTMLParagraphElement} unavailable
 */
export function remember(event, account, shipment, unavailable) {
  const form = /** @type {HTMLFormElement} */ (event.target);
  const attempt = /** @type {HTMLInputElement | null} */ (form.querySelector("input[data-submit]"))?.value ?? "";
  const record = {
    version: 1,
    attemptId: attempt,
    accountId: account,
    shipmentId: shipment,
    createdAt: new Date().toISOString(),
  };
  try {
    window.sessionStorage.setItem(key(account, shipment), JSON.stringify(record));
  } catch {
    event.preventDefault();
    unavailable.hidden = false;
    unavailable.focus();
  }
}

/**
 * A control only this script can work (discard): shown when it runs.
 * @param {HTMLElement} element
 */
export function reveal(element) {
  element.hidden = false;
}

/**
 * Forget a write the page could not confirm, after the seller agrees, and load the page.
 *
 * @param {string} account
 * @param {string} shipment
 * @param {string} attempt
 * @param {string} question
 * @param {string} page
 */
export function discard(account, shipment, attempt, question, page) {
  if (!window.confirm(question)) return;
  try {
    const raw = window.sessionStorage.getItem(key(account, shipment));
    if (raw === null || raw.includes(JSON.stringify(attempt)) || attempt === "unreadable") {
      window.sessionStorage.removeItem(key(account, shipment));
    }
  } catch {
    return;
  }
  location.assign(page);
}

/**
 * Once the packing slip is opened: the link offers it again, and the note says it opened.
 *
 * @param {HTMLAnchorElement} link
 * @param {HTMLSpanElement} label
 * @param {HTMLParagraphElement} note
 * @param {string} again
 * @param {string} againNewTab
 * @param {string} opened
 */
export function slip(link, label, note, again, againNewTab, opened) {
  label.textContent = again;
  link.setAttribute("aria-label", againNewTab);
  note.textContent = opened;
}
