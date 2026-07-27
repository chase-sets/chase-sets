import { registryEntry } from "../source-context-wake-registry-entry";

export const settlementWakeRegistryEntry = registryEntry({
  sourceContextName: "settlement",
  owner: "Settlement",
  rolloutState: "staging-enabled",
  phase: "phase-3-expansion",
  rolloutWave: "wave-3-platform-expansion",
  priorityLane: "standard",
  expectedEventVolume: "medium",
  wakeStoreLoadEstimate: "low",
  affectedProjectionNames: [
    "checkout:checkout.sell-list-projection",
    "marketplace:marketplace-settlement-negative-balance-projection",
    "notifications:notifications-source-facts-outbox-projection",
    "ordering:ordering-order-money-timeline-projection",
    "pricing:pricing-market-trades-projection",
    "settlement:platform-policy-document-projection",
    "settlement:settlement-payout-projection",
    "settlement:settlement-payout-readiness-projection",
    "settlement:settlement-support-hold-projection",
    "settlement:settlement-protection-coverage-projection",
  ],
  routeDependencyIds: ["settlement.payout-readiness-self-refresh", "settlement.payout-request-to-detail"],
  enablement: {
    eventStoreWakeNotifications: true,
    relayFanOut: true,
  },
});
