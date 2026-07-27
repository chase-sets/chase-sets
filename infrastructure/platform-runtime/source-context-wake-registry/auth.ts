import { registryEntry } from "../source-context-wake-registry-entry";

export const authWakeRegistryEntry = registryEntry({
  sourceContextName: "auth",
  owner: "Auth",
  rolloutState: "eligible",
  phase: "phase-3-expansion",
  rolloutWave: "wave-3-platform-expansion",
  priorityLane: "bulk",
  expectedEventVolume: "low",
  wakeStoreLoadEstimate: "none",
  affectedProjectionNames: ["auth:auth-session-projection"],
  routeDependencyIds: [
    "auth.browser-registration-identity-freshness-carrier",
    "auth.current-session-fresh-read",
    "auth.session-detail-self-refresh",
  ],
});
