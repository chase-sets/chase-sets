import {
  DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL,
  DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_SOURCE,
  type EventStoreWakeNotificationFailedEvent,
  type EventStoreWakeNotificationPayloadRejectedEvent,
  type PostgresEventStoreWakeNotificationConfig,
} from "@chase-sets/event-core-postgres";

import type { WorkSignalPriorityLane } from "./work-signal-store";

const SOURCE_CONTEXT_WAKE_REGISTRY_SCHEMA_VERSION = 1;

const SOURCE_CONTEXT_WAKE_ROLLOUT_STATES = [
  "not-eligible",
  "eligible",
  "staging-enabled",
  "production-proof",
  "production-enabled",
  "disabled",
  "opted-out",
] as const;

const SOURCE_CONTEXT_WAKE_PHASES = [
  "phase-1-checkout-hot-path",
  "phase-2-composite-migration",
  "phase-3-expansion",
] as const;

const SOURCE_CONTEXT_WAKE_ROLLOUT_WAVES = [
  "wave-1-checkout-hot-path",
  "wave-2-commerce-dependencies",
  "wave-3-platform-expansion",
  "wave-4-deferred-or-not-eligible",
] as const;

const SOURCE_CONTEXT_WAKE_LOAD_ESTIMATES = ["none", "low", "medium", "high", "unknown"] as const;

export const SOURCE_CONTEXT_WAKE_PRODUCTION_GATE_ISSUES = [1243, 1244, 1246, 1249] as const;

const PHASE_1_REQUIRED_ISSUES = [
  1217, 1219, 1220, 1221, 1222, 1223, 1225, 1226, 1227, 1231, 1237, 1239, 1240, 1242, 1243, 1244, 1245, 1246, 1249,
] as const;
const PHASE_2_REQUIRED_ISSUES = [1217, 1224, 1232, 1238, 1243, 1244, 1245, 1246, 1248, 1249] as const;
const PHASE_3_REQUIRED_ISSUES = [1217, 1230, 1233, 1234, 1243, 1244, 1245, 1246, 1249] as const;

export type SourceContextWakePhase = (typeof SOURCE_CONTEXT_WAKE_PHASES)[number];
export type SourceContextWakeRolloutState = (typeof SOURCE_CONTEXT_WAKE_ROLLOUT_STATES)[number];
export type SourceContextWakeRolloutWave = (typeof SOURCE_CONTEXT_WAKE_ROLLOUT_WAVES)[number];
export type SourceContextWakeLoadEstimate = (typeof SOURCE_CONTEXT_WAKE_LOAD_ESTIMATES)[number];

export type SourceContextWakeEnablement = Readonly<{
  eventStoreWakeNotifications: boolean;
  relayFanOut: boolean;
}>;

export type SourceContextWakeRegistryEntry = Readonly<{
  schemaVersion: typeof SOURCE_CONTEXT_WAKE_REGISTRY_SCHEMA_VERSION;
  sourceContextName: string;
  owner: string;
  rolloutState: SourceContextWakeRolloutState;
  phase: SourceContextWakePhase;
  rolloutWave: SourceContextWakeRolloutWave;
  priorityLane: WorkSignalPriorityLane;
  expectedEventVolume: SourceContextWakeLoadEstimate;
  wakeStoreLoadEstimate: SourceContextWakeLoadEstimate;
  affectedProjectionNames: readonly string[];
  routeDependencyIds: readonly string[];
  requiredIssueNumbers: readonly number[];
  productionEvidenceIssueNumbers: readonly number[];
  enablement: SourceContextWakeEnablement;
  disabledReason?: string;
  optOutReason?: string;
}>;

export type SourceContextWakeRegistrySummary = Readonly<{
  entryCount: number;
  activeEntryCount: number;
  enabledEventStoreWakeContextCount: number;
  enabledRelayFanOutContextCount: number;
  rolloutStateCounts: readonly Readonly<{
    rolloutState: SourceContextWakeRolloutState;
    count: number;
  }>[];
  rolloutWaveCounts: readonly Readonly<{
    rolloutWave: SourceContextWakeRolloutWave;
    count: number;
  }>[];
}>;

export type SourceContextWakeRelayConfig = Readonly<{
  sourceContextName: string;
  channel: string;
  rolloutState: SourceContextWakeRolloutState;
  phase: SourceContextWakePhase;
  rolloutWave: SourceContextWakeRolloutWave;
  priorityLane: WorkSignalPriorityLane;
  relayFanOutEnabled: boolean;
  expectedEventVolume: SourceContextWakeLoadEstimate;
  wakeStoreLoadEstimate: SourceContextWakeLoadEstimate;
  requiredIssueNumbers: readonly number[];
  productionEvidenceIssueNumbers: readonly number[];
}>;

