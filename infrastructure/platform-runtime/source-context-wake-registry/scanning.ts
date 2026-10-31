import { registryEntry } from "../source-context-wake-registry-entry";

export const scanningWakeRegistryEntry = registryEntry({
  sourceContextName: "scanning",
  owner: "Scanning",
  rolloutState: "not-eligible",
  phase: "phase-3-expansion",
  rolloutWave: "wave-4-deferred-or-not-eligible",
  priorityLane: "standard",
  expectedEventVolume: "low",
  wakeStoreLoadEstimate: "low",
  affectedProjectionNames: ["scanning:scanning-scan-session-projection"],
  routeDependencyIds: [],
});
