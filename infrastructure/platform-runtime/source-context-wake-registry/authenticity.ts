import { registryEntry } from "../source-context-wake-registry-entry";

export const authenticityWakeRegistryEntry = registryEntry({
  sourceContextName: "authenticity",
  owner: "Authenticity",
  rolloutState: "not-eligible",
  phase: "phase-3-expansion",
  rolloutWave: "wave-4-deferred-or-not-eligible",
  priorityLane: "bulk",
  expectedEventVolume: "low",
  wakeStoreLoadEstimate: "none",
  affectedProjectionNames: ["authenticity:authenticity-case-projection", "pricing:pricing-market-trades-projection"],
  routeDependencyIds: [],
});