export type ListSourceContextWakeRegistryEntriesInput = Readonly<{
  registry?: readonly SourceContextWakeRegistryEntry[];
  rolloutStates?: readonly SourceContextWakeRolloutState[];
  rolloutWaves?: readonly SourceContextWakeRolloutWave[];
  phases?: readonly SourceContextWakePhase[];
  includeInactive?: boolean;
}>;

export type SourceContextWakeNotificationConfigInput = Readonly<{
  sourceContextName: string;
  registry?: readonly SourceContextWakeRegistryEntry[];
  channel?: string;
  source?: string;
  maxPayloadBytes?: number;
}>;

export type ListSourceContextWakeRelayConfigsInput = Readonly<{
  registry?: readonly SourceContextWakeRegistryEntry[];
  channel?: string;
  includeInactive?: boolean;
}>;

export type ValidateSourceContextWakeRegistryInput = Readonly<{
  registry?: readonly SourceContextWakeRegistryEntry[];
  boundedContextNames?: readonly string[];
}>;

export const sourceContextWakeRegistry = [
  registryEntry({
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
  }),
  registryEntry({
    sourceContextName: "authenticity",
    owner: "Authenticity",
    rolloutState: "not-eligible",
    phase: "phase-3-expansion",
    rolloutWave: "wave-4-deferred-or-not-eligible",
    priorityLane: "bulk",
    expectedEventVolume: "low",
    wakeStoreLoadEstimate: "none",
    affectedProjectionNames: ["authenticity:authenticity-case-projection", "pricing:pricing-market-trades-projection"],
    routeDependencyIds: [],
  }),
  registryEntry({
    sourceContextName: "catalog",
    owner: "Catalog",
    rolloutState: "staging-enabled",
    enablement: {
      eventStoreWakeNotifications: true,
      relayFanOut: true,
    },
    phase: "phase-2-composite-migration",
    rolloutWave: "wave-2-commerce-dependencies",
    priorityLane: "standard",
    expectedEventVolume: "high",
    wakeStoreLoadEstimate: "high",
    affectedProjectionNames: [
      "catalog:catalog-admin-catalog-item-projection",
      "catalog:catalog-attention-dismissal-projection",
      "catalog:catalog-item-projection",
      "catalog:catalog-product-contents-projection",
      "catalog:catalog-provider-scope-mapping-projection",
      "catalog:catalog-scope-registry-projection",
      "catalog:catalog-source-observation-projection",
      "checkout:checkout-catalog-item-projection",
      "checkout:checkout-marketplace-listing-options-projection",
      "collections:collections-catalog-product-projection",
      "discovery:discovery-category-projection",
      "discovery:discovery-google-shopping-feed-row-projection",
      "discovery:discovery-item-detail-projection",
      "discovery:discovery-market-projection",
      "discovery:discovery-search-item-projection",
      "inventory:inventory-catalog-item-projection",
      "marketplace:marketplace-catalog-item-projection",
      "marketplace:marketplace-listing-projection",
      "ordering:ordering-marketplace-supply-input-projection",
      "pricing:pricing-catalog-input-projection",
    ],
    routeDependencyIds: [],
  }),
  registryEntry({
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
  }),
  registryEntry({
    sourceContextName: "collections",
    owner: "Collections",
    rolloutState: "not-eligible",
    phase: "phase-3-expansion",
    rolloutWave: "wave-4-deferred-or-not-eligible",
    priorityLane: "standard",
    expectedEventVolume: "medium",
    wakeStoreLoadEstimate: "medium",
    affectedProjectionNames: [
      "collections:collections-saved-list-projection",
      "collections:collections-saved-list-picker-projection",
      "collections:collections-saved-list-valuation-projection",
      "collections:collections.saved-list-shared-page-projection",
      "discovery:discovery-saved-list-picker-projection",
    ],
    routeDependencyIds: [
      "collections.saved-list-bulk-to-detail",
      "collections.saved-list-create-to-detail",
      "collections.saved-list-detail-self-refresh",
      "collections.saved-list-list-self-refresh",
    ],
  }),
  registryEntry({
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
      "platform-operations:public-doc-review-queue-projection",
    ],
    routeDependencyIds: [
      "commercial-terms.account-agreement-create-to-list",
      "commercial-terms.agreement-create-to-list",
      "commercial-terms.agreement-update-to-detail",
      "commercial-terms.schedule-create-to-list",
      "commercial-terms.schedule-update-to-detail",
    ],
  }),
  registryEntry({
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
  }),
  registryEntry({
    sourceContextName: "discovery",
    owner: "Discovery",
    rolloutState: "eligible",
    phase: "phase-3-expansion",
    rolloutWave: "wave-3-platform-expansion",
    priorityLane: "standard",
    expectedEventVolume: "medium",
    wakeStoreLoadEstimate: "low",
    affectedProjectionNames: ["discovery:discovery-product-alert-page-projection"],
    routeDependencyIds: [
      "discovery.item-detail-add-to-cart-semantic-handoff",
      "discovery.item-detail-add-to-sell-list-semantic-handoff",
      "discovery.item-detail-checkout-handoff",
      "discovery.item-detail-listing-publication-self-refresh",
      "discovery.item-detail-ship-from-setup-self-refresh",
    ],
  }),
  registryEntry({
    sourceContextName: "fulfillment",
    owner: "Fulfillment",
    rolloutState: "eligible",
    phase: "phase-2-composite-migration",
    rolloutWave: "wave-2-commerce-dependencies",
    priorityLane: "standard",
    expectedEventVolume: "medium",
    wakeStoreLoadEstimate: "medium",
    affectedProjectionNames: [
      "auth:auth-agent-order-webhook-projection",
      "fulfillment:fulfillment-shipment-projection",
      "fulfillment:fulfillment-return-shipment-projection",
      "inventory:inventory-fulfillment-recovered-item-workflow",
      "inventory:inventory-fulfillment-restock-workflow",
      "payments:payments-fulfillment-dispute-evidence-source-projection",
      "payments:payments-support-refund-effect",
      "notifications:notifications-source-facts-outbox-projection",
      "ordering:ordering-fulfillment-cancellation-inputs",
      "ordering:ordering-order-review-opportunity-projection",
      "payments:payments-fulfillment-dispute-evidence-source-projection",
      "pricing:pricing-fulfillment-input-projection",
      "pricing:pricing-market-trades-projection",
      "marketplace:marketplace-review-shipment-source-projection",
      "marketplace:marketplace-seller-metrics-shipment-source-projection",
      "settlement:settlement-fulfillment-source-projection",
      "platform-operations:support-shipment-source-projection",
    ],
    routeDependencyIds: ["fulfillment.seller-shipment-self-refresh"],
  }),
  registryEntry({
    sourceContextName: "identity",
    owner: "Identity",
    // Staging-enabled for cross-device User presentation preferences:
    // preference writes must wake Identity's own read models so reloads and
    // second sessions observe the committed viewer setting without waiting on
    // fallback polling. Production remains inert through the environment kill
    // switches until the production proof gates pass.
    rolloutState: "staging-enabled",
    enablement: {
      eventStoreWakeNotifications: true,
      relayFanOut: true,
    },
    phase: "phase-2-composite-migration",
    rolloutWave: "wave-2-commerce-dependencies",
    priorityLane: "standard",
    expectedEventVolume: "high",
    wakeStoreLoadEstimate: "high",
    affectedProjectionNames: [
      "auth:auth-identity-account-projection",
      "auth:auth-identity-invitation-projection",
      "auth:auth-identity-membership-projection",
      "auth:auth-identity-user-projection",
      "checkout:checkout-seller-accounts-projection",
      "commercial-terms:commercial-terms-account-projection",
      "commercial-terms:commercial-terms-founders-window-reaction",
      "discovery:discovery-market-projection",
      "fulfillment:fulfillment-account-projection",
      "identity:identity-account-projection",
      "identity:identity-api-key-projection",
      "identity:identity-consent-current-state-projection",
      "identity:identity-consent-projection",
      "identity:identity-founders-cohort-projection",
      "identity:identity-invitation-projection",
      "identity:identity-membership-projection",
      "identity:identity-shipping-address-projection",
      "identity:identity-user-preferences-projection",
      "identity:identity-user-projection",
      "identity:platform-policy-document-projection",
      "marketplace:marketplace-identity-account-projection",
      "marketplace:marketplace-review-account-source-projection",
      "ordering:ordering-account-projection",
      "payments:payments-account-risk-source-projection",
      "platform-operations:risk-alert-queue-projection",
      "pricing:pricing-market-trades-projection",
      "public-presence:public-presence-waitlist-transactional-email-projection",
      "settlement:settlement-account-risk-source-projection",
    ],
    routeDependencyIds: [
      "identity.account-security-api-key-fresh-read",
      "identity.account-security-user-fresh-read",
      "identity.account-team-invitation-fresh-read",
      "identity.account-team-membership-fresh-read",
      "identity.consent-withdrawal-fresh-read",
      "identity.admin-account-detail-fresh-read",
      "identity.admin-api-key-create-detail-fresh-read",
      "identity.admin-api-key-detail-fresh-read",
      "identity.admin-api-key-list-fresh-read",
      "identity.admin-invitation-create-detail-fresh-read",
      "identity.admin-invitation-detail-fresh-read",
      "identity.admin-invitation-list-fresh-read",
      "identity.admin-membership-detail-fresh-read",
      "identity.admin-user-detail-fresh-read",
      "identity.invitation-email-auth-projection-fresh-read",
      "identity.marketplace-account-profile-fresh-read",
      "identity.registration-current-actor-display-fresh-read",
      "identity.shipping-addresses-fresh-read",
    ],
  }),
  registryEntry({
    sourceContextName: "inventory",
    owner: "Inventory",
    rolloutState: "staging-enabled",
    enablement: {
      eventStoreWakeNotifications: true,
      relayFanOut: true,
    },
    phase: "phase-2-composite-migration",
    rolloutWave: "wave-2-commerce-dependencies",
    priorityLane: "hot",
    expectedEventVolume: "high",
    wakeStoreLoadEstimate: "high",
    affectedProjectionNames: [
      "checkout:checkout-inventory-supply-projection",
      "discovery:discovery-market-projection",
      "inventory:inventory-hold-projection",
      "inventory:inventory-item-ledger-projection",
      "inventory:inventory-item-projection",
      "inventory:inventory-reservation-projection",
      "inventory:inventory-recovered-item-projection",
      "inventory:inventory-restock-decision-projection",
      "inventory:inventory-storage-location-projection",
      "notifications:notifications-source-facts-outbox-projection",
      "marketplace:marketplace-inventory-supply-projection",
      "notifications:notifications-source-facts-outbox-projection",
      "ordering:ordering-inventory-reservation-outcomes",
      "ordering:ordering-inventory-supply-input-projection",
      "pricing:pricing-inventory-input-projection",
      "settlement:settlement-inventory-recovery-workflow",
    ],
    routeDependencyIds: [
      "inventory.import-batch-detail",
      "inventory.item-adjust-to-detail",
      "inventory.item-create-to-detail",
      "inventory.restock-decision-list",
      "inventory.storage-locations-list",
    ],
  }),
  registryEntry({
    sourceContextName: "marketplace",
    owner: "Marketplace",
    // Wave-1 remainder, staging-enabled after checkout's staging push-loop
    // evidence (push-wake-slo-load-proof.md). Production stays inert via the
    // environment kill switches; the wave-1 listener URLs and connection
    // budget already cover this context (locals.tf).
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
      "checkout:checkout-marketplace-listing-options-projection",
      "checkout:checkout-seller-accounts-projection",
      "checkout:checkout.sell-list-projection",
      "discovery:discovery-market-projection",
      "discovery:discovery-product-alert-notification-projection",
      "identity:identity-founder-claim-reaction",
      "marketplace:marketplace-identity-account-projection",
      "marketplace:marketplace-listing-projection",
      "marketplace:marketplace-offer-projection",
      "marketplace:marketplace-review-hold-projection",
      "marketplace:marketplace-review-projection",
      "marketplace:marketplace-review-notification-projection",
      "marketplace:platform-policy-document-projection",
      "notifications:notifications-source-facts-outbox-projection",
      "ordering:ordering-marketplace-offer-acceptance",
      "ordering:ordering-marketplace-supply-input-projection",
      "ordering:ordering-order-review-opportunity-projection",
      "platform-operations:reported-content-queue-projection",
      "platform-operations:risk-alert-queue-projection",
      "pricing:pricing-market-input-projection",
      "settlement:settlement-account-risk-source-projection",
    ],
    routeDependencyIds: [
      "marketplace.import-listing-inventory-handoff",
      "marketplace.listing-availability-self-refresh",
      "marketplace.listing-create-from-list-to-detail",
      "marketplace.listing-create-to-detail",
      "marketplace.listing-fee-lock-self-refresh",
      "marketplace.listing-inventory-self-refresh",
      "marketplace.listing-list-self-refresh",
      "marketplace.listing-stock-location-self-refresh",
      "marketplace.offer-match-accept-to-detail",
      "marketplace.offer-match-seller-control-list-refresh",
      "marketplace.order-capacity-self-refresh",
      "marketplace.review-reply-to-detail",
      "marketplace.review-submit-to-detail",
      "marketplace.submitted-offer-detail",
    ],
  }),
  registryEntry({
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
  }),
  registryEntry({
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
  }),
  registryEntry({
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
  }),
  registryEntry({
    sourceContextName: "platform-operations",
    owner: "Platform Operations",
    rolloutState: "staging-enabled",
    enablement: {
      eventStoreWakeNotifications: true,
      relayFanOut: true,
    },
    phase: "phase-3-expansion",
    rolloutWave: "wave-3-platform-expansion",
    priorityLane: "standard",
    expectedEventVolume: "medium",
    wakeStoreLoadEstimate: "low",
    affectedProjectionNames: [
      "platform-operations:experience-platform-feedback-projection",
      "platform-operations:platform-policy-document-projection",
      "platform-operations:public-doc-review-queue-projection",
      "platform-operations:reported-content-queue-projection",
      "platform-operations:risk-alert-queue-projection",
      "fulfillment:fulfillment-support-return-source-projection",
      "notifications:notifications-source-facts-outbox-projection",
      "platform-operations:support-request-projection",
      "payments:payments-support-refund-effect",
      "marketplace:marketplace-review-hold-reaction",
      "marketplace:marketplace-review-moderation-reaction",
      "marketplace:marketplace-review-support-source-projection",
      "marketplace:marketplace-seller-metrics-support-source-projection",
      "ordering:ordering-order-money-timeline-projection",
      "ordering:ordering-order-review-opportunity-projection",
      "settlement:settlement-liability-allocation-reserve-projection",
      "settlement:settlement-support-hold-lifecycle-projection",
      "settlement:settlement-support-hold-projection",
    ],
    routeDependencyIds: [
      "platform-operations.platform-feedback-detail-fresh-read",
      "platform-operations.platform-feedback-list-fresh-read",
      "platform-operations.support-request-detail-fresh-read",
    ],
  }),
  registryEntry({
    sourceContextName: "pricing",
    owner: "Pricing",
    rolloutState: "not-eligible",
    phase: "phase-3-expansion",
    rolloutWave: "wave-4-deferred-or-not-eligible",
    priorityLane: "bulk",
    expectedEventVolume: "medium",
    wakeStoreLoadEstimate: "low",
    affectedProjectionNames: ["collections:collections-saved-list-valuation-projection"],
    routeDependencyIds: [],
  }),
  registryEntry({
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
  }),
  registryEntry({
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
  }),
] as const satisfies readonly SourceContextWakeRegistryEntry[];

