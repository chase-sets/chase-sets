// @ts-check
// The search page's filters. Every choice is in one GET form, which works without this script;
// with it, a choice applies as soon as it changes, as marketplace's do. The navigation that
// follows swaps the page, which puts focus on the body and scrolls to the top, so the page keeps
// the field that changed and the scroll position, and puts them back when it joins the page
// again (todd-skelton/corten#92).

const KEY = "corten-pilot:search-place";

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
  try {
    // The rail scrolls by itself from 64rem, so its own position is kept too.
    const rail = field.closest("dialog")?.scrollTop ?? 0;
    const place = { name: field.name, value: field.value, y: window.scrollY, rail };
    window.sessionStorage.setItem(KEY, JSON.stringify(place));
  } catch {
    // Without storage the page still applies the choice, from the top.
  }
  form.requestSubmit();
}

/**
 * The page joined: put back the field that changed and the scroll position, once the
 * navigation has finished moving them.
 * @param {HTMLElement} page
 */
export function restore(page) {
  /** @type {{ name: string, value: string, y: number, rail: number } | null} */
  let place = null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    place = raw ? JSON.parse(raw) : null;
  } catch {
    return;
  }
  if (!place) return;
  const { name, value, y, rail } = place;
  setTimeout(() => {
    window.scrollTo({ top: y, left: 0, behavior: "instant" });
    for (const field of Array.from(page.ownerDocument.querySelectorAll("input, select"))) {
      if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement) || field.name !== name) continue;
      if (field instanceof HTMLInputElement && /^(checkbox|radio)$/.test(field.type) && field.value !== value) continue;
      field.closest("details")?.setAttribute("open", "");
      const dialog = field.closest("dialog");
      if (dialog) dialog.scrollTop = rail;
      field.focus({ preventScroll: true });
      return;
    }
  }, 0);
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
