import type { ConnectorBackgroundPorts } from "@chase-sets/channels/client";

export function chromeStorage(): ConnectorBackgroundPorts["storage"] {
  return {
    setAccessLevel: (options) => chrome.storage.local.setAccessLevel(options),
    get: (keys) => chrome.storage.local.get([...keys]),
    set: (values) => chrome.storage.local.set(values),
    remove: (keys) => chrome.storage.local.remove([...keys]),
  };
}
