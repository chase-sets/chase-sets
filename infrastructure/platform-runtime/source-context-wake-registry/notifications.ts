import { registryEntry } from "../source-context-wake-registry-entry";

export const notificationsWakeRegistryEntry = registryEntry({
  sourceContextName: "notifications",
  owner: "Notifications",
  rolloutState: "not-eligible",
  phase: "phase-3-expansion",
  rolloutWave: "wave-4-deferred-or-not-eligible",
  priorityLane: "bulk",
  expectedEventVolume: "medium",
  wakeStoreLoadEstimate: "none",
  affectedProjectionNames: ["customer-feedback:customer-feedback-notification-delivery-recording"],
  routeDependencyIds: [],
});
