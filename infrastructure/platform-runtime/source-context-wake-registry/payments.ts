import { registryEntry } from "../source-context-wake-registry-entry";

export const paymentsWakeRegistryEntry = registryEntry({
  sourceContextName: "payments",
  owner: "Payments",
  // Wave-1 remainder, staging-enabled; see the marketplace entry note.
  rolloutState: "staging-enabled",
  enablement: {
    eventStoreWakeNotifications: true,
    relayFanOut: true,
  },
  phase: "phase-1-checkout-hot-path",
  rolloutWave: "wave-1-checkout-hot-path",
  priorityLane: "hot",
  expectedEventVolume: "medium",
  wakeStoreLoadEstimate: "medium",
  affectedProjectionNames: [
    "auth:auth-agent-order-webhook-projection",
    "checkout:checkout.payment-affordance-projection",
    "checkout:checkout.payment-summary-projection",
    "fulfillment:fulfillment-payment-fraud-source-projection",
    "ordering:ordering-order-money-timeline-projection",
    "ordering:ordering-payment-capture",
    "payments:payments-account-risk-source-projection",
    "payments:payments-dispute-evidence-submission",
    "payments:payments-fraud-alert-projection",
    "payments:payments-order-cancellation-refund-effect",
    "payments:payments-payment-projection",
    "platform-operations:risk-alert-queue-projection",
    "platform-operations:seller-compliance-sales-projection",
    "platform-operations:support-affected-line-amount-projection",
    "pricing:pricing-market-trades-projection",
    "settlement:settlement-account-risk-source-projection",
    "settlement:settlement-support-hold-projection",
    "settlement:settlement-payment-input-projection",
  ],
  routeDependencyIds: [
    "payments.checkout-status-order-input-fresh-read",
    "payments.create-to-detail",
    "payments.detail-self-refresh",
  ],
});
