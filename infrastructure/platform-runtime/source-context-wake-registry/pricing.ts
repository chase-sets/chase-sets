import { registryEntry } from "../source-context-wake-registry-entry";

export const pricingWakeRegistryEntry = registryEntry({
  sourceContextName: "pricing",
  owner: "Pricing",
  rolloutState: "not-eligible",
  phase: "phase-3-expansion",
  rolloutWave: "wave-4-deferred-or-not-eligible",
  priorityLane: "bulk",
  expectedEventVolume: "medium",
  wakeStoreLoadEstimate: "low",
  affectedProjectionNames: [
    "collections:collections-saved-list-valuation-projection",
    "pricing:pricing-repricing-evaluation-reaction",
  ],
  routeDependencyIds: [],
});
