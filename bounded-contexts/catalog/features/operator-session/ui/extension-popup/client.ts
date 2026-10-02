export { createOperatorBackground } from "../../domain/extension/background";
export type { OperatorAdapters } from "../../domain/extension/background";
export { installOperatorBridge } from "../../domain/extension/bridge";
export { operatorCookieName, operatorCookieUrl } from "../../domain/extension/protocol";
export type { OperatorCommand, OperatorStatus, OperatorEnvironment } from "../../domain/extension/protocol";
export async function renderOperatorExtensionPopup(element: HTMLElement, bridgeOrigin: string) {
  const popup = await import("./popup");
  return popup.renderOperatorExtensionPopup(element, bridgeOrigin);
}
