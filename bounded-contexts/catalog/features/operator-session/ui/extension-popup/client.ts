export { createOperatorBackground } from "../../domain/extension/background";
export type { OperatorAdapters } from "../../domain/extension/background";
export {
  createOperatorSandboxCopyReport,
  createOperatorSandboxSetNamesRequest,
  installOperatorBridge,
  isCopyProbeReportMessage,
  isProbeSetNamesMessage,
} from "../../domain/extension/bridge";
export { operatorExtensionId } from "../../domain/extension/protocol";
export {
  probeTcgplayerSetNames,
  serializeSetNamesProbeReport,
  sha256SetNamesProbeReport,
  setNamesProbeUnitConstraints,
} from "../../domain/extension/set-names/probe";
export type {
  SetNamesProbeReport,
  SetNamesRequest,
  SetNamesRequestResult,
} from "../../domain/extension/set-names/probe";
export { isSetNamesRequestResult } from "../../domain/extension/set-names/probe";
import type { SetNamesRequest } from "../../domain/extension/set-names/probe";
export type { OperatorCommand, OperatorStatus, OperatorEnvironment } from "../../domain/extension/protocol";
export async function renderOperatorExtensionPopup(
  element: HTMLElement,
  bridgeOrigin: string,
  options: Readonly<{
    setNameRequest?: SetNamesRequest;
    copyProbeReport?: (text: string) => Promise<void>;
    extensionVersion?: string;
    buildCommit?: string;
    browserMajor?: string;
  }> = {},
) {
  const popup = await import("./popup");
  return popup.renderOperatorExtensionPopup(element, bridgeOrigin, options);
}
