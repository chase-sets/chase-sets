import {
  createOperatorSandboxCopyReport,
  createOperatorSandboxSetNamesRequest,
  renderOperatorExtensionPopup,
} from "@chase-sets/catalog/client";
import "@chase-sets/design-system/styles.css";
import { operatorExtensionId } from "./manifest-contract";
import { operatorManifest } from "./manifest-contract";

const root = document.getElementById("root");
if (root)
  renderOperatorExtensionPopup(root, `chrome-extension://${operatorExtensionId}`, {
    setNameRequest: createOperatorSandboxSetNamesRequest(window, `chrome-extension://${operatorExtensionId}`),
    copyProbeReport: createOperatorSandboxCopyReport(window, `chrome-extension://${operatorExtensionId}`),
    extensionVersion: operatorManifest.version,
    buildCommit: import.meta.env.VITE_BUILD_COMMIT ?? "unknown",
    browserMajor: navigator.userAgent.match(/(?:Chrome|Chromium)\/(\d+)/)?.[1] ?? "unknown",
  });
