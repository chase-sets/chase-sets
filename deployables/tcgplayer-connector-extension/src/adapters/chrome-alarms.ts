import type { ConnectorBackgroundPorts } from "@chase-sets/channels/client";

export function chromeAlarms(): ConnectorBackgroundPorts["alarms"] {
  return {
    create: (name, schedule) => chrome.alarms.create(name, schedule),
    clear: async (name) => {
      await chrome.alarms.clear(name);
    },
    onAlarm: (listener) => {
      chrome.alarms.onAlarm.addListener(listener);
    },
  };
}
