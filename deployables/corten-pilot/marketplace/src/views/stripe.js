// @ts-check
// Stripe.js for the two secure steps, a payment's (payment_entry.js) and a saved payment
// method's setup (payment_setup.js), and Connect.js's URL for payout setup (connect_surface.js).
// Stripe.js loads from Stripe (as @stripe/stripe-js 9.9.0's loadStripe loads it), once per page
// load. Stripe's components keep Stripe's own default appearance: no page passes one.

/** Stripe.js for @stripe/stripe-js 9.9.0's release train. */
const STRIPE_JS = "https://js.stripe.com/dahlia/stripe.js";
/** Connect.js for @stripe/connect-js 3.x (its V1_URL). */
const CONNECT_JS = "https://connect-js.stripe.com/v1.0/connect.js";

/**
 * Connect.js's URL as a script's src (connect_surface.js). The page requires Trusted Types; on a
 * Stripe area's pages (app.rs's `script_src`) `<Corten />` makes the `default` policy that lets a
 * script, and the scripts Stripe loads itself, set a URL on another origin as a script's src, and
 * the CSP holds it to Stripe's.
 */
export function connectScriptUrl() {
  return CONNECT_JS;
}

/** @type {Promise<any> | null} */
let loading = null;

/** Stripe's constructor, its script added to the page the first time. */
export function loadStripe() {
  const page = /** @type {any} */ (window);
  if (page.Stripe) return Promise.resolve(page.Stripe);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = STRIPE_JS;
    script.async = true;
    script.addEventListener("load", () => (page.Stripe ? resolve(page.Stripe) : reject(new Error())));
    script.addEventListener("error", () => {
      loading = null;
      script.remove();
      reject(new Error());
    });
    document.head.append(script);
  });
  return loading;
}
