export { createOperatorBackground } from "../../domain/extension/background";
export type { OperatorAdapters } from "../../domain/extension/background";
export { installOperatorBridge } from "../../domain/extension/bridge";
export { operatorExtensionId } from "../../domain/extension/protocol";
export {
  probeTcgplayerSetNames,
  serializeSetNamesProbeReport,
  sha256SetNamesProbeReport,
  tcgplayerSingleCardUnitConstraints,
} from "../../domain/extension/set-names/probe";
export type {
  SetNamesProbeReport,
  SetNamesRequest,
  SetNamesRequestResult,
} from "../../domain/extension/set-names/probe";
import type { SetNamesRequest } from "../../domain/extension/set-names/probe";
export type { OperatorCommand, OperatorStatus, OperatorEnvironment } from "../../domain/extension/protocol";
export async function renderOperatorExtensionPopup(
  element: HTMLElement,
  bridgeOrigin: string,
  options: Readonly<{
    setNameRequest?: SetNamesRequest;
    extensionVersion?: string;
    buildCommit?: string;
    browserMajor?: string;
  }> = {},
) {
  const popup = await import("./popup");
  return popup.renderOperatorExtensionPopup(element, bridgeOrigin, options);
}
