// @ts-check
// Create listing's form. Every step before the write is a GET of the page with the form's fields,
// which works without this script; with it, a changed option or inventory item draws the form's
// parts at once, and the catalog search finds matches as the seller types. The form is a
// data-patch form, so those GETs answer its parts in place and the photo input keeps its files.

/**
 * A select that changes what the form shows (an item's option, the inventory item): draw again.
 * @param {Event} event
 */
export function redraw(event) {
  const field = event.target;
  if (!(field instanceof HTMLSelectElement) || !field.hasAttribute("data-redraw") || !field.form) return;
  const button = field.form.querySelector('button[name="redraw"]');
  if (button instanceof HTMLButtonElement) field.form.requestSubmit(button);
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let typing;

// A match chosen (or any other submit) before typing settles: the search it would send would
// answer after the choice and draw the matches over it.
document.addEventListener("submit", () => clearTimeout(typing), true);

/**
 * Words typed in the catalog search: find matches once typing settles, from two characters (or a
 * pasted catalog id), as marketplace's picker does.
 * @param {Event} event
 */
export function find(event) {
  const field = event.target;
  if (!(field instanceof HTMLInputElement) || !field.hasAttribute("data-find") || !field.form) return;
  clearTimeout(typing);
  if (field.value.trim().length < 2) return;
  const form = field.form;
  typing = setTimeout(() => {
    const button = form.querySelector("button[data-find]");
    if (button instanceof HTMLButtonElement && field.isConnected) form.requestSubmit(button);
  }, 250);
}
