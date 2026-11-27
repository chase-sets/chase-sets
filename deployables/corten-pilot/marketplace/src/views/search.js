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
 * @param {ElementId} formId
 */
export function apply(event, formId) {
  const field = event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) return;
  const form = field.form;
  if (!form || form.id !== formId || field.type === "search" || field.closest("dialog:modal")) return;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  form.requestSubmit();
}

/**
 * Let Corten keep focus on Sort except when the submitted fields would return to the
 * landing, which has no Sort control. The outer change handler still sends the form.
 * @param {HTMLSelectElement} sort
 * @param {boolean} canLand
 * @param {string} relevance
 * @param {ElementId} fallback
 */
export function sortPlace(sort, canLand, relevance, fallback) {
  if (!canLand || sort.value !== relevance || document.activeElement !== sort || !sort.form) return;
  for (const [name, value] of new FormData(sort.form)) {
    if (name !== sort.name && typeof value === "string" && value.trim() !== "") return;
  }
  document.getElementById(fallback)?.focus({ preventScroll: true });
}

/**
 * A refinement link's default activation still navigates. Hand focus to a control that
 * survives when the link disappears, so Corten can keep it along with scroll.
 * @param {PointerEvent} event
 * @param {HTMLAnchorElement} link
 * @param {ElementId} fallback
 */
export function refine(event, link, fallback) {
  if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return;
  const dialog = link.closest("dialog:modal");
  if (dialog instanceof HTMLDialogElement) dialog.close();
  document.getElementById(fallback)?.focus({ preventScroll: true });
}

/**
 * The desktop rail's clear link persists; on mobile it is going away with the dialog.
 * @param {PointerEvent} event
 * @param {HTMLAnchorElement} link
 * @param {ElementId} fallback
 */
export function clearRail(event, link, fallback) {
  if (link.closest("dialog:modal")) refine(event, link, fallback);
}

/**
 * Close a mobile filter dialog only after a valid submission. Keep focus on its opener;
 * the search form's normal GET and Corten's place restoration then take over.
 * @param {SubmitEvent} event
 * @param {HTMLFormElement} form
 * @param {ElementId} trigger
 */
export function closeFilters(event, form, trigger) {
  if (event.defaultPrevented) return;
  const dialog = form.closest("dialog:modal");
  if (!(dialog instanceof HTMLDialogElement)) return;
  dialog.close();
  document.getElementById(trigger)?.focus({ preventScroll: true });
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
 * Load more sends itself once the reader is within 900px of it (marketplace's
 * `AUTO_LOAD_ROOT_MARGIN`), so the results keep coming as the page scrolls. The patch that adds
 * the rows draws the form again for the page after, which connects and waits again; a form drawn
 * after a failed load is not watched, so it waits for its button, as marketplace's does.
 * @param {HTMLFormElement} form
 * @param {AbortSignal} signal
 */
export function near(form, signal) {
  if (form.hidden) return;
  const watch = new IntersectionObserver(
    (seen) => {
      if (!seen.some((entry) => entry.isIntersecting)) return;
      watch.disconnect();
      form.requestSubmit();
    },
    { rootMargin: "900px" },
  );
  watch.observe(form);
  signal.addEventListener("abort", () => watch.disconnect(), { once: true });
}

/**
 * Load more's patch added rows: put `address`, the address that draws every row the page now
 * shows (`more=`), in place of the history entry's, so Back from an item and a reload draw them
 * again, as corten-ui's tabs keep their place. The patch leaves the address it was sent from
 * (corten-run/corten#1406). Then watch for the next page, as `near` does.
 * @param {HTMLFormElement} form
 * @param {AbortSignal} signal
 * @param {string} address
 */
export function grown(form, signal, address) {
  if (location.pathname + location.search !== address) history.replaceState(history.state, "", address);
  near(form, signal);
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
