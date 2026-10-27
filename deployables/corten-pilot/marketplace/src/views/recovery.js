// @ts-check

/** The kinds of write the screen sends (`InventoryMutationFamily`). */
const families = [
  "item-create",
  "item-adjust",
  "hold-create",
  "hold-release",
  "location-create",
  "location-update",
  "location-archive",
  "restock-record",
];

/** marketplace's sessionStorage key for an account's pending write of one kind. */
function key(/** @type {string} */ account, /** @type {string} */ family) {
  return `inventory-mutation/v1:${encodeURIComponent(account)}:${family}`;
}

/**
 * The fields of the hidden form that asks the page to check a write.
 * @typedef {object} Check
 * @property {HTMLFormElement} form
 * @property {HTMLInputElement} attempt
 * @property {HTMLInputElement} family
 * @property {HTMLInputElement} target
 * @property {HTMLInputElement} user
 */

/**
 * When the status joins the page: forget the write this answer settles, and ask the page to
 * check any other the browser remembers. A write the page checked and could not confirm stays
 * remembered, and is not asked about again until the seller asks.
 *
 * @param {Check} check
 * @param {string} account
 * @param {string} settled the attempt this answer settles, or ""
 * @param {string} unsettled the attempt this page could not confirm, or ""
 */
export function restore(check, account, settled, unsettled) {
  /** @type {Storage} */
  let storage;
  try {
    storage = window.sessionStorage;
  } catch {
    return;
  }
  for (const family of families) {
    const raw = storage.getItem(key(account, family));
    if (raw === null) continue;
    /** @type {{ attemptId?: unknown, targetId?: unknown, actorUserId?: unknown } | null} */
    let record = null;
    try {
      record = raw.length <= 2048 ? JSON.parse(raw) : null;
    } catch {
      record = null;
    }
    const text = (/** @type {unknown} */ value) => (typeof value === "string" ? value : "");
    const attempt = text(record?.attemptId) || "unreadable";
    if (attempt === settled) {
      storage.removeItem(key(account, family));
      continue;
    }
    if (attempt === unsettled) return;
    check.attempt.value = attempt;
    check.family.value = family;
    check.target.value = text(record?.targetId);
    check.user.value = text(record?.actorUserId);
    // The check is a GET of the page, so it carries the page's own place (an open Record sale, the
    // list's page) along; otherwise checking a write would close what the seller opened.
    const here = new URLSearchParams(location.search);
    for (const name of ["attempt", "family", "target", "user"]) here.delete(name);
    for (const [name, value] of here) {
      const field = document.createElement("input");
      field.type = "hidden";
      field.name = name;
      field.value = value;
      check.form.append(field);
    }
    // Before the page's load event this is a full page load, not a swap (Corten's on:connect).
    check.form.requestSubmit();
    return;
  }
}

/**
 * Before a write form is sent: remember its attempt (the form's `SubmitKey`, which the runtime
 * keeps until an answer arrives), so the next page can check it if the answer is lost. A browser
 * that cannot remember it sends nothing and says so.
 *
 * @param {SubmitEvent} event
 * @param {string} account
 * @param {string} user
 * @param {string} family
 * @param {string} target
 * @param {HTMLParagraphElement} unavailable
 */
export function remember(event, account, user, family, target, unavailable) {
  const form = /** @type {HTMLFormElement} */ (event.target);
  // A button that asks the page again (`formmethod="get"`) writes nothing, so there is nothing
  // to remember.
  const submitter = /** @type {SubmitEvent} */ (event).submitter;
  if ((submitter?.getAttribute("formmethod") ?? form.method).toLowerCase() === "get") return;
  const attempt = /** @type {HTMLInputElement | null} */ (form.querySelector("input[data-submit]"))?.value ?? "";
  const record = {
    version: 1,
    attemptId: attempt,
    accountId: account,
    actorUserId: user,
    family,
    targetId: target,
    createdAt: new Date().toISOString(),
  };
  try {
    window.sessionStorage.setItem(key(account, family), JSON.stringify(record));
  } catch {
    event.preventDefault();
    unavailable.hidden = false;
    unavailable.focus();
  }
}

/**
 * The discard button: shown only with this script, which is the only one that can forget.
 * @param {HTMLButtonElement} button
 */
export function reveal(button) {
  button.hidden = false;
}

/**
 * Forget a write the page could not confirm, after the seller agrees, and load the list.
 *
 * @param {string} account
 * @param {string} family
 * @param {string} question
 * @param {string} list
 */
export function discard(account, family, question, list) {
  if (!window.confirm(question)) return;
  try {
    window.sessionStorage.removeItem(key(account, family));
  } catch {
    return;
  }
  location.assign(list);
}
