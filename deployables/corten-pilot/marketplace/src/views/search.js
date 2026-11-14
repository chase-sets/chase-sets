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
 * Shows a control only this script makes work (a facet's option search), drawn hidden so a page
 * without scripts has no control that does nothing.
 * @param {HTMLElement} element
 */
export function reveal(element) {
  element.hidden = false;
}

/**
 * A facet's option search changed (`MarketplaceFacetRail`'s): shows the values whose label or id
 * holds the words, with the chosen ones always in view, says so when none does, and while there
 * are words shows every match and no Show more (`data-finding`). Empty words bring the group back
 * as it was, Show more open or closed as the user left it.
 * @param {Event} event
 */
export function find(event) {
  const field = event.target;
  if (!(field instanceof HTMLInputElement)) return;
  const group = field.closest("fieldset");
  if (!group) return;
  const words = field.value.trim().toLowerCase();
  let shown = 0;
  for (const choice of group.querySelectorAll("label")) {
    const box = choice.querySelector('input[type="checkbox"]');
    if (!(box instanceof HTMLInputElement)) continue;
    const label = box.nextElementSibling?.textContent?.toLowerCase() ?? "";
    const matches = !words || label.includes(words) || box.value.toLowerCase().includes(words);
    choice.hidden = !matches && !box.checked;
    if (matches) shown += 1;
  }
  group.toggleAttribute("data-finding", words !== "");
  const none = group.querySelector("[data-none]");
  if (none instanceof HTMLElement) none.hidden = !words || shown > 0;
}

/**
 * Enter in a facet's option search finds, as typing does; it does not send the filters.
 * @param {KeyboardEvent} event
 */
export function stay(event) {
  if (event.key === "Enter") event.preventDefault();
}

/**
 * Hides the notice the button is in; the filters it names stay applied.
 * @param {HTMLButtonElement} button
 */
export function dismiss(button) {
  const notice = button.parentElement;
  if (notice) notice.hidden = true;
}
