// @ts-check
// The payment page's secure step (marketplace's StripeConfirmationCard). Stripe.js loads as
// stripe.js loads it, once per page load; the fields mount in the step and Confirm payment turns
// on once they are ready. A Checkout Session's secret (cs_...) uses Stripe's Checkout Elements, any other the
// Payment Element. Loading has one deadline over the whole chain, since Stripe sets none. Confirm
// is Stripe's own; once it succeeds the payment's status changes when the provider tells
// Payments, so the step says the payment is being updated and reads the status part until it
// changes (the page's watch, a ReadAgain in its markup).
import { keep, patch } from "corten";
import { appearance, loadStripe } from "./stripe.js";

/** Half the account-payment UAT's 60 s readiness ceiling, as marketplace's. */
const DEADLINE_MS = 30_000;
/** How long a watch started by Confirm lasts, as the page's own. */
const WATCH_SECONDS = 5 * 60;
/**
 * Stripe's refusal of a defaultValues email for a Checkout Session that already has one (a repeat
 * buyer); it has no code, so the sentence is the contract, as marketplace's.
 */
const SESSION_OWNED_EMAIL_REFUSAL =
  "You cannot update the email because a `customer_email` or `customer` with an email is already set on the Checkout Session.";

/**
 * The step's parts the script shows and fills.
 * @typedef {object} Parts
 * @property {HTMLDivElement} fields
 * @property {HTMLDivElement} skeleton
 * @property {HTMLDivElement} error
 * @property {HTMLParagraphElement} error_text
 * @property {HTMLDivElement} processing
 */

/**
 * What Stripe's fields start with.
 * @typedef {{ billingDetails: { email: string, name?: string, address?: object } }} Defaults
 */

/**
 * The step's state: Stripe and what is mounted, whether Confirm may run, and the email to confirm with.
 * @typedef {object} State
 * @property {any} stripe
 * @property {any} elements
 * @property {any} actions
 * @property {any} element
 * @property {boolean} ready
 * @property {"idle" | "confirming" | "processing"} phase
 * @property {boolean} sessionOwnsEmail
 * @property {string} email
 */

const kept = () =>
  keep(
    () =>
      /** @type {State} */ ({
        stripe: null,
        elements: null,
        actions: null,
        element: null,
        ready: false,
        phase: "idle",
        sessionOwnsEmail: false,
        email: "",
      }),
  );

/** @param {State} state */
function unmount(state) {
  const element = state.element;
  state.element = null;
  state.ready = false;
  try {
    element?.destroy();
  } catch {}
}

/** @param {Parts} parts @param {string} message */
function fail(parts, message) {
  parts.skeleton.hidden = true;
  parts.fields.parentElement?.removeAttribute("aria-busy");
  parts.error_text.textContent = message;
  parts.error.hidden = false;
}

/**
 * Every Confirm payment of the step: its label and whether it is off.
 * @param {ParentNode} scope @param {string | null} label @param {boolean} off
 */
function buttons(scope, label, off) {
  for (const button of Array.from(scope.querySelectorAll("button[data-payment-confirm]"))) {
    const b = /** @type {HTMLButtonElement} */ (button);
    b.dataset.label ??= b.textContent ?? "";
    b.textContent = label ?? b.dataset.label;
    b.disabled = off;
  }
}

/**
 * When the fields' place joins the page: load Stripe, mount its fields with the page's theme and
 * the buyer's details, and turn Confirm payment on; any failure, or no answer within the deadline,
 * says Stripe could not load (or what Stripe said). Leaving the page unmounts them.
 *
 * @param {HTMLDivElement} target
 * @param {Parts} parts
 * @param {string} key
 * @param {string} secret
 * @param {Defaults} defaults
 * @param {string} couldNotLoad
 * @param {AbortSignal} signal
 */
