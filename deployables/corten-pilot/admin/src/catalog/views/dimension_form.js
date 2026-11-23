// @ts-check
// DimensionForm (dialog.rs): Or better is offered only for an ordered or numeric value kind, and
// choosing Unordered chooses Exact, as admin-web's dimension dialogs do.

/**
 * @param {HTMLSelectElement} kind The value kind.
 * @param {HTMLSelectElement} choice The Option Matching.
 */
export function matching(kind, choice) {
  const unordered = kind.value === "unordered";
  const better = choice.querySelector('option[value="or-better"]');
  if (better instanceof HTMLOptionElement) better.disabled = unordered;
  if (unordered) choice.value = "exact";
}
