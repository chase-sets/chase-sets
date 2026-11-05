// @ts-check
// OperatorSession (operator_session.rs): Pair's answer hands the grant to the operator extension
// once, as admin-web's `awaitOperatorExtensionHandoff` does. Only a closed {outcome:"paired"} reply
// within 15 seconds confirms it: then the grant is removed unseen and the page says it paired.
// Anything else (no extension runtime on this origin, a refusal, a malformed or late reply) shows the
// grant to paste. Nothing is sent again: an unconfirmed handoff may still have been committed.

/** The operator extension (bounded-contexts/catalog/features/operator-session/domain/extension/protocol.ts). */
const EXTENSION = "ghemdloifdkoadnapmigabiekchlholm";
/** How long the grant stays hidden before it is shown to paste. */
const WAIT_MS = 15_000;

/**
 * Whether the extension confirmed it stored the grant.
 * @param {string} grant
 * @returns {Promise<boolean>}
 */
async function send(grant) {
  try {
    /** @type {any} */
    const chrome = Reflect.get(globalThis, "chrome");
    const runtime = chrome && typeof chrome === "object" ? chrome.runtime : undefined;
    if (!runtime || typeof runtime.sendMessage !== "function") return false;
    const pending = runtime.sendMessage(EXTENSION, { action: "pair-handoff", grant });
    if (!pending || typeof pending.then !== "function") return false;
    const reply = await pending;
    return (
      typeof reply === "object" &&
      reply !== null &&
      !Array.isArray(reply) &&
      Object.keys(reply).length === 1 &&
      reply.outcome === "paired"
    );
  } catch {
    return false;
  }
}

/**
 * Hands the grant to the extension, then removes it (paired) or shows it (not confirmed).
 * @param {HTMLElement} target The grant's section, drawn `data-pending`.
 */
export async function handoff(target) {
  const box = target.parentElement;
  const grant = target.querySelector("code")?.textContent ?? "";
  /** @type {Promise<boolean>} */
  const late = new Promise((resolve) => setTimeout(() => resolve(false), WAIT_MS));
  const paired = await Promise.race([send(grant), late]);
  box?.querySelector("[data-operator-pending]")?.remove();
  if (paired) {
    target.remove();
    box?.querySelector("[data-operator-paired]")?.removeAttribute("hidden");
  } else {
    target.removeAttribute("data-pending");
  }
}