export function validateSourceContextWakeRegistry(input: ValidateSourceContextWakeRegistryInput = {}): void {
  const registry = input.registry ?? sourceContextWakeRegistry;
  const seenSourceContextNames = new Set<string>();

  if (registry.length === 0) {
    throw new Error("Source-context wake registry must contain at least one entry.");
  }

  for (const entry of registry) {
    validateSourceContextWakeRegistryEntry(entry);

    if (seenSourceContextNames.has(entry.sourceContextName)) {
      throw new Error(`Source-context wake registry contains duplicate entry '${entry.sourceContextName}'.`);
    }
    seenSourceContextNames.add(entry.sourceContextName);
  }

  if (input.boundedContextNames) {
    assertRegistryCoversBoundedContexts(registry, input.boundedContextNames);
  }
}

export function listSourceContextWakeRegistryEntries(
  input: ListSourceContextWakeRegistryEntriesInput = {},
): readonly SourceContextWakeRegistryEntry[] {
  const registry = input.registry ?? sourceContextWakeRegistry;
  const rolloutStates = input.rolloutStates ? new Set(input.rolloutStates) : null;
  const rolloutWaves = input.rolloutWaves ? new Set(input.rolloutWaves) : null;
  const phases = input.phases ? new Set(input.phases) : null;

  return registry.filter(
    (entry) =>
      (!rolloutStates || rolloutStates.has(entry.rolloutState)) &&
      (!rolloutWaves || rolloutWaves.has(entry.rolloutWave)) &&
      (!phases || phases.has(entry.phase)) &&
      (input.includeInactive || isSourceContextWakeActive(entry) || entry.rolloutState === "eligible"),
  );
}

