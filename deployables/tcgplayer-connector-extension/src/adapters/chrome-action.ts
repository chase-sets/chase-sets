import type { ConnectorBackgroundPorts, ConnectorStatus } from "@chase-sets/channels/client";

const badges = {
  unpaired: "",
  "pairing-pending": "...",
  "paired-idle": "ON",
  paused: "II",
  unpairing: "...",
  revoked: "!",
  "cleanup-pending": "!",
  "re-pair-required": "!",
  "upgrade-required": "!",
} satisfies Record<ConnectorStatus["state"], string>;

export function chromeAction(): ConnectorBackgroundPorts["action"] {
  return {
    onClicked: (listener) => {
      chrome.action.onClicked.addListener(listener);
    },
    setBadge: ({ state }) => chrome.action.setBadgeText({ text: badges[state] }),
    setTitle: ({ state }) => chrome.action.setTitle({ title: state }),
    openPage: async (url) => {
      await chrome.tabs.create({ url });
    },
  };
}
