export const checkoutReconciliationPolicyDocPath =
  "bounded-contexts/checkout/docs/checkout-reconciliation-policy.md" as const;

export type CheckoutReconciliationAudience =
  | "guest-buyer"
  | "signed-in-buyer"
  | "guest-seller"
  | "signed-in-seller"
  | "support-operator";

export type CheckoutReconciliationOwnerContext =
  | "Checkout"
  | "Ordering"
  | "Payments"
  | "Fulfillment"
  | "Settlement"
  | "Notifications"
  | "Support"
  | "Account History"
  | "Marketplace"
  | "Platform";

export type CheckoutReconciliationCheckpoint =
  | "cart-list-readiness"
  | "conditional-pre-checkout"
  | "checkout-session-create"
  | "confirmation-handoff-recorded"
  | "provider-callback"
  | "redirect-return"
  | "duplicate-submit"
  | "customer-reload"
  | "background-retry"
  | "downstream-owner-commit"
  | "operator-recovery"
  | "owner-rule";

export type CheckoutReconciliationEffect =
  | "checkout-confirmation"
  | "payment"
  | "order"
  | "inventory-reservation"
  | "marketplace-handoff"
  | "label"
  | "payout"
  | "settlement"
  | "notification"
  | "account-history"
  | "support"
  | "refund"
  | "void"
  | "reversal"
  | "adjustment";

export type CheckoutReconciliationState =
  | "no-side-effect"
  | "confirmation-recorded"
  | "downstream-not-created-yet"
  | "downstream-pending"
  | "downstream-committed"
  | "downstream-failed"
  | "recovered"
  | "reversed"
  | "held"
  | "deferred"
  | "disabled"
  | "unsupported"
  | "provider-outage"
  | "stale-active-session"
  | "duplicate-suppressed";

export type CheckoutReconciliationSourceFact =
  | "checkout-confirmation"
  | "readiness-snapshot"
  | "payment-handoff"
  | "provider-callback"
  | "payments-payment"
  | "ordering-order"
  | "fulfillment-label"
  | "settlement-payout-or-hold"
  | "marketplace-handoff"
  | "notification-message"
  | "account-history-record"
  | "support-safe-reference"
  | "owner-rule"
  | "none-before-confirmation";

export type CheckoutReconciliationLookupStart =
  | "checkout-confirmation-id"
  | "support-safe-reference"
  | "readiness-snapshot-version"
  | "payment-handoff-id"
  | "provider-callback-id"
  | "payment-id"
  | "order-or-group-id"
  | "seller-confirmation-id"
  | "reviewed-line-action-key"
  | "marketplace-handoff-id"
  | "label-id"
  | "payout-or-hold-id"
  | "settlement-id"
  | "notification-id"
  | "account-history-id"
  | "owner-rule-reference";

export type CheckoutReconciliationOwnerIssue =
  | "#1102"
  | "#1112"
  | "#1113"
  | "#1114"
  | "#1115"
  | "#1118"
  | "#1119"
  | "#1120"
  | "#1121"
  | "#1122"
  | "#1124"
  | "#1127"
  | "#1128"
  | "#1129"
  | "#1130"
  | "#1131"
  | "#1134"
  | "#1135"
  | "#1164"
  | "#1165";

export type CheckoutReconciliationControlKey =
  | "pre-confirmation-no-side-effect-recovery"
  | "unassigned-fulfillment-readiness-reconciliation"
  | "optional-fulfillment-optimization-reconciliation"
  | "checkout-confirmation-handoff-ledger"
  | "payment-capture-and-fee-reconciliation"
  | "order-creation-and-split-group-reconciliation"
  | "seller-marketplace-handoff-reconciliation"
  | "label-and-fulfillment-reconciliation"
  | "payout-and-settlement-reconciliation"
  | "notification-delivery-reconciliation"
  | "account-history-reconciliation"
  | "duplicate-submit-and-retry-idempotency"
  | "provider-webhook-replay-reconciliation"
  | "operator-recovery-reconciliation"
  | "refund-void-reversal-adjustment-reconciliation"
  | "pending-downstream-boundary"
  | "support-safe-reconciliation-lookup"
  | "owner-rule-reconciliation-states"
  | "observability-redaction"
  | "fresh-state-reconciliation-cleanup";

export type CheckoutReconciliationBoundary =
  | "before-checkout"
  | "checkout-confirmation"
  | "post-confirmation"
  | "operator-support"
  | "operations-status";

