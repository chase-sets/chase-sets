// @ts-check
// The search page's filters. Every choice is in one GET form, which works without this script;
// with it, a choice applies as soon as it changes, as marketplace's do. The form is marked
// data-keep-place, so the navigation keeps the page's scroll position, the rail's own scroll, the
// groups the user unfolded and the focus on the field.

/** @import { ElementId } from "corten" */

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
 * @param {FormDataEvent} event
 */
export function tidy(event) {
  const data = event.formData;
  for (const [key, value] of Array.from(data.entries())) {
    if (value === "" || (key === "sort" && value === "relevance")) data.delete(key);
  }
}

/**
 * A sheet's trigger is being sent (Add to List, Add matching products to Buy Cart): a sheet the
 * user closed becomes an empty hidden element of its id, so the answer, which draws it open,
 * opens it. Otherwise the patch keeps the dialog closed as the user left it
 * (a Corten gap, in the README's open workarounds); remove this once a patch the user asked for
 * opens what it draws open.
 * @param {ElementId} id
 */
export function fresh(id) {
  const sheet = document.getElementById(id);
  if (!(sheet instanceof HTMLDialogElement) || sheet.open) return;
  const empty = document.createElement("div");
  empty.id = id;
  empty.hidden = true;
  sheet.replaceWith(empty);
}

/**
 * Hides the notice the button is in; the filters it names stay applied.
 * @param {HTMLButtonElement} button
 */
export function dismiss(button) {
  const notice = button.parentElement;
  if (notice) notice.hidden = true;
}
