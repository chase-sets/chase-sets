// @ts-check
// The checkout form. Pay now works without this script: it writes the review again first when a
// field changed since the totals were drawn. With it, the page says so as soon as a delivery,
// shipping or payment field changes: it marks the page, whose stylesheet then shows "Totals need
// refresh" and Update totals in place of Pay now (marketplace's markReviewStale). The contact
// email does not change the totals.

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
