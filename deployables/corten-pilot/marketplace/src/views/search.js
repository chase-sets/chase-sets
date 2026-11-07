// @ts-check
// The search page's filters. Every choice is in one GET form, which works without this script;
// with it, a choice applies as soon as it changes, as marketplace's do. The form is marked
// data-keep-place, so the navigation keeps the page's scroll position, the rail's own scroll, the
// groups the user unfolded and the focus on the field.

/**
 * A choice changed: send its form. The words box waits for Enter or its button, and a choice in
 * the filters dialog (a phone) waits for Show results, as the dialog would close.
 * @param {Event} event
 */
export function apply(event) {
  const field = event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) return;
  const form = field.form;
  if (!form || field.type === "search" || field.closest("dialog:modal")) return;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  form.requestSubmit();
}

/**
 * The form is being sent: leave out the fields that ask for nothing (an empty price, any
 * language, relevance), so the address is the one the page's links write.
 * Workaround (corten-run/corten#1072): Corten checks a formdata listener's event only as an
 * `Event`, so the handler takes that and reads it as the `FormDataEvent` it is.
 * @param {Event} event
 */
export function tidy(event) {
  const data = /** @type {FormDataEvent} */ (event).formData;
  for (const [key, value] of Array.from(data.entries())) {
    if (value === "" || (key === "sort" && value === "relevance")) data.delete(key);
  }
}

/**
 * Hides the notice the button is in; the filters it names stay applied.
 * @param {HTMLButtonElement} button
 */
export function dismiss(button) {
  const notice = button.parentElement;
  if (notice) notice.hidden = true;
}
