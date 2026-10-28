// @ts-check

/**
 * A control only this script can work (Copy): shown when it runs.
 * @param {HTMLElement} element
 */
export function reveal(element) {
  element.hidden = false;
}

/**
 * Copy the button's `data-value` and say so on the button for a moment.
 *
 * @param {HTMLButtonElement} button
 * @param {string} copied
 */
export async function copy(button, copied) {
  const value = button.dataset.value ?? "";
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    return;
  }
  const before = button.textContent;
  button.textContent = copied;
  setTimeout(() => {
    button.textContent = before;
  }, 2000);
}
