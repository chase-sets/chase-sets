// @ts-check
// The search page's filters. Every choice is in one GET form, which works without this script;
// with it, a choice applies as soon as it changes, as marketplace's do. The form is marked
// data-keep-place, so the navigation keeps the page's scroll position and the focus on the field.
// It does not keep the rail's own scroll (todd-skelton/corten#96) or the groups the user
// unfolded (todd-skelton/corten#97): `apply` notes both and `restore` puts them back
// when the new page joins, before the runtime puts focus back.

/** @type {{ rail: number, open: string[] } | null} */
let kept = null;

/**
 * A filter group's name: the field its controls send, else its place among the groups.
 * @param {HTMLDetailsElement} group
 * @param {number} index
 */
const groupName = (group, index) => group.querySelector("input[name]")?.getAttribute("name") ?? `#${index}`;

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
  const rail = form.closest("dialog");
  if (rail) {
    const groups = Array.from(rail.querySelectorAll("details"));
    const open = groups.flatMap((group, index) => (group.open || group.contains(field) ? [groupName(group, index)] : []));
    kept = { rail: rail.scrollTop, open };
  }
  form.requestSubmit();
}

/**
 * The page joined after a filter applied: unfold the groups that were open, and scroll the rail
 * back to where it was.
 * @param {HTMLElement} page
 */
export function restore(page) {
  const place = kept;
  kept = null;
  const rail = page.querySelector("dialog");
  if (!place || !rail) return;
  Array.from(rail.querySelectorAll("details")).forEach((group, index) => {
    if (place.open.includes(groupName(group, index))) group.open = true;
  });
  rail.scrollTop = place.rail;
}

/**
 * The form is being sent: leave out the fields that ask for nothing (an empty price, any
 * language, relevance), so the address is the one the page's links write.
 * @param {FormDataEvent} event
 */
export function tidy(event) {
  for (const [key, value] of Array.from(event.formData.entries())) {
    if (value === "" || (key === "sort" && value === "relevance")) event.formData.delete(key);
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
