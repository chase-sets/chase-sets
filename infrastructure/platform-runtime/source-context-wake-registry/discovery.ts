import { registryEntry } from "../source-context-wake-registry-entry";

export const discoveryWakeRegistryEntry = registryEntry({
  sourceContextName: "discovery",
  owner: "Discovery",
  rolloutState: "eligible",
  phase: "phase-3-expansion",
  rolloutWave: "wave-3-platform-expansion",
  priorityLane: "standard",
  expectedEventVolume: "medium",
  wakeStoreLoadEstimate: "low",
  affectedProjectionNames: ["discovery:discovery-product-alert-page-projection"],
  routeDependencyIds: [
    "discovery.item-detail-add-to-cart-semantic-handoff",
    "discovery.item-detail-add-to-sell-list-semantic-handoff",
    "discovery.item-detail-checkout-handoff",
    "discovery.item-detail-listing-publication-self-refresh",
    "discovery.item-detail-ship-from-setup-self-refresh",
  ],
});