export type CheckoutReconciliationPolicyEntry = Readonly<{
  control: CheckoutReconciliationControlKey;
  docLabel: string;
  ownerIssues: readonly CheckoutReconciliationOwnerIssue[];
  ownerContext: CheckoutReconciliationOwnerContext;
  checkpoints: readonly CheckoutReconciliationCheckpoint[];
  audiences: readonly CheckoutReconciliationAudience[];
  effects: readonly CheckoutReconciliationEffect[];
  states: readonly CheckoutReconciliationState[];
  sourceFacts: readonly CheckoutReconciliationSourceFact[];
  lookupStarts: readonly CheckoutReconciliationLookupStart[];
  boundary: CheckoutReconciliationBoundary;
  idempotencyKeyShape: string;
  supportReferenceRequired: boolean;
  observabilityRequired: boolean;
  ownerRuleRequired: boolean;
  pendingDownstreamBoundaryRequired: boolean;
  duplicatePreventionRequired: boolean;
  noSideEffectBeforeCommitRequired: boolean;
  rejectsSyntheticCompletion: boolean;
  redactsProviderAndPaymentData: boolean;
  forbiddenSources: readonly string[];
  customerSafeOutcome: string;
}>;

const buyerAudiences = ["guest-buyer", "signed-in-buyer"] as const satisfies readonly CheckoutReconciliationAudience[];
const sellerAudiences = [
  "guest-seller",
  "signed-in-seller",
] as const satisfies readonly CheckoutReconciliationAudience[];
const allCustomerAudiences = [
  "guest-buyer",
  "signed-in-buyer",
  "guest-seller",
  "signed-in-seller",
] as const satisfies readonly CheckoutReconciliationAudience[];
const allAudiences = [
  "guest-buyer",
  "signed-in-buyer",
  "guest-seller",
  "signed-in-seller",
  "support-operator",
] as const satisfies readonly CheckoutReconciliationAudience[];

export const checkoutReconciliationForbiddenSources = [
  "old checkout payload repair",
  "old session payload adapter",
  "old sell execution id",
  "old receipt row",
  "old payload migration",
  "migration/backfill helper",
  "dual-write helper",
  "hidden repair",
  "manual database edit",
  "stale fixture bypass",
  "stale cached read model",
  "provider-dashboard-only fix",
  "dense checkout fallback",
  "raw provider payload exposure",
  "card or bank data exposure",
  "support-only synthetic completion",
] as const;

export const checkoutReconciliationRequiredControls = [
  "pre-confirmation-no-side-effect-recovery",
  "unassigned-fulfillment-readiness-reconciliation",
  "optional-fulfillment-optimization-reconciliation",
  "checkout-confirmation-handoff-ledger",
  "payment-capture-and-fee-reconciliation",
  "order-creation-and-split-group-reconciliation",
  "seller-marketplace-handoff-reconciliation",
  "label-and-fulfillment-reconciliation",
  "payout-and-settlement-reconciliation",
  "notification-delivery-reconciliation",
  "account-history-reconciliation",
  "duplicate-submit-and-retry-idempotency",
  "provider-webhook-replay-reconciliation",
  "operator-recovery-reconciliation",
  "refund-void-reversal-adjustment-reconciliation",
  "pending-downstream-boundary",
  "support-safe-reconciliation-lookup",
  "owner-rule-reconciliation-states",
  "observability-redaction",
  "fresh-state-reconciliation-cleanup",
] as const satisfies readonly CheckoutReconciliationControlKey[];

export const checkoutReconciliationOwnerRuleStates: readonly CheckoutReconciliationState[] = [
  "downstream-failed",
  "held",
  "deferred",
  "disabled",
  "unsupported",
  "provider-outage",
  "stale-active-session",
] as const;

