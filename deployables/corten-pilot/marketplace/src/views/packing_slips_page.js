// @ts-check

/** @param {HTMLFormElement} form */
export function apply(form) {
  form.requestSubmit();
}

/**
 * A format choice changes presentation, not the shipment selection or its already drawn slips.
 * The GET form still works before the runtime loads and when JavaScript is disabled.
 * @param {SubmitEvent} event
 * @param {HTMLFormElement} form
 * @param {HTMLSelectElement} format
 * @param {HTMLDivElement} sheets
 */
export function choose(event, form, format, sheets) {
  event.preventDefault();
  const query = new URLSearchParams();
  new FormData(form).forEach((value, name) => {
    if (typeof value === "string") query.append(name, value);
  });
  const url = new URL(form.action);
  url.search = query.toString();
  if (url.href !== location.href) history.replaceState(history.state, "", url);
  sheets.dataset.format = format.value;
}
