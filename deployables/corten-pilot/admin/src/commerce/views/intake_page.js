// @ts-check
// IntakePage (intake_page.rs): says when the station is offline and prints the custody label.
// Every form is a plain post or get; offline, the station marks itself (the pills are CSS on
// data-offline) and turns its submits off, as admin-web does, and back on when it reconnects.

/** The submits this script turned off, so it turns back on only those. */
const OFF = "data-offline-off";

/**
 * Follows the browser's connection: on connect, and on each online and offline event until the
 * station leaves the page.
 * @param {HTMLElement} target The station.
 * @param {AbortSignal} signal
 */
export function watch(target, signal) {
  const set = () => {
    const offline = !navigator.onLine;
    target.toggleAttribute("data-offline", offline);
    for (const button of target.querySelectorAll('button[type="submit"]')) {
      if (!(button instanceof HTMLButtonElement)) continue;
      if (offline && !button.disabled) {
        button.disabled = true;
        button.setAttribute(OFF, "");
      } else if (!offline && button.hasAttribute(OFF)) {
        button.disabled = false;
        button.removeAttribute(OFF);
      }
    }
  };
  set();
  window.addEventListener("online", set, { signal });
  window.addEventListener("offline", set, { signal });
}

/**
 * Shows a control that needs the script (Print), hidden in the markup.
 * @param {HTMLElement} target
 */
export function reveal(target) {
  target.hidden = false;
}

/** Prints the page (the custody label: the print stylesheet keeps only the scanned package). */
export function print() {
  window.print();
}
