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
 * The SVG filter Stripe.js's Payment Element parses with `DOMParser` and adds to the page as it
 * mounts, exactly as Stripe.js `dahlia` writes it (its loader's shimmer). Compared whole: if Stripe
 * changes it, it is refused, and the mount logs Stripe's TypeError as it did before this policy.
 */
const STRIPE_LOADER_SVG = [
  "",
  "    <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"0\" height=\"0\" aria-hidden=\"true\" focusable=\"false\">",
  "      <defs>",
  "        <filter id=\"__PrivateStripeElementLoader-filter\">",
  "          <feColorMatrix in=\"SourceGraphic\" type=\"matrix\" result=\"grayscale\"",
  "            values=\"0.2126 0.7152 0.0722 0 0",
  "                    0.2126 0.7152 0.0722 0 0",
  "                    0.2126 0.7152 0.0722 0 0",
  "                    0      0      0      1 0\"",
  "          />",
  "          <feComponentTransfer in=\"grayscale\" result=\"contrast\">",
  "            <feFuncR type=\"linear\" slope=\"3\" intercept=\"-1\" />",
  "            <feFuncG type=\"linear\" slope=\"3\" intercept=\"-1\" />",
  "            <feFuncB type=\"linear\" slope=\"3\" intercept=\"-1\" />",
  "          </feComponentTransfer>",
  "          <feComponentTransfer in=\"contrast\" result=\"blackWhite\">",
  "            <feFuncR type=\"discrete\" tableValues=\"1 0\" />",
  "            <feFuncG type=\"discrete\" tableValues=\"1 0\" />",
  "            <feFuncB type=\"discrete\" tableValues=\"1 0\" />",
  "          </feComponentTransfer>",
  "          <feColorMatrix in=\"SourceGraphic\" type=\"matrix\" result=\"brightnessMask\"",
  "            values=\"0      0      0      0 0",
  "                    0      0      0      0 0",
  "                    0      0      0      0 0",
  "                    0.3333 0.3333 0.3333 0 0\"",
  "          />",
  "          <feComponentTransfer in=\"brightnessMask\" result=\"brightnessMaskWithFloor\">",
  "            <feFuncA type=\"linear\" slope=\"0.92\" intercept=\"0.01\" />",
  "          </feComponentTransfer>",
  "          <feComposite in=\"blackWhite\" in2=\"brightnessMaskWithFloor\" operator=\"in\"",
  "            result=\"maskedOverlay\"",
  "          />",
  "          <feComponentTransfer in=\"maskedOverlay\" result=\"semiTransparent\">",
  "            <feFuncA type=\"gamma\" amplitude=\"0.12\" exponent=\"0.5\" offset=\"0\" />",
  "          </feComponentTransfer>",
  "          <feBlend in=\"semiTransparent\" in2=\"SourceGraphic\" mode=\"normal\" />",
  "        </filter>",
  "      </defs>",
  "    </svg>",
  "  ",
].join("\n");

/** A URL is another origin's http or https address, which the CSP then holds to Stripe's. */
const elsewhere = (/** @type {string} */ url) => {
  try {
    const at = new URL(url, location.href);
    return /^https?:$/.test(at.protocol) && at.origin !== location.origin;
  } catch {
    return false;
  }
};

/**
 * The page's `default` Trusted Types policy on Stripe's pages: app.rs's `stripe` allows the name,
 * so `<Corten />` makes none there, and Corten leaves Stripe's markup to the app
 * (corten-run/corten#1488). As Corten's does, it passes a script URL on another origin, so this
 * file and Stripe.js load Stripe's scripts; and it passes the one SVG filter above to `DOMParser`
 * only. Every other string, and that one at any other sink, is refused. On a page that already has
 * a `default` policy (Corten's, on payout setup) it makes none, and that one decides.
 */
const trusted = /** @type {any} */ (globalThis).trustedTypes;
if (trusted && !trusted.defaultPolicy) {
  trusted.createPolicy("default", {
    createScriptURL: (/** @type {string} */ url) => (elsewhere(url) ? url : null),
    createHTML: (/** @type {string} */ markup, /** @type {string} */ _type, /** @type {string} */ sink) =>
      sink === "DOMParser parseFromString" && markup === STRIPE_LOADER_SVG ? markup : null,
  });
}

/**
 * Connect.js's URL as a script's src (connect_surface.js). The page requires Trusted Types; on a
 * Stripe area's pages a `default` policy (this file's on the payment pages, `<Corten />`'s on payout
 * setup) lets a script, and the scripts Stripe loads itself, set a URL on another origin as a
 * script's src, and the CSP holds it to Stripe's.
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
