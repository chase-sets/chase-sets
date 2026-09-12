import { registryEntry } from "../source-context-wake-registry-entry";

export const channelsWakeRegistryEntry = registryEntry({
  sourceContextName: "channels",
  owner: "Channels",
  rolloutState: "not-eligible",
  phase: "phase-3-expansion",
  rolloutWave: "wave-4-deferred-or-not-eligible",
  priorityLane: "bulk",
  expectedEventVolume: "low",
  wakeStoreLoadEstimate: "none",
  affectedProjectionNames: [
    "channels:channel-connection-projection",
    "channels:channel-listing-desired-state-reaction",
    "channels:channel-owned-publication-state",
    "channels:platform-policy-document-projection",
    "channels:tcgplayer-csv-projection",
  ],
  routeDependencyIds: [],
});