function getSourceContextWakeRegistryEntry(
  sourceContextName: string,
  registry: readonly SourceContextWakeRegistryEntry[] = sourceContextWakeRegistry,
): SourceContextWakeRegistryEntry | null {
  return registry.find((entry) => entry.sourceContextName === sourceContextName) ?? null;
}

export function requireSourceContextWakeRegistryEntry(
  sourceContextName: string,
  registry: readonly SourceContextWakeRegistryEntry[] = sourceContextWakeRegistry,
): SourceContextWakeRegistryEntry {
  const entry = getSourceContextWakeRegistryEntry(sourceContextName, registry);
  if (!entry) {
    throw new Error(`Source context '${sourceContextName}' is not present in the wake registry.`);
  }
  return entry;
}

export const PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED_ENV = "PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED";
export const PLATFORM_PROJECTION_WAKE_SOURCE_CONTEXTS_ENV = "PLATFORM_PROJECTION_WAKE_SOURCE_CONTEXTS";

/**
 * Deployment-level kill switch for write-side event-store wake emission. The
 * registry is environment-global, so environments that must stay inert (for
 * example production before its proof gates pass) set this to "false" to
 * force every registry-derived emission config off without a code change.
 *
 * Parsing matches the worker boolean-env convention: unset keeps the default
 * (enabled); any value outside the affirmative set disables emission, so a
 * typo can never silently enable a production emitter.
 */
export function isEventStoreWakeNotificationEmissionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED_ENV]?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return true;
  }

  return ["1", "true", "yes", "on"].includes(value);
}

export function isProjectionWakeSourceContextEnabled(
  sourceContextName: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const rawValue = env[PLATFORM_PROJECTION_WAKE_SOURCE_CONTEXTS_ENV]?.trim();
  if (rawValue === undefined || rawValue === "" || rawValue === "*") {
    return true;
  }

  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(sourceContextName);
}

export function createEventStoreWakeNotificationConfigForSourceContext(
  input: SourceContextWakeNotificationConfigInput,
): PostgresEventStoreWakeNotificationConfig {
  const entry = requireSourceContextWakeRegistryEntry(input.sourceContextName, input.registry);
  validateSourceContextWakeRegistryEntry(entry);

  return {
    enabled:
      entry.enablement.eventStoreWakeNotifications &&
      isEventStoreWakeNotificationEmissionEnabled() &&
      isProjectionWakeSourceContextEnabled(entry.sourceContextName),
    channel: input.channel ?? DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL,
    source: input.source ?? DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_SOURCE,
    ...(input.maxPayloadBytes === undefined ? {} : { maxPayloadBytes: input.maxPayloadBytes }),
    observer: createEventStoreWakeNotificationObserver(),
  };
}

