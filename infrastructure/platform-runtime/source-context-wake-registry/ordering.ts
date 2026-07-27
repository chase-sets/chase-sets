import { registryEntry } from "../source-context-wake-registry-entry";

export const orderingWakeRegistryEntry = registryEntry({
  sourceContextName: "ordering",
  owner: "Ordering",
  // Wave-1 remainder, staging-enabled; see the marketplace entry note.
  rolloutState: "staging-enabled",
  enablement: {
    eventStoreWakeNotifications: true,
    relayFanOut: true,
  },
  phase: "phase-1-checkout-hot-path",
  rolloutWave: "wave-1-checkout-hot-path",
  priorityLane: "hot",
  expectedEventVolume: "high",
  wakeStoreLoadEstimate: "high",
  affectedProjectionNames: [
    "auth:auth-agent-order-webhook-projection",
    // Order Capacity at-capacity signal (m127): ordering's edge-triggered
    // seller-capacity.reached/.cleared events wake the checkout seller-options
    // and discovery market projections that surface buyer-facing "temporarily
    // at capacity" messaging.
    "checkout:checkout-marketplace-listing-options-projection",
    "discovery:discovery-market-projection",
    "fulfillment:fulfillment-order-source-projection",
    "inventory:inventory-order-reservation-workflow",
    "notifications:notifications-source-facts-outbox-projection",
    "ordering:ordering-order-review-opportunity-projection",
    "ordering:ordering-order-projection",
    "ordering:ordering-postage-policy-projection",
    "payments:payments-order-cancellation-refund-effect",
    "payments:payments-order-input-projection",
    "pricing:pricing-order-input-projection",
    "pricing:pricing-market-trades-projection",
    "marketplace:marketplace-review-order-source-projection",
    "marketplace:marketplace-seller-metrics-order-source-projection",
    "platform-operations:support-order-source-projection",
    "platform-operations:support-affected-line-amount-projection",
  ],
  routeDependencyIds: [
    "ordering.accepted-offer-to-sales-list",
    "ordering.postage-policy-command-to-home",
    "ordering.postage-policy-create-to-list",
    "ordering.purchase-cancel-to-detail",
    "ordering.sale-cancel-to-detail",
  ],
});
