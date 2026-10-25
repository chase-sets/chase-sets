// @ts-check
// BulkRows (bulk_rows.rs): which rows a bulk change takes. The rows' boxes and the select-all box
// belong to the bulk form (`form=`), so the form posts the checked ids and Clear Selection resets
// them without this script. With it, the count, the select-all box and the buttons follow the
// boxes, as admin-web's bulk bar does.

/**
 * What the handlers read and update. The markup builds it once,
 * `js::Selection { form, count, labels, preview, clear }`.
 * @typedef {object} Selection
 * @property {HTMLFormElement} form The bulk form; every box belongs to it.
 * @property {HTMLOutputElement} count
 * @property {HTMLTemplateElement} labels The count's text for 0, 1, 2 ... rows, drawn by the server.
 * @property {HTMLButtonElement} preview Preview: the checked rows, so none checked is nothing to preview.
 * @property {HTMLButtonElement} clear
 */

/** The rows' boxes. @param {Selection} sel */
function boxes(sel) {
  const ids = sel.form.elements.namedItem("ids");
  const list = ids instanceof RadioNodeList ? Array.from(ids) : ids ? [ids] : [];
  return /** @type {HTMLInputElement[]} */ (list.filter((box) => box instanceof HTMLInputElement));
}

/** The select-all box, when the rows have one. @param {Selection} sel */
function all(sel) {
  const box = sel.form.elements.namedItem("all");
  return box instanceof HTMLInputElement ? box : null;
}

/**
 * A box changed: the select-all box checks or clears every row.
 * @param {Event} event @param {Selection} sel
 */
export function changed(event, sel) {
  const box = all(sel);
  if (box && event.target === box) for (const row of boxes(sel)) row.checked = box.checked;
  tally(sel);
}

/**
 * Clear Selection clears the rows' boxes, and only them (a reset would also put the action back).
 * @param {Event} event @param {Selection} sel
 */
export function cleared(event, sel) {
  if (event.target !== sel.form) return;
  event.preventDefault();
  for (const row of boxes(sel)) row.checked = false;
  tally(sel);
}

/**
 * The count, the select-all box (checked when every row is, mixed when some are) and the
 * buttons, for the boxes checked now. Runs when the rows are drawn, and again on each change.
 * @param {Selection} sel
 */
export function tally(sel) {
  const rows = boxes(sel);
  const n = rows.filter((row) => row.checked).length;
  const texts = sel.labels.content.children;
  sel.count.value = texts[Math.min(n, texts.length - 1)]?.textContent ?? "";
  const box = all(sel);
  if (box) {
    box.hidden = rows.length === 0;
    box.checked = n > 0 && n === rows.length;
    box.indeterminate = n > 0 && n < rows.length;
  }
  sel.preview.disabled = n === 0;
  sel.clear.hidden = n === 0;
}
