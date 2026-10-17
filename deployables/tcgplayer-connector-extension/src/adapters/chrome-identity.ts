import type { ConnectorBackgroundPorts } from "@chase-sets/channels/client";

export function chromeIdentity(): ConnectorBackgroundPorts["identity"] {
  return {
    async launchWebAuthFlow(details) {
      const callback = await chrome.identity.launchWebAuthFlow(details);
      if (!callback) throw new Error("connector-identity-callback-missing");
      return callback;
    },
  };
}
