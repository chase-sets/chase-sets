// @ts-check
// A cart line's quantity: the kit's NumberField, stepped or typed, is sent as soon as it changes,
// as marketplace's QuantityStepper writes on each change. The form is data-patch, so a change made
// while a write is out waits, and goes as one write of where the buyer ended once it is answered.
// Without this script the field's form has its own Update quantity button.

/**
 * The quantity changed: send its form, or say why the browser will not.
 * @param {Event} event
 */
export function commit(event) {
  const field = event.target;
  if (!(field instanceof HTMLInputElement) || field.type !== "number") return;
  const form = field.form;
  if (!form) return;
  if (!field.checkValidity()) {
    field.reportValidity();
    return;
  }
  form.requestSubmit();
}
