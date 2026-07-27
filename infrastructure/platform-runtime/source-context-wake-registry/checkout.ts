import { registryEntry } from "../source-context-wake-registry-entry";

export const checkoutWakeRegistryEntry = registryEntry({
  sourceContextName: "checkout",
  owner: "Checkout",
  // Staging-enabled wave-1 hot path (with marketplace/ordering/payments):
  // staging runs the full push loop, while production stays inert through
  // the relay and event-store wake emission kill switches until the
  // production proof gates pass.
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
    "checkout:checkout.cart-projection",
    "checkout:checkout.sell-list-projection",
    "checkout:checkout.session-projection",
    "discovery:discovery-market-projection",
  ],
  routeDependencyIds: [
    "checkout.cart-self-refresh",
    "checkout.guest-cart-add-line-handoff",
    "checkout.guest-sell-list-add-line-handoff",
    "checkout.guest-sell-list-to-checkout",
    "checkout.sell-checkout-confirmation-detail",
    "checkout.sell-list-self-refresh",
    "checkout.session-offer-handoff",
    "checkout.session-payment-handoff",
    "checkout.session-self-refresh",
    "checkout.session-start-to-detail",
  ],
});
