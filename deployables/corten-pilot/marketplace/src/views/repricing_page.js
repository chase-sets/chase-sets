// @ts-check
// The repricing editor. Its controls are one GET form whose Apply reads the page for them (Preview
// and Activate post), which works without this script; with it,
// a choice (a select, a box, a number) applies as soon as it changes, as marketplace's editor
// does. A text field waits for Apply or Enter. The form is marked data-keep-place, so the
// navigation keeps the page's scroll position and the focus on the control.

/**
 * A choice changed: send its form. The page then says whether its dry run still previews it.
 * @param {Event} event
 */
export function apply(event) {
  const field = event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) return;
  const form = field.form;
  if (!form || (field instanceof HTMLInputElement && field.type === "text")) return;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  // Apply, which reads the page for the form (Preview and Activate post).
  const apply = form.querySelector("button[data-repricing-apply]");
  if (apply instanceof HTMLButtonElement) form.requestSubmit(apply);
}
