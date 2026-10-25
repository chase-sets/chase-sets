import { renderOperatorExtensionPopup } from "@chase-sets/catalog/client";
import "@chase-sets/design-system/styles.css";
import { operatorExtensionId } from "./manifest-contract";
import { requestTcgplayerSetNames } from "./tcgplayer-set-name-endpoint";

const root = document.getElementById("root");
if (root)
  renderOperatorExtensionPopup(root, `chrome-extension://${operatorExtensionId}`, {
    setNameRequest: (productLineId) => requestTcgplayerSetNames(productLineId),
    extensionVersion: "0.1.0",
    buildCommit: import.meta.env.VITE_BUILD_COMMIT ?? "unknown",
    browserMajor: navigator.userAgent.match(/(?:Chrome|Chromium)\/(\d+)/)?.[1] ?? "unknown",
  });
