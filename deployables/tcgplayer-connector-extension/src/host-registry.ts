import type { buildConnectorManifest } from "@chase-sets/channels/client";

export const connectorHostRegistry: Parameters<typeof buildConnectorManifest>[0]["hostRegistry"] = [
  {
    origin: "https://store.tcgplayer.com",
    capture: "https://github.com/chase-sets/chase-sets/issues/7924#issuecomment-5647783852",
  },
];