export const checkoutReconciliationPolicyEntries = [
  reconciliationPolicy({
    control: "pre-confirmation-no-side-effect-recovery",
    docLabel: "Pre-confirmation no-side-effect recovery",
    ownerIssues: ["#1130", "#1118", "#1119", "#1122"],
    ownerContext: "Checkout",
    checkpoints: ["cart-list-readiness", "checkout-session-create", "customer-reload", "duplicate-submit"],
    audiences: allCustomerAudiences,
    effects: [
      "checkout-confirmation",
      "payment",
      "order",
      "inventory-reservation",
      "marketplace-handoff",
      "label",
      "payout",
      "settlement",
      "notification",
      "account-history",
      "support",
      "refund",
      "void",
      "reversal",
    ],
    states: ["no-side-effect", "stale-active-session", "downstream-not-created-yet"],
    sourceFacts: ["readiness-snapshot", "support-safe-reference", "none-before-confirmation"],
    lookupStarts: ["readiness-snapshot-version", "support-safe-reference"],
    boundary: "before-checkout",
    idempotencyKeyShape: "checkout:no_side_effect:<source-ref>:<readiness-version>:<reason>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: false,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Stale, blocked, superseded, old-shaped, or missing readiness sessions route to cart/list recovery and prove no payment, order, sale, label, payout, settlement, notification, account-history, support, refund, void, or reversal fact was created.",
  }),
  reconciliationPolicy({
    control: "unassigned-fulfillment-readiness-reconciliation",
    docLabel: "Unassigned fulfillment readiness reconciliation",
    ownerIssues: ["#1130", "#1119", "#1127", "#1131", "#1164"],
    ownerContext: "Checkout",
    checkpoints: ["cart-list-readiness", "conditional-pre-checkout", "owner-rule"],
    audiences: allCustomerAudiences,
    effects: ["checkout-confirmation", "payment", "order", "inventory-reservation", "label", "payout", "settlement"],
    states: ["no-side-effect", "downstream-not-created-yet", "unsupported", "deferred"],
    sourceFacts: ["readiness-snapshot", "owner-rule", "support-safe-reference", "none-before-confirmation"],
    lookupStarts: ["readiness-snapshot-version", "support-safe-reference", "owner-rule-reference"],
    boundary: "before-checkout",
    idempotencyKeyShape: "checkout:unassigned_fulfillment:<line-or-group-ref>:<readiness-version>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: false,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Items without fulfillment assignment stay in cart/list readiness or a conditional pre-checkout step; checkout can reconcile the rejection as a no-side-effect outcome and must not assign fulfillment, create labels, or start payment/order work.",
  }),
  reconciliationPolicy({
    control: "optional-fulfillment-optimization-reconciliation",
    docLabel: "Optional fulfillment optimization reconciliation",
    ownerIssues: ["#1130", "#1128", "#1119", "#1164", "#1115"],
    ownerContext: "Checkout",
    checkpoints: ["cart-list-readiness", "conditional-pre-checkout", "checkout-session-create"],
    audiences: buyerAudiences,
    effects: ["checkout-confirmation", "order", "payment", "inventory-reservation"],
    states: ["no-side-effect", "confirmation-recorded", "downstream-pending"],
    sourceFacts: ["readiness-snapshot", "checkout-confirmation", "support-safe-reference"],
    lookupStarts: ["readiness-snapshot-version", "checkout-confirmation-id", "support-safe-reference"],
    boundary: "before-checkout",
    idempotencyKeyShape: "checkout:fulfillment_optimization:<readiness-version>:<accepted-or-declined>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: false,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Optional savings prompts happen before checkout. Reconciliation records only the accepted/declined readiness decision and rejects checkout-time re-optimization or hidden allocation repair.",
  }),
  reconciliationPolicy({
    control: "checkout-confirmation-handoff-ledger",
    docLabel: "Checkout confirmation handoff ledger",
    ownerIssues: ["#1130", "#1120", "#1135", "#1114", "#1115"],
    ownerContext: "Checkout",
    checkpoints: ["confirmation-handoff-recorded", "customer-reload", "background-retry"],
    audiences: allCustomerAudiences,
    effects: ["checkout-confirmation", "marketplace-handoff", "payment", "order", "label", "payout", "notification"],
    states: ["confirmation-recorded", "downstream-pending", "downstream-failed", "recovered"],
    sourceFacts: ["checkout-confirmation", "payment-handoff", "marketplace-handoff", "support-safe-reference"],
    lookupStarts: [
      "checkout-confirmation-id",
      "seller-confirmation-id",
      "payment-handoff-id",
      "marketplace-handoff-id",
      "support-safe-reference",
    ],
    boundary: "checkout-confirmation",
    idempotencyKeyShape: "checkout:confirmation:<confirmation-id>:handoff",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: true,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Checkout confirmation is a ledger boundary that records the source, readiness version, handoff ids, downstream status, and support-safe reference without claiming downstream owner completion.",
  }),
  reconciliationPolicy({
    control: "payment-capture-and-fee-reconciliation",
    docLabel: "Payment capture and fee reconciliation",
    ownerIssues: ["#1130", "#1128", "#1124", "#1134", "#1165"],
    ownerContext: "Payments",
    checkpoints: ["provider-callback", "redirect-return", "background-retry", "operator-recovery"],
    audiences: buyerAudiences,
    effects: ["payment", "refund", "void", "adjustment"],
    states: ["downstream-pending", "downstream-committed", "downstream-failed", "recovered", "reversed", "held"],
    sourceFacts: ["payment-handoff", "provider-callback", "payments-payment", "support-safe-reference"],
    lookupStarts: ["payment-handoff-id", "provider-callback-id", "payment-id", "support-safe-reference"],
    boundary: "post-confirmation",
    idempotencyKeyShape: "payments:payment:<payment-id-or-intent>:<status>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: true,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Payment, marketplace checkout fee, provider callback, refund, void, and adjustment state comes from Payments facts and can be retried or replayed without duplicate charges or synthetic payment completion.",
  }),
  reconciliationPolicy({
    control: "order-creation-and-split-group-reconciliation",
    docLabel: "Order creation and split-group reconciliation",
    ownerIssues: ["#1130", "#1135", "#1164", "#1119", "#1128"],
    ownerContext: "Ordering",
    checkpoints: ["confirmation-handoff-recorded", "background-retry", "downstream-owner-commit", "operator-recovery"],
    audiences: buyerAudiences,
    effects: ["order", "inventory-reservation", "account-history", "notification"],
    states: ["downstream-pending", "downstream-committed", "downstream-failed", "recovered", "reversed"],
    sourceFacts: ["checkout-confirmation", "payment-handoff", "ordering-order", "support-safe-reference"],
    lookupStarts: ["checkout-confirmation-id", "order-or-group-id", "support-safe-reference"],
    boundary: "post-confirmation",
    idempotencyKeyShape: "ordering:order:<order-or-group-id>:<status>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: true,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "A single customer confirmation may create multiple internal order or fulfillment groups, but reconciliation tracks each group from Ordering facts and cannot duplicate customer money movement or communication.",
  }),
  reconciliationPolicy({
    control: "seller-marketplace-handoff-reconciliation",
    docLabel: "Seller Marketplace handoff reconciliation",
    ownerIssues: ["#1130", "#1120", "#1135", "#1119", "#1165"],
    ownerContext: "Marketplace",
    checkpoints: ["confirmation-handoff-recorded", "background-retry", "downstream-owner-commit", "operator-recovery"],
    audiences: sellerAudiences,
    effects: ["checkout-confirmation", "marketplace-handoff", "label", "payout", "settlement", "account-history"],
    states: ["confirmation-recorded", "downstream-pending", "downstream-committed", "downstream-failed", "recovered"],
    sourceFacts: ["checkout-confirmation", "readiness-snapshot", "marketplace-handoff", "support-safe-reference"],
    lookupStarts: [
      "seller-confirmation-id",
      "readiness-snapshot-version",
      "reviewed-line-action-key",
      "marketplace-handoff-id",
      "support-safe-reference",
    ],
    boundary: "post-confirmation",
    idempotencyKeyShape: "marketplace:seller_handoff:<handoff-id-or-action-key>:<status>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: true,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Seller confirmations reconcile from current confirmation, reviewed line/action keys, and Marketplace handoff facts; old sell execution ids or receipt rows cannot become sources of truth.",
  }),
  reconciliationPolicy({
    control: "label-and-fulfillment-reconciliation",
    docLabel: "Label and fulfillment reconciliation",
    ownerIssues: ["#1130", "#1135", "#1164", "#1127", "#1165"],
    ownerContext: "Fulfillment",
    checkpoints: ["downstream-owner-commit", "background-retry", "operator-recovery", "owner-rule"],
    audiences: sellerAudiences,
    effects: ["label", "inventory-reservation", "notification", "account-history", "reversal"],
    states: ["downstream-pending", "downstream-committed", "downstream-failed", "recovered", "reversed", "deferred"],
    sourceFacts: ["checkout-confirmation", "fulfillment-label", "support-safe-reference", "owner-rule"],
    lookupStarts: ["seller-confirmation-id", "label-id", "support-safe-reference", "owner-rule-reference"],
    boundary: "post-confirmation",
    idempotencyKeyShape: "fulfillment:label:<label-id-or-shipment-id>:<status>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: true,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Fulfillment label creation, retry, cancellation, and deferred states reconcile only from Fulfillment facts or support-safe pending records; Checkout never fabricates a label or assignment.",
  }),
  reconciliationPolicy({
    control: "payout-and-settlement-reconciliation",
    docLabel: "Payout and settlement reconciliation",
    ownerIssues: ["#1130", "#1113", "#1121", "#1124", "#1135", "#1165"],
    ownerContext: "Settlement",
    checkpoints: ["downstream-owner-commit", "provider-callback", "background-retry", "operator-recovery"],
    audiences: sellerAudiences,
    effects: ["payout", "settlement", "reversal", "adjustment", "account-history", "notification"],
    states: ["downstream-pending", "downstream-committed", "downstream-failed", "recovered", "held", "reversed"],
    sourceFacts: ["checkout-confirmation", "settlement-payout-or-hold", "support-safe-reference", "provider-callback"],
    lookupStarts: ["seller-confirmation-id", "payout-or-hold-id", "settlement-id", "support-safe-reference"],
    boundary: "post-confirmation",
    idempotencyKeyShape: "settlement:payout:<payout-or-hold-id>:<status>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: true,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Payout setup, settlement, holds, reversals, and adjustment state comes from Settlement facts and provider-safe references without exposing bank data or duplicate payout attempts.",
  }),
  reconciliationPolicy({
    control: "notification-delivery-reconciliation",
    docLabel: "Notification delivery reconciliation",
    ownerIssues: ["#1130", "#1129", "#1122", "#1114"],
    ownerContext: "Notifications",
    checkpoints: ["downstream-owner-commit", "background-retry", "operator-recovery"],
    audiences: allCustomerAudiences,
    effects: ["notification", "support", "account-history"],
    states: ["downstream-pending", "downstream-committed", "downstream-failed", "recovered", "duplicate-suppressed"],
    sourceFacts: ["notification-message", "support-safe-reference", "checkout-confirmation"],
    lookupStarts: ["notification-id", "checkout-confirmation-id", "support-safe-reference"],
    boundary: "post-confirmation",
    idempotencyKeyShape: "notifications:message:<message-id-or-source-id>:<status>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: true,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Notification send, retry, failure, suppression, and support fallback use Notifications outbox/source-owner idempotency and cannot claim an order, sale, label, payout, or refund is complete.",
  }),
  reconciliationPolicy({
    control: "account-history-reconciliation",
    docLabel: "Account history reconciliation",
    ownerIssues: ["#1130", "#1135", "#1120", "#1122"],
    ownerContext: "Account History",
    checkpoints: ["confirmation-handoff-recorded", "downstream-owner-commit", "background-retry", "customer-reload"],
    audiences: allCustomerAudiences,
    effects: ["account-history", "checkout-confirmation", "order", "label", "payout", "settlement", "support"],
    states: ["confirmation-recorded", "downstream-pending", "downstream-committed", "downstream-failed", "recovered"],
    sourceFacts: ["checkout-confirmation", "account-history-record", "support-safe-reference"],
    lookupStarts: ["checkout-confirmation-id", "account-history-id", "support-safe-reference"],
    boundary: "post-confirmation",
    idempotencyKeyShape: "account-history:record:<record-id-or-source-ref>:<status>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: true,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Account history can show Checkout confirmation and pending activity, but committed order, sale, fulfillment, payout, settlement, notification, support, or reversal rows require owning-context records.",
  }),
  reconciliationPolicy({
    control: "duplicate-submit-and-retry-idempotency",
    docLabel: "Duplicate submit and retry idempotency",
    ownerIssues: ["#1130", "#1131", "#1115", "#1118", "#1119"],
    ownerContext: "Checkout",
    checkpoints: ["duplicate-submit", "customer-reload", "redirect-return", "background-retry", "operator-recovery"],
    audiences: allCustomerAudiences,
    effects: [
      "checkout-confirmation",
      "payment",
      "order",
      "marketplace-handoff",
      "label",
      "payout",
      "settlement",
      "notification",
      "account-history",
      "refund",
      "void",
      "reversal",
    ],
    states: ["duplicate-suppressed", "recovered", "downstream-pending", "downstream-committed"],
    sourceFacts: [
      "checkout-confirmation",
      "payment-handoff",
      "payments-payment",
      "ordering-order",
      "fulfillment-label",
      "settlement-payout-or-hold",
      "notification-message",
      "account-history-record",
      "support-safe-reference",
      "provider-callback",
    ],
    lookupStarts: ["checkout-confirmation-id", "payment-handoff-id", "provider-callback-id", "support-safe-reference"],
    boundary: "checkout-confirmation",
    idempotencyKeyShape: "checkout:reconciliation:<confirmation-or-source-id>:<purpose>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: true,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Reload, duplicate submit, redirect return, background retry, and operator recovery reuse stable idempotency keys and return the existing current state instead of creating duplicate side effects.",
  }),
  reconciliationPolicy({
    control: "provider-webhook-replay-reconciliation",
    docLabel: "Provider webhook replay reconciliation",
    ownerIssues: ["#1130", "#1134", "#1124", "#1114", "#1165"],
    ownerContext: "Payments",
    checkpoints: ["provider-callback", "background-retry", "operator-recovery"],
    audiences: allCustomerAudiences,
    effects: ["payment", "payout", "settlement", "refund", "void", "reversal", "adjustment", "notification"],
    states: ["duplicate-suppressed", "downstream-pending", "downstream-committed", "downstream-failed", "recovered"],
    sourceFacts: ["provider-callback", "payments-payment", "settlement-payout-or-hold", "support-safe-reference"],
    lookupStarts: ["provider-callback-id", "payment-id", "payout-or-hold-id", "support-safe-reference"],
    boundary: "post-confirmation",
    idempotencyKeyShape: "provider:<provider-event-id>:<event-type>:<owning-context>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: true,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Provider callback replay is signature-checked, metadata-correlated, redacted, and idempotent; missed or delayed callbacks reconcile from owning Payments or Settlement facts.",
  }),
  reconciliationPolicy({
    control: "operator-recovery-reconciliation",
    docLabel: "Operator recovery reconciliation",
    ownerIssues: ["#1130", "#1122", "#1114", "#1124"],
    ownerContext: "Support",
    checkpoints: ["operator-recovery", "owner-rule"],
    audiences: ["support-operator"],
    effects: [
      "support",
      "payment",
      "order",
      "label",
      "payout",
      "settlement",
      "notification",
      "account-history",
      "refund",
      "void",
      "reversal",
      "adjustment",
    ],
    states: ["downstream-pending", "downstream-failed", "recovered", "held", "deferred", "unsupported"],
    sourceFacts: ["support-safe-reference", "checkout-confirmation", "owner-rule"],
    lookupStarts: ["support-safe-reference", "checkout-confirmation-id", "owner-rule-reference"],
    boundary: "operator-support",
    idempotencyKeyShape: "support:reconciliation:<support-safe-reference>:<status-or-action>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: true,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Operator recovery starts from support-safe references, shows owner and next action, audits every recovery command, and does not instruct support to edit data or infer completion.",
  }),
  reconciliationPolicy({
    control: "refund-void-reversal-adjustment-reconciliation",
    docLabel: "Refund, void, reversal, and adjustment reconciliation",
    ownerIssues: ["#1130", "#1165", "#1128", "#1129", "#1122", "#1124"],
    ownerContext: "Payments",
    checkpoints: ["provider-callback", "downstream-owner-commit", "background-retry", "operator-recovery"],
    audiences: allCustomerAudiences,
    effects: ["refund", "void", "reversal", "adjustment", "payment", "order", "label", "payout", "settlement"],
    states: ["downstream-pending", "downstream-committed", "downstream-failed", "recovered", "held", "reversed"],
    sourceFacts: ["payments-payment", "provider-callback", "settlement-payout-or-hold", "support-safe-reference"],
    lookupStarts: ["payment-id", "provider-callback-id", "payout-or-hold-id", "support-safe-reference"],
    boundary: "post-confirmation",
    idempotencyKeyShape: "payments:reversal:<payment-or-order-ref>:<effect-kind>:<effect-id>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: true,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Refunds, voids, reversals, label cancellations, payout holds, fee/tax/credit adjustments, and notification updates are idempotent and link to #1165 owner facts or owner-rule deferrals.",
  }),
  reconciliationPolicy({
    control: "pending-downstream-boundary",
    docLabel: "Pending downstream boundary",
    ownerIssues: ["#1130", "#1135", "#1120", "#1102", "#1112"],
    ownerContext: "Checkout",
    checkpoints: ["confirmation-handoff-recorded", "customer-reload", "background-retry", "owner-rule"],
    audiences: allCustomerAudiences,
    effects: ["checkout-confirmation", "order", "label", "payout", "settlement", "notification", "account-history"],
    states: ["confirmation-recorded", "downstream-not-created-yet", "downstream-pending", "downstream-failed"],
    sourceFacts: ["checkout-confirmation", "support-safe-reference", "owner-rule"],
    lookupStarts: ["checkout-confirmation-id", "seller-confirmation-id", "support-safe-reference"],
    boundary: "post-confirmation",
    idempotencyKeyShape: "checkout:pending_downstream:<confirmation-id>:<owner-context>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: true,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Checkout may explain confirmation recorded and downstream pending, delayed, failed, deferred, or owner-action-required states, but it cannot synthesize completed downstream facts.",
  }),
  reconciliationPolicy({
    control: "support-safe-reconciliation-lookup",
    docLabel: "Support-safe reconciliation lookup",
    ownerIssues: ["#1130", "#1122", "#1114", "#1124", "#1135"],
    ownerContext: "Support",
    checkpoints: ["operator-recovery", "customer-reload", "background-retry"],
    audiences: ["support-operator"],
    effects: [
      "checkout-confirmation",
      "payment",
      "order",
      "marketplace-handoff",
      "label",
      "payout",
      "settlement",
      "notification",
      "account-history",
      "refund",
      "void",
      "reversal",
    ],
    states: [
      "no-side-effect",
      "confirmation-recorded",
      "downstream-not-created-yet",
      "downstream-pending",
      "downstream-committed",
      "downstream-failed",
      "recovered",
      "held",
      "reversed",
    ],
    sourceFacts: [
      "checkout-confirmation",
      "payments-payment",
      "ordering-order",
      "fulfillment-label",
      "settlement-payout-or-hold",
      "notification-message",
      "account-history-record",
      "support-safe-reference",
    ],
    lookupStarts: [
      "checkout-confirmation-id",
      "support-safe-reference",
      "payment-id",
      "order-or-group-id",
      "marketplace-handoff-id",
      "label-id",
      "payout-or-hold-id",
      "notification-id",
      "account-history-id",
    ],
    boundary: "operator-support",
    idempotencyKeyShape: "support:reconciliation_lookup:<support-safe-reference>:<requested-scope>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: true,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Support lookup can start from any customer-safe reference and resolve the current owner/status while masking provider payloads, address detail, card data, bank data, and raw risk signals.",
  }),
  reconciliationPolicy({
    control: "owner-rule-reconciliation-states",
    docLabel: "Owner rule reconciliation states",
    ownerIssues: ["#1130", "#1102", "#1112", "#1114", "#1115", "#1122", "#1124"],
    ownerContext: "Platform",
    checkpoints: ["owner-rule", "operator-recovery"],
    audiences: allAudiences,
    effects: [
      "checkout-confirmation",
      "payment",
      "order",
      "label",
      "payout",
      "settlement",
      "notification",
      "account-history",
      "refund",
      "void",
      "reversal",
      "adjustment",
    ],
    states: [
      "no-side-effect",
      "downstream-not-created-yet",
      "downstream-failed",
      "held",
      "deferred",
      "disabled",
      "unsupported",
      "provider-outage",
      "stale-active-session",
    ],
    sourceFacts: ["owner-rule", "support-safe-reference"],
    lookupStarts: ["owner-rule-reference", "support-safe-reference"],
    boundary: "operations-status",
    idempotencyKeyShape: "owner-rule:reconciliation:<capability>:<state>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: true,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Disabled, deferred, unsupported, provider-outage, stale active-session, split-group, pending downstream, missing downstream, notification failure, support lookup, refund, void, reversal, adjustment, and no-side-effect states require owner rules.",
  }),
  reconciliationPolicy({
    control: "observability-redaction",
    docLabel: "Observability redaction",
    ownerIssues: ["#1130", "#1114", "#1124", "#1122"],
    ownerContext: "Checkout",
    checkpoints: [
      "cart-list-readiness",
      "confirmation-handoff-recorded",
      "provider-callback",
      "background-retry",
      "operator-recovery",
    ],
    audiences: allAudiences,
    effects: [
      "checkout-confirmation",
      "payment",
      "order",
      "label",
      "payout",
      "settlement",
      "notification",
      "account-history",
      "refund",
      "void",
      "reversal",
    ],
    states: [
      "no-side-effect",
      "confirmation-recorded",
      "downstream-pending",
      "downstream-committed",
      "downstream-failed",
      "duplicate-suppressed",
      "recovered",
    ],
    sourceFacts: [
      "support-safe-reference",
      "checkout-confirmation",
      "payments-payment",
      "ordering-order",
      "fulfillment-label",
      "settlement-payout-or-hold",
      "notification-message",
      "account-history-record",
    ],
    lookupStarts: ["checkout-confirmation-id", "support-safe-reference"],
    boundary: "operations-status",
    idempotencyKeyShape: "checkout:reconciliation_observability:<event-name>:<support-safe-reference>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: true,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Telemetry uses owner, state, effect, idempotency outcome, support-safe reference, and redacted source type only; it never logs raw provider payloads, addresses, cards, banks, or risk signals.",
  }),
  reconciliationPolicy({
    control: "fresh-state-reconciliation-cleanup",
    docLabel: "Fresh-state reconciliation cleanup",
    ownerIssues: ["#1130", "#1124", "#1115"],
    ownerContext: "Platform",
    checkpoints: ["cart-list-readiness", "checkout-session-create", "operator-recovery", "owner-rule"],
    audiences: allAudiences,
    effects: [
      "checkout-confirmation",
      "payment",
      "order",
      "marketplace-handoff",
      "label",
      "payout",
      "settlement",
      "notification",
      "account-history",
      "support",
      "refund",
      "void",
      "reversal",
      "adjustment",
    ],
    states: ["no-side-effect", "disabled", "unsupported", "deferred"],
    sourceFacts: ["owner-rule", "support-safe-reference", "none-before-confirmation"],
    lookupStarts: ["support-safe-reference", "owner-rule-reference"],
    boundary: "operations-status",
    idempotencyKeyShape: "checkout:reconciliation_fresh_state:<scan-or-route-id>:<result>",
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    pendingDownstreamBoundaryRequired: false,
    duplicatePreventionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    rejectsSyntheticCompletion: true,
    redactsProviderAndPaymentData: true,
    forbiddenSources: checkoutReconciliationForbiddenSources,
    customerSafeOutcome:
      "Fresh-state scans show stale fixtures, cached read models, provider sandbox leftovers, dual writes, migration/backfill helpers, old receipt fallback reads, old session payloads, manual database repair, and dense checkout fallback cannot make reconciliation succeed.",
  }),
] as const satisfies readonly CheckoutReconciliationPolicyEntry[];

