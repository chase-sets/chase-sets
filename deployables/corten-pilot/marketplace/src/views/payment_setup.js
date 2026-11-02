// @ts-check
// Add's secure step on the saved payment methods page (marketplace's StripeSetupCard): Stripe's
// Payment Element mounted with the SetupIntent's secret and the page's theme, and Save payment
// method, which turns on once the fields are ready. Loading has one deadline over the whole chain,
// as the payment step's. Save is Stripe's confirmSetup; once Stripe accepts it the browser goes to
// the page with the setup's reference, which asks Payments what it saved and reads itself again
// until it knows or `until` passes (five minutes, as marketplace's card polls).
import { keep } from "corten";
import { appearance, loadStripe } from "./stripe.js";

/** As the payment step's: half the account-payment UAT's 60 s readiness ceiling. */
const DEADLINE_MS = 30_000;
/** How long the page reads the setup's outcome again, as marketplace's POLL_MAX_DURATION_MS. */
const WATCH_SECONDS = 5 * 60;

/**
 * The step's parts the script shows and fills.
 * @typedef {object} Parts
 * @property {HTMLDivElement} fields
 * @property {HTMLDivElement} skeleton
 * @property {HTMLDivElement} error
 * @property {HTMLParagraphElement} error_text
 * @property {HTMLDivElement} processing
 * @property {HTMLButtonElement} save
 */

/**
 * The step's state: Stripe and what is mounted, and whether Save may run.
 * @typedef {object} State
 * @property {any} stripe
 * @property {any} elements
 * @property {any} element
 * @property {boolean} ready
 * @property {"idle" | "confirming" | "processing"} phase
 */

const kept = () =>
  keep(() => /** @type {State} */ ({ stripe: null, elements: null, element: null, ready: false, phase: "idle" }));

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
 * When the fields' place joins the page: load Stripe and mount its Payment Element with the
 * SetupIntent's secret and the page's theme, then turn Save on; any failure, or no answer within
 * the deadline, says Stripe could not load (or what Stripe said). Leaving the page unmounts it.
 *
 * @param {HTMLDivElement} target
 * @param {Parts} parts
 * @param {string} key
 * @param {string} secret
 * @param {string} couldNotLoad
 * @param {AbortSignal} signal
 */
export async function mount(target, parts, key, secret, couldNotLoad, signal) {
  const state = kept();
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
  try {
    const Stripe = await loadStripe();
    if (abandoned()) return;
    const stripe = Stripe(key);
    const elements = stripe.elements({ clientSecret: secret, appearance: appearance(target) });
    const element = elements.create("payment");
    element.mount(target);
    state.element = element;
    if (abandoned()) return unmount(state);
    state.stripe = stripe;
    state.elements = elements;
    state.ready = true;
    clearTimeout(deadline);
    parts.skeleton.hidden = true;
    parts.fields.parentElement?.removeAttribute("aria-busy");
    parts.save.disabled = false;
  } catch (error) {
    clearTimeout(deadline);
    unmount(state);
    if (!abandoned()) fail(parts, error instanceof Error && error.message ? error.message : couldNotLoad);
  }
}

/**
 * Save payment method: Stripe confirms what was entered (a step it needs, such as 3-D Secure, in
 * its own frame); a refusal says Stripe's words and Save is on again. Once it succeeds the step
 * says the method is being saved and the browser goes to `after`, the page with the setup's
 * reference, until when to read it again added.
 *
 * @param {Parts} parts
 * @param {string} after
 * @param {string} couldNotComplete
 * @param {string} stillLoading
 * @param {string} confirming
 * @param {string} processing
 */
export async function save(parts, after, couldNotComplete, stillLoading, confirming, processing) {
  const state = kept();
  if (state.phase !== "idle") return;
  if (!state.ready) {
    fail(parts, stillLoading);
    return;
  }
  const label = parts.save.textContent ?? "";
  state.phase = "confirming";
  parts.error.hidden = true;
  parts.save.disabled = true;
  parts.save.textContent = confirming;
  /** @param {string} message */
  const refused = (message) => {
    state.phase = "idle";
    parts.save.disabled = false;
    parts.save.textContent = label;
    fail(parts, message || couldNotComplete);
  };
  try {
    const result = await state.stripe.confirmSetup({ elements: state.elements, redirect: "if_required" });
    if (result?.error) return refused(result.error.message);
  } catch (error) {
    return refused(error instanceof Error ? error.message : "");
  }
  state.phase = "processing";
  parts.save.textContent = processing;
  parts.processing.hidden = false;
  const next = new URL(after, location.href);
  next.searchParams.set("until", String(Math.floor(Date.now() / 1000) + WATCH_SECONDS));
  location.assign(next.pathname + next.search);
}