export async function mount(target, parts, key, secret, defaults, couldNotLoad, signal) {
  const state = kept();
  state.email = defaults.billingDetails.email.trim();
  let late = false;
  const deadline = setTimeout(() => {
    late = true;
    unmount(state);
    fail(parts, couldNotLoad);
  }, DEADLINE_MS);
  signal.addEventListener("abort", () => {
    clearTimeout(deadline);
    unmount(state);
  });
  const abandoned = () => late || signal.aborted;
  /** @param {any} element */
  const put = (element) => {
    element.mount(target);
    state.element = element;
  };
  try {
    const Stripe = await loadStripe();
    if (abandoned()) return;
    const stripe = Stripe(key);
    const look = appearance(target);
    const wallets = { applePay: "auto", googlePay: "auto" };
    if (secret.startsWith("cs_")) {
      let checkout = stripe.initCheckoutElementsSdk({
        clientSecret: secret,
        elementsOptions: { appearance: look },
        defaultValues: state.email ? { email: state.email } : undefined,
      });
      put(checkout.createPaymentElement({ wallets }));
      let loaded;
      try {
        loaded = await checkout.loadActions();
      } catch (error) {
        if (!(state.email && error instanceof Error && error.message === SESSION_OWNED_EMAIL_REFUSAL)) throw error;
        loaded = { type: "error", error: { message: error.message } };
      }
      if (abandoned()) return unmount(state);
      if (state.email && loaded?.type === "error" && loaded.error?.message === SESSION_OWNED_EMAIL_REFUSAL) {
        // The session already has the buyer's email: once more without it, the session's email kept.
        unmount(state);
        checkout = stripe.initCheckoutElementsSdk({ clientSecret: secret, elementsOptions: { appearance: look } });
        put(checkout.createPaymentElement({ wallets }));
        loaded = await checkout.loadActions();
        if (abandoned()) return unmount(state);
        state.sessionOwnsEmail = true;
      }
      if (loaded?.type !== "success") throw new Error(loaded?.error?.message || couldNotLoad);
      state.actions = loaded.actions;
    } else {
      const elements = stripe.elements({ clientSecret: secret, appearance: look });
      put(elements.create("payment", { wallets, defaultValues: defaults }));
      state.elements = elements;
    }
    state.stripe = stripe;
    state.ready = true;
    clearTimeout(deadline);
    parts.skeleton.hidden = true;
    parts.fields.parentElement?.removeAttribute("aria-busy");
    buttons(parts.fields.closest("[data-payment-entry]") ?? document, null, false);
  } catch (error) {
    clearTimeout(deadline);
    unmount(state);
    if (!abandoned()) fail(parts, error instanceof Error && error.message ? error.message : couldNotLoad);
  }
}

/**
 * Confirm payment: Stripe confirms what the buyer entered (a step it needs, such as 3-D Secure, in
 * its own frame); a refusal says Stripe's words and Confirm is on again. Once it succeeds the step
 * says the payment is being updated, Confirm stays off, and the status part is read until the
 * provider has told Payments.
 *
 * @param {HTMLElement} scope
 * @param {Parts} parts
 * @param {string} watch the status part's address
 * @param {string} couldNotComplete
 * @param {string} stillLoading
 * @param {string} confirming
 * @param {string} processing
 */
export async function confirm(scope, parts, watch, couldNotComplete, stillLoading, confirming, processing) {
  const state = kept();
  if (state.phase !== "idle") return;
  if (!state.ready) {
    fail(parts, stillLoading);
    return;
  }
  state.phase = "confirming";
  parts.error.hidden = true;
  buttons(scope, confirming, true);
  /** @param {string} message */
  const refused = (message) => {
    state.phase = "idle";
    buttons(scope, null, false);
    fail(parts, message || couldNotComplete);
  };
  try {
    if (state.actions) {
      const result = await state.actions.confirm({
        redirect: "if_required",
        // After the session-owned-email fallback the session's email stands.
        email: state.sessionOwnsEmail || !state.email ? undefined : state.email,
      });
      if (result?.type === "error") return refused(result.error?.message);
    } else {
      const result = await state.stripe.confirmPayment({ elements: state.elements, redirect: "if_required" });
      if (result?.error) return refused(result.error.message);
    }
  } catch (error) {
    return refused(error instanceof Error ? error.message : "");
  }
  state.phase = "processing";
  buttons(scope, processing, true);
  parts.processing.hidden = false;
  if (watch) {
    const again = new URL(watch, location.href);
    again.searchParams.set("until", String(Math.floor(Date.now() / 1000) + WATCH_SECONDS));
    void read(again.pathname + again.search);
  }
}

/**
 * Read the status part at `href` and apply it; it asks to be read again while the status is
 * unchanged.
 * @param {string} href
 */
async function read(href) {
  const res = await fetch(href, { headers: { corten: "action" } }).catch(() => null);
  if (!res?.headers.has("corten-patch")) return;
  await patch(await res.text());
}