function createEventStoreWakeNotificationObserver(): NonNullable<PostgresEventStoreWakeNotificationConfig["observer"]> {
  return {
    notificationFailed: (event) => {
      console.warn("Event-store wake notification failed after commit; projections fall back to bounded polling.", {
        type: "event_store_wake.notification_failed",
        channel: event.channel,
        sourceContextName: event.sourceContextName,
        streamCategory: event.streamCategory,
        firstGlobalPosition: event.firstGlobalPosition,
        lastGlobalPosition: event.lastGlobalPosition,
        eventCount: event.eventCount,
        correlationId: event.correlationId,
        error: eventStoreWakeNotificationErrorSummary(event.error),
      } satisfies EventStoreWakeNotificationFailedLog);
    },
    payloadRejected: (event) => {
      console.warn("Event-store wake notification payload rejected; projections fall back to bounded polling.", {
        type: "event_store_wake.payload_rejected",
        channel: event.channel,
        sourceContextName: event.sourceContextName,
        streamCategory: event.streamCategory,
        firstGlobalPosition: event.firstGlobalPosition,
        lastGlobalPosition: event.lastGlobalPosition,
        eventCount: event.eventCount,
        correlationId: event.correlationId,
        reason: event.reason,
      } satisfies EventStoreWakeNotificationPayloadRejectedLog);
    },
  };
}

type EventStoreWakeNotificationFailedLog = Omit<EventStoreWakeNotificationFailedEvent, "error"> &
  Readonly<{
    type: "event_store_wake.notification_failed";
    error: string;
  }>;

type EventStoreWakeNotificationPayloadRejectedLog = EventStoreWakeNotificationPayloadRejectedEvent &
  Readonly<{
    type: "event_store_wake.payload_rejected";
  }>;

function eventStoreWakeNotificationErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function listEventStoreWakeNotificationSourceContexts(
  registry: readonly SourceContextWakeRegistryEntry[] = sourceContextWakeRegistry,
): readonly SourceContextWakeRegistryEntry[] {
  return registry.filter((entry) => entry.enablement.eventStoreWakeNotifications);
}

export function listSourceContextWakeRelayConfigs(
  input: ListSourceContextWakeRelayConfigsInput = {},
): readonly SourceContextWakeRelayConfig[] {
  const registry = input.registry ?? sourceContextWakeRegistry;
  const channel = input.channel ?? DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL;

  return registry
    .filter((entry) => input.includeInactive || entry.enablement.relayFanOut)
    .filter((entry) => input.includeInactive || isProjectionWakeSourceContextEnabled(entry.sourceContextName))
    .map((entry) => ({
      sourceContextName: entry.sourceContextName,
      channel,
      rolloutState: entry.rolloutState,
      phase: entry.phase,
      rolloutWave: entry.rolloutWave,
      priorityLane: entry.priorityLane,
      relayFanOutEnabled: entry.enablement.relayFanOut,
      expectedEventVolume: entry.expectedEventVolume,
      wakeStoreLoadEstimate: entry.wakeStoreLoadEstimate,
      requiredIssueNumbers: entry.requiredIssueNumbers,
      productionEvidenceIssueNumbers: entry.productionEvidenceIssueNumbers,
    }));
}

