// @ts-check
// TermsPage (terms_page.rs): Create account override re-reads its starting terms when its account
// changes, as Review does without JavaScript.

/**
 * Submits the account's form, which opens the sheet again on that account.
 * @param {HTMLSelectElement} target The account select.
 */
export function prefill(target) {
  target.form?.requestSubmit();
}
