// @ts-check
// The checkout page's script. The form works without it: Pay now writes the review again first
// when a field changed since the totals were drawn. With it, the page says so as soon as a
// delivery, shipping or payment field changes: it marks the page, whose stylesheet then shows
// "Totals need refresh" and Update totals in place of Pay now (marketplace's markReviewStale). The
// contact email does not change the totals.
//
// A new card (marketplace's DeferredStripePayment): Stripe's fields mount in the payment step for
// the quoted amount, and Pay now turns on once they are ready. Pressing it has Stripe check the
// card and turn it into a single-use confirmation token, which goes in the form's hidden field;
// the form is then sent as Pay now sent it, and Checkout confirms the payment as it starts it.
// Loading has one deadline over the whole chain, since Stripe sets none.
import { keep } from "corten";
import { loadStripe } from "./stripe.js";

/** As marketplace's card entry: Stripe's fields have this long to be ready. */
const DEADLINE_MS = 15_000;

/**
 * The card entry's parts the script shows and fills.
 * @typedef {object} Parts
 * @property {HTMLDivElement} fields
 * @property {HTMLDivElement} skeleton
 * @property {HTMLDivElement} error
 * @property {HTMLParagraphElement} error_text
 */

/**
 * What the card entry mounts with: the Rust `checkout::DeferredCard`, declared by `corten::types`.
 * @typedef {import("../../types/app").DeferredCard} DeferredCard
 */

/**
 * The page's card: Stripe and its fields, whether Pay now may use them, whether a press is being
 * turned into a token, the choice to save the card the fields were last told, the token this
 * page view made for the send under way, and the parts and message a failure shows.
 * @typedef {object} State
 * @property {any} stripe
 * @property {any} elements
 * @property {any} element
 * @property {boolean} ready
 * @property {boolean} paying
 * @property {boolean} save
 * @property {string} token
 * @property {Parts | null} parts
 * @property {ParentNode | null} scope
 * @property {string} couldNotComplete
 */

const kept = () =>
  keep(
    () =>
      /** @type {State} */ ({
        stripe: null,
        elements: null,
        element: null,
        ready: false,
        paying: false,
        save: false,
        token: "",
        parts: null,
        scope: null,
        couldNotComplete: "",
      }),
  );

/**
 * A field changed: the totals on screen may no longer be the ones Pay now would charge.
 * @param {Event} event
 */
export function stale(event) {
  const field = event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) return;
  if (field.type === "hidden" || field.name === "shippingEmail") return;
  const page = field.closest("[data-checkout]");
  if (page instanceof HTMLElement && !page.hasAttribute("data-stale")) page.setAttribute("data-stale", "");
}

/** @param {State} state */
function unmount(state) {
  const element = state.element;
  state.element = null;
  state.elements = null;
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
 * Every Pay now on the page (the form's and the phone bar's): on or off.
 * @param {ParentNode} scope @param {boolean} off
 */
function payNow(scope, off) {
  for (const button of Array.from(scope.querySelectorAll('button[data-commit="pay"]'))) {
    /** @type {HTMLButtonElement} */ (button).disabled = off;
  }
}

/**
 * When the card's place joins the page: load Stripe, mount its fields for the quoted amount with
 * the buyer's details, and turn Pay now on; a failure, or no answer within the deadline, says
 * Stripe could not complete it and Pay now stays off. Leaving the page unmounts them.
 *
 * @param {HTMLDivElement} target
 * @param {Parts} parts
 * @param {HTMLElement} scope
 * @param {DeferredCard} card
 * @param {string} couldNotComplete
 * @param {AbortSignal} signal
 */
export async function mount(target, parts, scope, card, couldNotComplete, signal) {
  const state = kept();
  unmount(state);
  state.parts = parts;
  state.scope = scope;
  state.couldNotComplete = couldNotComplete;
  state.save = false;
  state.token = "";
  let late = false;
  const deadline = setTimeout(() => {
    late = true;
    unmount(state);
    fail(parts, couldNotComplete);
  }, DEADLINE_MS);
  signal.addEventListener("abort", () => {
    clearTimeout(deadline);
    unmount(state);
  });
  const abandoned = () => late || signal.aborted;
  try {
    const Stripe = await loadStripe();
    if (abandoned()) return;
    const stripe = Stripe(card.publishableKey);
    const elements = stripe.elements({
      mode: "payment",
      amount: card.amount,
      currency: card.currency,
      captureMethod: "automatic",
    });
    const element = elements.create("payment", {
      ...(card.defaults ? { defaultValues: card.defaults } : {}),
      wallets: { applePay: "auto", googlePay: "auto" },
    });
    state.stripe = stripe;
    state.elements = elements;
    state.element = element;
    element.on("loaderror", () => {
      if (abandoned()) return;
      clearTimeout(deadline);
      unmount(state);
      fail(parts, couldNotComplete);
    });
    element.on("ready", () => {
      if (abandoned() || state.element !== element) return;
      clearTimeout(deadline);
      state.ready = true;
      parts.skeleton.hidden = true;
      parts.fields.parentElement?.removeAttribute("aria-busy");
      payNow(scope, false);
    });
    element.mount(target);
  } catch {
    clearTimeout(deadline);
    unmount(state);
    if (!abandoned()) fail(parts, couldNotComplete);
  }
}

/**
 * A page the browser keeps for Back and Forward comes back as it was left: Pay now off and the
 * token it sent, which Stripe will not take twice. Forget that token and turn Pay now on again.
 */
addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  const state = kept();
  state.token = "";
  state.paying = false;
  if (state.ready && state.scope) payNow(state.scope, false);
});

/**
 * Pay now with a new card: Stripe checks what the buyer entered and makes a confirmation token,
 * which the form then sends with Pay now. A refusal says Stripe's words and Pay now is on again.
 * Any other submit, or the send carrying the token this page view just made, goes as it is. A
 * token the browser put back in the field (restoring the form on Back) is spent, so it is
 * dropped and a new one made.
 *
 * @param {SubmitEvent} event
 * @param {HTMLInputElement} token
 */
export async function pay(event, token) {
  const state = kept();
  const form = event.target;
  const submitter = event.submitter;
  if (!(form instanceof HTMLFormElement) || submitter?.getAttribute("value") !== "confirm-checkout") return;
  if (!state.elements || (token.value && token.value === state.token)) return;
  event.preventDefault();
  token.value = "";
  const { parts, scope } = state;
  if (!state.ready || state.paying || !parts || !scope) return;
  state.paying = true;
  parts.error.hidden = true;
  payNow(scope, true);
  const elements = state.elements;
  const refused = (message = "") => {
    state.paying = false;
    if (state.elements !== elements) return;
    payNow(scope, false);
    fail(parts, message || state.couldNotComplete);
  };
  try {
    const save = new FormData(form).get("savePaymentMethodForFuture") === "true";
    if (save !== state.save) {
      await elements.update({ setupFutureUsage: save ? "off_session" : null });
      state.save = save;
    }
    const submitted = await elements.submit();
    if (submitted?.error) return refused(submitted.error.message);
    const result = await state.stripe.createConfirmationToken({ elements });
    if (result?.error) return refused(result.error.message);
    if (state.elements !== elements) return refused();
    state.token = token.value = result.confirmationToken.id;
    // A disabled button is left out of what the form sends, so Pay now is on for the send and
    // off again while the next page loads.
    const button = submitter instanceof HTMLButtonElement ? submitter : null;
    if (button) button.disabled = false;
    form.requestSubmit(button);
    if (button) button.disabled = true;
  } catch (error) {
    refused(error instanceof Error ? error.message : undefined);
  }
}
