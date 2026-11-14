// @ts-check
// The registration page's analytics, after marketplace's (`trackRegistrationAnalytics` in Auth's
// register-page.tsx): each event goes to window listeners and dataLayer, nothing to the server. A
// method is a link here, so a choice is counted by the page it opens. Without the script nothing
// is counted, and the page works the same.

/** Marketplace's order (`REGISTRATION_METHOD_OPTIONS`), which gives each method's priority. */
const METHODS = ["passkey", "phone-code", "magic-link", "password"];
/** The method a link chose, for the page it opens to count. */
const CHOSEN = "chase-sets:registration-chosen";

/** The passkey step's failure in the browser (platform's `passkey.js`). */
const PASSKEY_FAILED = "chase-sets:passkey-failed";

/** A form of the page was sent, so leaving is not abandoning. */
let sent = false;
/** A method's link was followed, so leaving is choosing. */
let choosing = false;

/** @param {{ method: string, stage: string, reason?: string }} event */
function track(event) {
  const payload = {
    flow: "registration",
    priority: METHODS.indexOf(event.method) + 1,
    presentedMethods: METHODS,
    ...event,
  };
  window.dispatchEvent(new CustomEvent("chase-sets:registration-method", { detail: payload }));
  /** @type {any} */ (window).dataLayer?.push({ event: "registration_method", ...payload });
}

/** The method a link chose before this page opened, once. */
function chosen() {
  try {
    const method = sessionStorage.getItem(CHOSEN);
    sessionStorage.removeItem(CHOSEN);
    return method;
  } catch {
    return null;
  }
}

/**
 * The methods joined the page. The page as an address opens it counts every method shown, or only
 * the one a link chose; a form's answer counts neither, as marketplace's page stays open, and
 * leaving it is not abandoning, as a form was sent. Leaving the page with nothing sent counts as
 * abandoned, and the passkey step failing in the browser counts as failed.
 * @param {AbortSignal} signal
 * @param {string} method the method shown
 * @param {boolean} opened
 */
export function watch(signal, method, opened) {
  sent = !opened;
  choosing = false;
  addEventListener(
    PASSKEY_FAILED,
    () => track({ method: "passkey", stage: "failed", reason: "browser-passkey-failed" }),
    {
      signal,
    },
  );
  if (opened) {
    if (chosen() === method) track({ method, stage: "selected" });
    else for (const shown of METHODS) track({ method: shown, stage: "shown" });
  }
  addEventListener(
    "beforeunload",
    () => {
      if (!sent && !choosing) track({ method, stage: "abandoned" });
    },
    { signal },
  );
}

/**
 * Another method's link followed in this tab: the page it opens counts the choice.
 * @param {PointerEvent} event
 * @param {string} method
 */
export function choose(event, method) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  choosing = true;
  try {
    sessionStorage.setItem(CHOSEN, method);
  } catch {
    // Without storage the page it opens counts every method shown.
  }
}

/**
 * A form of the page sent. One a handler stopped is not: the passkey step stops its first press
 * to create the credential, and counts when it sends the form with it.
 * @param {SubmitEvent} event
 * @param {string} method
 */
export function completed(event, method) {
  if (event.defaultPrevented) return;
  sent = true;
  track({ method, stage: "completed" });
}

/**
 * A form came back refused, with marketplace's classification of the refusal.
 * @param {string} method
 * @param {string} reason
 */
export function failed(method, reason) {
  track({ method, stage: "failed", reason });
}