export function summarizeSourceContextWakeRegistry(
  registry: readonly SourceContextWakeRegistryEntry[] = sourceContextWakeRegistry,
): SourceContextWakeRegistrySummary {
  return {
    entryCount: registry.length,
    activeEntryCount: registry.filter(isSourceContextWakeActive).length,
    enabledEventStoreWakeContextCount: registry.filter((entry) => entry.enablement.eventStoreWakeNotifications).length,
    enabledRelayFanOutContextCount: registry.filter((entry) => entry.enablement.relayFanOut).length,
    rolloutStateCounts: countRolloutStates(registry),
    rolloutWaveCounts: countRolloutWaves(registry),
  };
}

function isSourceContextWakeActive(entry: Pick<SourceContextWakeRegistryEntry, "rolloutState">): boolean {
  return (
    entry.rolloutState === "staging-enabled" ||
    entry.rolloutState === "production-proof" ||
    entry.rolloutState === "production-enabled"
  );
}

function registryEntry(
  input: Omit<
    SourceContextWakeRegistryEntry,
    "schemaVersion" | "requiredIssueNumbers" | "productionEvidenceIssueNumbers" | "enablement"
  > &
    Partial<
      Pick<SourceContextWakeRegistryEntry, "requiredIssueNumbers" | "productionEvidenceIssueNumbers" | "enablement">
    >,
): SourceContextWakeRegistryEntry {
  return {
    schemaVersion: SOURCE_CONTEXT_WAKE_REGISTRY_SCHEMA_VERSION,
    ...input,
    affectedProjectionNames: sortUnique(input.affectedProjectionNames),
    routeDependencyIds: sortUnique(input.routeDependencyIds),
    requiredIssueNumbers: sortUniqueNumbers([
      ...phaseRequiredIssueNumbers(input.phase),
      ...(input.requiredIssueNumbers ?? []),
    ]),
    productionEvidenceIssueNumbers: sortUniqueNumbers([
      ...SOURCE_CONTEXT_WAKE_PRODUCTION_GATE_ISSUES,
      ...(input.productionEvidenceIssueNumbers ?? []),
    ]),
    enablement: input.enablement ?? {
      eventStoreWakeNotifications: false,
      relayFanOut: false,
    },
  };
}

function phaseRequiredIssueNumbers(phase: SourceContextWakePhase): readonly number[] {
  if (phase === "phase-1-checkout-hot-path") {
    return PHASE_1_REQUIRED_ISSUES;
  }
  if (phase === "phase-2-composite-migration") {
    return PHASE_2_REQUIRED_ISSUES;
  }
  return PHASE_3_REQUIRED_ISSUES;
}

function validateSourceContextWakeRegistryEntry(entry: SourceContextWakeRegistryEntry): void {
  assertNonEmptyText(entry.sourceContextName, "sourceContextName");
  assertNonEmptyText(entry.owner, `${entry.sourceContextName}.owner`);

  if (entry.schemaVersion !== SOURCE_CONTEXT_WAKE_REGISTRY_SCHEMA_VERSION) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' has unsupported schemaVersion ${entry.schemaVersion}.`,
    );
  }

  if (!SOURCE_CONTEXT_WAKE_ROLLOUT_STATES.includes(entry.rolloutState)) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' has invalid rolloutState '${entry.rolloutState}'.`,
    );
  }

  if (!SOURCE_CONTEXT_WAKE_PHASES.includes(entry.phase)) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' has invalid phase '${entry.phase}'.`,
    );
  }

  if (!SOURCE_CONTEXT_WAKE_ROLLOUT_WAVES.includes(entry.rolloutWave)) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' has invalid rolloutWave '${entry.rolloutWave}'.`,
    );
  }

  if (!["hot", "standard", "bulk"].includes(entry.priorityLane)) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' has invalid priorityLane '${entry.priorityLane}'.`,
    );
  }

  if (!SOURCE_CONTEXT_WAKE_LOAD_ESTIMATES.includes(entry.expectedEventVolume)) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' has invalid expectedEventVolume '${entry.expectedEventVolume}'.`,
    );
  }

  if (!SOURCE_CONTEXT_WAKE_LOAD_ESTIMATES.includes(entry.wakeStoreLoadEstimate)) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' has invalid wakeStoreLoadEstimate '${entry.wakeStoreLoadEstimate}'.`,
    );
  }

  assertUniqueStrings(entry.affectedProjectionNames, `${entry.sourceContextName}.affectedProjectionNames`);
  assertUniqueStrings(entry.routeDependencyIds, `${entry.sourceContextName}.routeDependencyIds`);
  assertUniqueNumbers(entry.requiredIssueNumbers, `${entry.sourceContextName}.requiredIssueNumbers`);
  assertUniqueNumbers(
    entry.productionEvidenceIssueNumbers,
    `${entry.sourceContextName}.productionEvidenceIssueNumbers`,
  );

  if (entry.enablement.relayFanOut && !entry.enablement.eventStoreWakeNotifications) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' cannot enable relay fan-out without event-store wake notifications.`,
    );
  }

  if (
    (entry.enablement.eventStoreWakeNotifications || entry.enablement.relayFanOut) &&
    !isSourceContextWakeActive(entry)
  ) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' cannot enable runtime wake behavior while rolloutState is '${entry.rolloutState}'.`,
    );
  }

  if (isSourceContextWakeActive(entry)) {
    if (!entry.enablement.eventStoreWakeNotifications || !entry.enablement.relayFanOut) {
      throw new Error(
        `Source-context wake registry entry '${entry.sourceContextName}' has active rolloutState '${entry.rolloutState}' but runtime enablement is incomplete.`,
      );
    }
  }

  if (entry.rolloutState === "production-proof" || entry.rolloutState === "production-enabled") {
    const missingGateIssues = SOURCE_CONTEXT_WAKE_PRODUCTION_GATE_ISSUES.filter(
      (issueNumber) => !entry.productionEvidenceIssueNumbers.includes(issueNumber),
    );
    if (missingGateIssues.length > 0) {
      throw new Error(
        `Source-context wake registry entry '${entry.sourceContextName}' is missing production gate issue(s): ${missingGateIssues.join(
          ", ",
        )}.`,
      );
    }
  }

  if (entry.rolloutState === "disabled" && !entry.disabledReason?.trim()) {
    throw new Error(`Source-context wake registry entry '${entry.sourceContextName}' is disabled without a reason.`);
  }

  if (entry.rolloutState !== "disabled" && entry.disabledReason) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' declares disabledReason while rolloutState is '${entry.rolloutState}'.`,
    );
  }

  if (entry.rolloutState === "opted-out" && !entry.optOutReason?.trim()) {
    throw new Error(`Source-context wake registry entry '${entry.sourceContextName}' is opted out without a reason.`);
  }

  if (entry.rolloutState !== "opted-out" && entry.optOutReason) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' declares optOutReason while rolloutState is '${entry.rolloutState}'.`,
    );
  }
}

