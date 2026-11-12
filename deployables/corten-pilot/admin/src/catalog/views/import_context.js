// @ts-check
// ImportContext (import_context.rs): the context form works as a plain GET without this script.
// With it, a changed select clears what depends on it and sends the form, as admin-web's selects
// do, and each scope level's name goes with it.

/** @param {HTMLFormElement} form @param {string} name */
function control(form, name) {
  const el = form.elements.namedItem(name);
  return el instanceof HTMLSelectElement || el instanceof HTMLInputElement ? el : null;
}

/** Clears a field and keeps it out of the request. @param {HTMLFormElement} form @param {string} name */
function clear(form, name) {
  const el = control(form, name);
  if (!el) return;
  el.value = "";
  el.disabled = true;
}

/** The guided scope selects, in order. @param {HTMLFormElement} form */
function levels(form) {
  return /** @type {HTMLSelectElement[]} */ (Array.from(form.querySelectorAll("select[data-guided]")));
}

/**
 * A select changed: the provider or the unit clears what it names in `data-clears`; a scope level
 * fills in the parents its option names and clears the levels below. Then the form is sent.
 * @param {Event} event
 */
export function changed(event) {
  const select = event.target;
  if (!(select instanceof HTMLSelectElement) || !select.form) return;
  const form = select.form;
  const clears = select.dataset.clears;
  if (clears) {
    for (const name of clears.split(" ")) clear(form, name);
  } else if (select.dataset.guided !== undefined) {
    const all = levels(form);
    const at = all.indexOf(select);
    let parent = select.selectedOptions[0]?.dataset.parent ?? "";
    for (let i = at - 1; i >= 0 && parent; i -= 1) {
      const above = all[i];
      if (Array.from(above.options).some((o) => o.value === parent)) above.value = parent;
      parent = above.selectedOptions[0]?.dataset.parent ?? "";
    }
    for (const below of all.slice(at + 1)) {
      clear(form, below.name);
      if (below.dataset.labelField) clear(form, below.dataset.labelField);
    }
  } else {
    return;
  }
  form.requestSubmit();
}

/**
 * The form is being sent: each chosen scope level's name goes with it.
 * @param {Event} event
 */
export function submitted(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  for (const select of levels(form)) {
    const name = select.dataset.labelField;
    const field = name ? form.querySelector(`input[data-label-for="${select.name}"]`) : null;
    if (!(field instanceof HTMLInputElement) || select.disabled || !select.value) continue;
    field.value = select.selectedOptions[0]?.textContent?.trim() ?? "";
    field.disabled = false;
  }
}
