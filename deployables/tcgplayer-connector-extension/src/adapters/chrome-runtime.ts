import type { ConnectorBackgroundPorts } from "@chase-sets/channels/client";
import { chromeListener } from "./chrome-listener";

export function chromeRuntime(): ConnectorBackgroundPorts["runtime"] {
  return {
    id: chrome.runtime.id,
    onInstalled: (listener) => {
      chrome.runtime.onInstalled.addListener(chromeListener(listener));
    },
    onStartup: (listener) => {
      chrome.runtime.onStartup.addListener(chromeListener(listener));
    },
    // No product page or command sender: the reserved commands stay test-only.
    onMessage: () => {},
  };
}
