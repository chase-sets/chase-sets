// @ts-check
// TermsPage (terms_page.rs): Create account override re-reads its starting terms when its account
// changes, as Review does without JavaScript.

/**
 * Submits the save form with its Review button, which opens the sheet again on the chosen account.
 * @param {HTMLSelectElement} target The account select.
 */
export function prefill(target) {
  const review = target.form?.querySelector('button[name="review"]');
  if (review instanceof HTMLButtonElement) target.form?.requestSubmit(review);
}
