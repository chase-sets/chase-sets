import { registryEntry } from "../source-context-wake-registry-entry";

export const publicPresenceWakeRegistryEntry = registryEntry({
  sourceContextName: "public-presence",
  owner: "Public Presence",
  rolloutState: "staging-enabled",
  enablement: {
    eventStoreWakeNotifications: true,
    relayFanOut: true,
  },
  phase: "phase-3-expansion",
  rolloutWave: "wave-3-platform-expansion",
  priorityLane: "bulk",
  expectedEventVolume: "low",
  wakeStoreLoadEstimate: "low",
  affectedProjectionNames: [
    "public-presence:platform-policy-document-projection",
    "public-presence:public-presence-waitlist-projection",
    "public-presence:public-presence-waitlist-transactional-email-projection",
  ],
  routeDependencyIds: ["public-presence.waitlist-signup-to-admin-review"],
});
