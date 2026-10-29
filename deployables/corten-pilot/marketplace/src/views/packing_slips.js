// @ts-check

/**
 * Print: shown only with this script, which is what prints.
 * @param {HTMLButtonElement} button
 */
export function reveal(button) {
  button.hidden = false;
}

/** The browser's print dialog; the page's print styles leave only the slips. */
export function print() {
  window.print();
}
