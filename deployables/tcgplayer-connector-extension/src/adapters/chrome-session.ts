import type { ConnectorBackgroundPorts } from "@chase-sets/channels/client";

export function chromeSession(): ConnectorBackgroundPorts["session"] {
  return {
    setAccessLevel: (options) => chrome.storage.session.setAccessLevel(options),
    get: (keys) => chrome.storage.session.get([...keys]),
    set: (values) => chrome.storage.session.set(values),
    remove: (keys) => chrome.storage.session.remove([...keys]),
  };
}
