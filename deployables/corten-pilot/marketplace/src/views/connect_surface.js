// @ts-check
// Stripe's Connect embedded components on payout setup (marketplace's
// StripeConnectEmbeddedComponent and StripeConnectNotificationBanner): Connect.js loads from
// Stripe, as @stripe/connect-js 3.4.5's loader loads it, once per page; each component asks the
// pilot for its session first (the page's session route, which asks Settlement), so a refusal is
// shown before Stripe loads, then mounts with that secret and asks again when Stripe needs a new
// one. Settlement's step_up_required shows Sign in again. Leaving Stripe's setup form (onExit)
// sends the page's Refresh setup status, as marketplace refreshes after it. Loading has one
// deadline over the whole chain, as the payment steps do.
import { connectAppearance } from "./stripe.js";

/** Connect.js for @stripe/connect-js 3.x (its V1_URL). */
const CONNECT_JS = "https://connect-js.stripe.com/v1.0/connect.js";
/** As the payment steps': half the account-payment UAT's 60 s readiness ceiling. */
const DEADLINE_MS = 30_000;

/** @type {Promise<any> | null} */
let loading = null;

/** Stripe's Connect, its script added to the page the first time. */
function loadConnect() {
  const page = /** @type {any} */ (window);
  if (page.StripeConnect && typeof page.StripeConnect.init === "function") return Promise.resolve(page.StripeConnect);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CONNECT_JS;
    script.async = true;
    script.addEventListener("load", () =>
      page.StripeConnect && typeof page.StripeConnect.init === "function"
        ? resolve(page.StripeConnect)
        : reject(new Error()),
    );
    script.addEventListener("error", () => {
      loading = null;
      script.remove();
      reject(new Error());
    });
    document.head.append(script);
  });
  return loading;
}

class Refused extends Error {
  /** @param {string | null} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * A session's client secret from the pilot.
 * @param {string} session @param {string} noSession
 */
async function secret(session, noSession) {
  const response = await fetch(session, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  /** @type {{ secret?: string | null, code?: string | null, message?: string | null }} */
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.secret) throw new Refused(body.code ?? null, body.message || noSession);
  return body.secret;
}

/** The component's tag for the session the page asked for. @param {string} session */
function component(session) {
  const which = new URL(session, location.href).searchParams.get("which");
  if (which === "management") return "account-management";
  if (which === "notifications") return "notification-banner";
  return "account-onboarding";
}

/**
 * The parts the script shows.
 * @typedef {object} Parts
 * @property {HTMLParagraphElement} loading
 * @property {HTMLDivElement} error
 * @property {HTMLParagraphElement} error_text
 * @property {HTMLDivElement} step_up
 * @property {HTMLParagraphElement} step_up_text
 */

/**
 * When the component's place joins the page: ask for a session, load Connect.js and mount Stripe's
 * component with the page's theme; any failure, or no answer within the deadline, says why.
 * Leaving the page removes it.
 *
 * @param {HTMLDivElement} target
 * @param {Parts} parts
 * @param {string} key
 * @param {string} session
 * @param {string} couldNotLoad
 * @param {string} noSession
 * @param {AbortSignal} signal
 */
export async function mount(target, parts, key, session, couldNotLoad, noSession, signal) {
  /** @type {HTMLElement | null} */
  let mounted = null;
  let done = false;
  const fail = (/** @type {unknown} */ error) => {
    if (done || signal.aborted) return;
    done = true;
    mounted?.remove();
    parts.loading.hidden = true;
    if (error instanceof Refused && error.code === "step_up_required") {
      if (error.message) parts.step_up_text.textContent = error.message;
      parts.step_up.hidden = false;
      return;
    }
    parts.error_text.textContent = error instanceof Error && error.message ? error.message : couldNotLoad;
    parts.error.hidden = false;
  };
  const deadline = setTimeout(() => fail(new Error(couldNotLoad)), DEADLINE_MS);
  signal.addEventListener("abort", () => {
    clearTimeout(deadline);
    mounted?.remove();
  });
  try {
    const first = await secret(session, noSession);
    const StripeConnect = await loadConnect();
    if (signal.aborted || done) return;
    let preflight = true;
    const instance = StripeConnect.init({
      publishableKey: key,
      fetchClientSecret: async () => {
        if (preflight) {
          preflight = false;
          return first;
        }
        return secret(session, noSession);
      },
      locale: document.documentElement.lang || "en-US",
      appearance: connectAppearance(target),
    });
    const element = instance.create(component(session));
    element.setOnLoaderStart?.(() => {
      clearTimeout(deadline);
      parts.loading.hidden = true;
    });
    element.setOnLoadError?.((/** @type {{ error?: { message?: string } }} */ loadError) => {
      clearTimeout(deadline);
      fail(new Error(loadError?.error?.message || couldNotLoad));
    });
    element.setOnExit?.(() => {
      const refresh = /** @type {HTMLButtonElement | null} */ (document.getElementById("payout-refresh"));
      refresh?.form?.requestSubmit(refresh);
    });
    target.replaceChildren(element);
    mounted = element;
  } catch (error) {
    clearTimeout(deadline);
    fail(error);
  }
}
