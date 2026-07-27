import { registryEntry } from "../source-context-wake-registry-entry";

export const customerFeedbackWakeRegistryEntry = registryEntry({
  sourceContextName: "customer-feedback",
  owner: "Customer Feedback",
  rolloutState: "eligible",
  phase: "phase-3-expansion",
  rolloutWave: "wave-3-platform-expansion",
  priorityLane: "bulk",
  expectedEventVolume: "low",
  wakeStoreLoadEstimate: "low",
  affectedProjectionNames: [
    "customer-feedback:customer-feedback-case-attention-projection",
    "customer-feedback:customer-feedback-csat-analytics-projection",
    "customer-feedback:customer-feedback-csat-invitation-projection",
    "customer-feedback:customer-feedback-feedback-case-opening",
    "customer-feedback:customer-feedback-feedback-case-projection",
    "customer-feedback:platform-policy-document-projection",
    "notifications:notifications-source-facts-outbox-projection",
  ],
  routeDependencyIds: [],
});
