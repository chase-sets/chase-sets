import type { ConnectorBackgroundPorts } from "@chase-sets/channels/client";

export function chromeAlarms(): ConnectorBackgroundPorts["alarms"] {
  return {
    get: (name) => chrome.alarms.get(name),
    create: (name, schedule) => chrome.alarms.create(name, schedule),
    clear: async (name) => {
      await chrome.alarms.clear(name);
    },
    onAlarm: (listener) => {
      chrome.alarms.onAlarm.addListener(listener);
    },
  };
}
