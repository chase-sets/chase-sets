// @ts-check
// Stripe.js and the page's theme in Stripe's terms, for the two secure steps: a payment's
// (payment_entry.js) and a saved payment method's setup (payment_setup.js), and Connect's
// appearance for payout setup (connect_surface.js). Stripe.js loads from
// Stripe (as @stripe/stripe-js 9.9.0's loadStripe loads it), once per page load.

/** Stripe.js for @stripe/stripe-js 9.9.0's release train. */
const STRIPE_JS = "https://js.stripe.com/dahlia/stripe.js";

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

/**
 * A theme token's computed value (a color as rgb(), a length in px), since Stripe cannot read
 * custom properties or light-dark().
 * @param {HTMLElement} inside @param {string} property @param {string} token @param {string} fallback
 */
function computed(inside, property, token, fallback) {
  const probe = document.createElement("span");
  probe.hidden = true;
  probe.style.setProperty(property, `var(${token})`);
  inside.append(probe);
  const value = getComputedStyle(probe).getPropertyValue(property).trim();
  probe.remove();
  return value || fallback;
}

/**
 * Stripe Connect's appearance from the page's theme (marketplace's createStripeConnectAppearance,
 * its colors, radius and button weight).
 * @param {HTMLElement} inside
 */
export function connectAppearance(inside) {
  const color = (/** @type {string} */ token, /** @type {string} */ fallback) =>
    computed(inside, "color", token, fallback);
  const primary = color("--color-primary", "#4845c6");
  return {
    overlays: "dialog",
    variables: {
      colorPrimary: primary,
      colorBackground: color("--color-surface", "#ffffff"),
      colorText: color("--color-text", "#211d33"),
      colorSecondaryText: color("--color-text-secondary", "#4d4763"),
      colorBorder: color("--color-border", "#e6e2d9"),
      colorDanger: color("--color-danger", "#b91c1c"),
      buttonPrimaryColorBackground: primary,
      buttonPrimaryColorBorder: primary,
      buttonPrimaryColorText: color("--color-primary-foreground", "#ffffff"),
      buttonLabelFontWeight: "600",
      borderRadius: computed(inside, "border-top-left-radius", "--radius-md", "8px"),
    },
  };
}

/**
 * Stripe's appearance from the page's theme (marketplace's createStripeElementsAppearance, its
 * variables).
 * @param {HTMLElement} inside
 */
export function appearance(inside) {
  const color = (/** @type {string} */ token, /** @type {string} */ fallback) =>
    computed(inside, "color", token, fallback);
  return {
    theme: "flat",
    variables: {
      borderRadius: computed(inside, "border-top-left-radius", "--radius-md", "8px"),
      colorBackground: color("--color-surface", "#ffffff"),
      colorDanger: color("--color-danger", "#b91c1c"),
      colorPrimary: color("--color-primary", "#4845c6"),
      colorSuccess: color("--color-success", "#15803d"),
      colorText: color("--color-text", "#211d33"),
      colorTextSecondary: color("--color-text-secondary", "#4d4763"),
      colorTextPlaceholder: color("--color-text-secondary", "#4d4763"),
      colorWarning: color("--color-warning", "#b45309"),
      fontWeightMedium: "600",
      fontWeightNormal: "400",
    },
  };
}