function assertRegistryCoversBoundedContexts(
  registry: readonly SourceContextWakeRegistryEntry[],
  boundedContextNames: readonly string[],
): void {
  const registryNames = new Set(registry.map((entry) => entry.sourceContextName));
  const contextNames = new Set(boundedContextNames);
  const missing = [...contextNames].filter((contextName) => !registryNames.has(contextName)).sort();
  const unknown = [...registryNames].filter((contextName) => !contextNames.has(contextName)).sort();

  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `Source-context wake registry coverage mismatch. Missing: ${missing.join(", ") || "none"}. Unknown: ${
        unknown.join(", ") || "none"
      }.`,
    );
  }
}

function assertNonEmptyText(value: string, fieldName: string): void {
  if (!value.trim()) {
    throw new Error(`Source-context wake registry field '${fieldName}' is required.`);
  }
}

function assertUniqueStrings(values: readonly string[], fieldName: string): void {
  for (const value of values) {
    assertNonEmptyText(value, fieldName);
  }

  const duplicates = duplicatesOf(values);
  if (duplicates.length > 0) {
    throw new Error(
      `Source-context wake registry field '${fieldName}' contains duplicate value(s): ${duplicates.join(", ")}.`,
    );
  }
}

function assertUniqueNumbers(values: readonly number[], fieldName: string): void {
  const duplicates = duplicatesOf(values);
  if (duplicates.length > 0) {
    throw new Error(
      `Source-context wake registry field '${fieldName}' contains duplicate value(s): ${duplicates.join(", ")}.`,
    );
  }

  const invalid = values.filter((value) => !Number.isInteger(value) || value < 1);
  if (invalid.length > 0) {
    throw new Error(
      `Source-context wake registry field '${fieldName}' contains invalid issue number(s): ${invalid.join(", ")}.`,
    );
  }
}

function sortUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortUniqueNumbers(values: readonly number[]): readonly number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function duplicatesOf<T>(values: readonly T[]): readonly T[] {
  const seen = new Set<T>();
  const duplicates = new Set<T>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }

  return [...duplicates];
}

function countRolloutStates(
  entries: readonly SourceContextWakeRegistryEntry[],
): SourceContextWakeRegistrySummary["rolloutStateCounts"] {
  return SOURCE_CONTEXT_WAKE_ROLLOUT_STATES.map((rolloutState) => ({
    rolloutState,
    count: entries.filter((entry) => entry.rolloutState === rolloutState).length,
  }));
}

function countRolloutWaves(
  entries: readonly SourceContextWakeRegistryEntry[],
): SourceContextWakeRegistrySummary["rolloutWaveCounts"] {
  return SOURCE_CONTEXT_WAKE_ROLLOUT_WAVES.map((rolloutWave) => ({
    rolloutWave,
    count: entries.filter((entry) => entry.rolloutWave === rolloutWave).length,
  }));
}
