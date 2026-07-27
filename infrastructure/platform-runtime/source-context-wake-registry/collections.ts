import { registryEntry } from "../source-context-wake-registry-entry";

export const collectionsWakeRegistryEntry = registryEntry({
  sourceContextName: "collections",
  owner: "Collections",
  rolloutState: "not-eligible",
  phase: "phase-3-expansion",
  rolloutWave: "wave-4-deferred-or-not-eligible",
  priorityLane: "standard",
  expectedEventVolume: "medium",
  wakeStoreLoadEstimate: "medium",
  affectedProjectionNames: [
    "collections:collections-saved-list-projection",
    "collections:collections-saved-list-picker-projection",
    "collections:collections-saved-list-valuation-projection",
    "collections:collections.saved-list-shared-page-projection",
    "discovery:discovery-saved-list-picker-projection",
  ],
  routeDependencyIds: [
    "collections.saved-list-bulk-to-detail",
    "collections.saved-list-create-to-detail",
    "collections.saved-list-detail-self-refresh",
    "collections.saved-list-list-self-refresh",
  ],
});
