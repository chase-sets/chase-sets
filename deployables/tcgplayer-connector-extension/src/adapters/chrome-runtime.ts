import type { ConnectorBackgroundPorts } from "@chase-sets/channels/client";

export function chromeRuntime(): ConnectorBackgroundPorts["runtime"] {
  return {
    id: chrome.runtime.id,
    onInstalled: (listener) => {
      chrome.runtime.onInstalled.addListener(listener);
    },
    onStartup: (listener) => {
      chrome.runtime.onStartup.addListener(listener);
    },
    // No product page or command sender: the reserved commands stay test-only.
    onMessage: () => {},
  };
}
