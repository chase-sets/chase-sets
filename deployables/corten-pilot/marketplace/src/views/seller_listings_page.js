// @ts-check
// The seller's list of listings (seller_listings_page.rs). Every form works without this script.
// With it, a picked date is sent with its instant where the seller is, which the server cannot
// know (todd-skelton/corten#149), and the bulk bar counts the checked listings.
/** @import { Message } from "corten" */

/**
 * The start of a picked day (`YYYY-MM-DD`) on the browser's clock, as an instant: marketplace's
 * `localDateInputToInstant`. Empty for no date.
 * @param {string} value
 */
function startOfDay(value) {
  if (!value) return "";
  const midnight = new Date(`${value}T00:00:00`);
  return Number.isNaN(midnight.valueOf()) ? "" : midnight.toISOString();
}

/**
 * A form with dates is sent: each date field marked `data-instant` adds that field with its
 * day's start, so the server takes the instant as it is.
 * @param {FormDataEvent} event
 */
export function instants(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  for (const field of Array.from(form.querySelectorAll("input[type=date][data-instant]"))) {
    if (!(field instanceof HTMLInputElement)) continue;
    const name = field.getAttribute("data-instant");
    if (name) event.formData.set(name, startOfDay(field.value));
  }
}

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
