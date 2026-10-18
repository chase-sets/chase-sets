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
    onMessage: (listener) => {
      if (import.meta.env.VITE_CONNECTOR_DRILL !== "true") return;
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        void listener(message, { id: sender.id, origin: sender.origin }).then(sendResponse);
        return true;
      });
    },
  };
}
