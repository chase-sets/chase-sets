// @ts-check
// The seller's list of listings (seller_listings_page.rs). Every form works without this script.
// With it, the bulk bar counts the checked listings.
/** @import { Message } from "corten" */

/**
 * How many listings are checked, in the bar, and on the form (`data-picked`, which shows the bar).
 * @param {HTMLFormElement} form @param {HTMLOutputElement} count @param {Message<"count">} selected
 */
export function picked(form, count, selected) {
  const n = form.querySelectorAll('input[name="listingIds"]:checked').length;
  count.value = n === 0 ? "" : selected({ count: n });
  form.setAttribute("data-picked", String(n));
}

/**
 * Clear selection reset the form: count again once it has.
 * @param {HTMLFormElement} form @param {HTMLOutputElement} count @param {Message<"count">} selected
 */
export function cleared(form, count, selected) {
  setTimeout(() => picked(form, count, selected));
}