export function assertCheckoutReconciliationPolicyCoverage(): void {
  const byControl = new Map(checkoutReconciliationPolicyEntries.map((entry) => [entry.control, entry]));

  for (const control of checkoutReconciliationRequiredControls) {
    if (!byControl.has(control)) {
      throw new Error(`Missing checkout reconciliation policy for '${control}'.`);
    }
  }

  if (byControl.size !== checkoutReconciliationPolicyEntries.length) {
    throw new Error("Checkout reconciliation policy controls must be unique.");
  }

  for (const entry of checkoutReconciliationPolicyEntries) {
    if (!entry.ownerIssues.includes("#1130")) {
      throw new Error(`Checkout reconciliation policy '${entry.control}' must include #1130.`);
    }
    if (entry.docLabel.trim().length === 0 || entry.customerSafeOutcome.trim().length === 0) {
      throw new Error(`Checkout reconciliation policy '${entry.control}' needs documentation text.`);
    }
    if (
      entry.audiences.length === 0 ||
      entry.checkpoints.length === 0 ||
      entry.effects.length === 0 ||
      entry.states.length === 0 ||
      entry.sourceFacts.length === 0 ||
      entry.lookupStarts.length === 0
    ) {
      throw new Error(`Checkout reconciliation policy '${entry.control}' needs complete coverage fields.`);
    }
    if (entry.duplicatePreventionRequired && entry.idempotencyKeyShape.trim().length === 0) {
      throw new Error(`Checkout reconciliation policy '${entry.control}' needs an idempotency key shape.`);
    }
    if (!entry.observabilityRequired || !entry.redactsProviderAndPaymentData) {
      throw new Error(`Checkout reconciliation policy '${entry.control}' must require redacted observability.`);
    }
    if (!entry.rejectsSyntheticCompletion) {
      throw new Error(`Checkout reconciliation policy '${entry.control}' must reject synthetic completion.`);
    }
    if (
      entry.states.some((state) => checkoutReconciliationOwnerRuleStates.includes(state)) &&
      (!entry.ownerRuleRequired || !entry.supportReferenceRequired)
    ) {
      throw new Error(
        `Checkout reconciliation policy '${entry.control}' must define owner rules for customer-impacting states.`,
      );
    }
    if (entry.pendingDownstreamBoundaryRequired && !entry.supportReferenceRequired) {
      throw new Error(`Checkout reconciliation policy '${entry.control}' needs support-safe pending lookup.`);
    }
    if (entry.states.includes("downstream-committed") && !entry.sourceFacts.some(isOwningContextSourceFact)) {
      throw new Error(
        `Checkout reconciliation policy '${entry.control}' cannot mark downstream committed without owning facts.`,
      );
    }
    if (
      (entry.ownerContext === "Payments" || entry.ownerContext === "Settlement") &&
      !entry.ownerIssues.includes("#1124")
    ) {
      throw new Error(`Checkout reconciliation policy '${entry.control}' needs #1124 for money-sensitive facts.`);
    }
    for (const forbiddenSource of checkoutReconciliationForbiddenSources) {
      if (!entry.forbiddenSources.includes(forbiddenSource)) {
        throw new Error(`Checkout reconciliation policy '${entry.control}' must forbid '${forbiddenSource}'.`);
      }
    }
  }

  for (const control of [
    "unassigned-fulfillment-readiness-reconciliation",
    "optional-fulfillment-optimization-reconciliation",
  ] as const satisfies readonly CheckoutReconciliationControlKey[]) {
    const entry = byControl.get(control);
    if (entry?.boundary !== "before-checkout" || entry?.checkpoints.includes("confirmation-handoff-recorded")) {
      throw new Error(`Checkout reconciliation policy '${control}' must stay before checkout confirmation.`);
    }
  }

  for (const effect of [
    "payment",
    "order",
    "label",
    "payout",
    "settlement",
    "notification",
    "account-history",
  ] as const satisfies readonly CheckoutReconciliationEffect[]) {
    if (!checkoutReconciliationPolicyEntries.some((entry) => entry.effects.includes(effect))) {
      throw new Error(`Checkout reconciliation policy must cover '${effect}'.`);
    }
  }
}

function isOwningContextSourceFact(sourceFact: CheckoutReconciliationSourceFact): boolean {
  return [
    "payments-payment",
    "ordering-order",
    "fulfillment-label",
    "settlement-payout-or-hold",
    "notification-message",
    "account-history-record",
    "marketplace-handoff",
  ].includes(sourceFact);
}

function reconciliationPolicy(input: CheckoutReconciliationPolicyEntry): CheckoutReconciliationPolicyEntry {
  return input;
}
