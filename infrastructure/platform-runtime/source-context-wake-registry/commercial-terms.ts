import { registryEntry } from "../source-context-wake-registry-entry";

export const commercialTermsWakeRegistryEntry = registryEntry({
  sourceContextName: "commercial-terms",
  owner: "Commercial Terms",
  rolloutState: "staging-enabled",
  enablement: {
    eventStoreWakeNotifications: true,
    relayFanOut: true,
  },
  phase: "phase-2-composite-migration",
  rolloutWave: "wave-2-commerce-dependencies",
  priorityLane: "bulk",
  expectedEventVolume: "low",
  wakeStoreLoadEstimate: "low",
  affectedProjectionNames: [
    "commercial-terms:platform-policy-document-projection",
    "platform-operations:commercial-terms-effective-date-attention-projection",
    "platform-operations:public-doc-review-queue-projection",
  ],
  routeDependencyIds: [
    "commercial-terms.account-agreement-create-to-home",
    "commercial-terms.agreement-create-to-home",
    "commercial-terms.agreement-update-to-home",
    "commercial-terms.schedule-create-to-home",
    "commercial-terms.schedule-update-to-home",
  ],
});
