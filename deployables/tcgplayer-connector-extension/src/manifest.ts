import { TCGPLAYER_CONNECTOR_EXTENSION_KEY } from "@chase-sets/channels/client";
import { createProbeManifestForKey, type ProbeManifest } from "./manifest-contract";

export { type ProbeManifest };

export function createProbeManifest(): ProbeManifest {
  return createProbeManifestForKey(TCGPLAYER_CONNECTOR_EXTENSION_KEY);
}
