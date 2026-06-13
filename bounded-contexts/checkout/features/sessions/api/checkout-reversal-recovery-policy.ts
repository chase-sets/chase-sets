export const checkoutReversalRecoveryPolicyDocPath =
  "bounded-contexts/checkout/docs/checkout-reversal-recovery-policy.md" as const;

export type CheckoutReversalAudience =
  | "guest-buyer"
  | "signed-in-buyer"
  | "guest-seller"
  | "signed-in-seller"
  | "support-operator";

export type CheckoutReversalOwnerContext =
  | "Checkout"
  | "Ordering"
  | "Payments"
  | "Fulfillment"
  | "Settlement"
  | "Notifications"
  | "Account History"
  | "Support"
  | "Platform";

export type CheckoutReversalCheckpoint =
  | "pre-confirmation"
  | "checkout-confirmation-recorded"
  | "payment-authorized"
  | "payment-captured"
  | "order-committed"
  | "seller-confirmation-recorded"
  | "marketplace-handoff-recorded"
  | "shipment-or-label-committed"
  | "payout-or-settlement-committed"
  | "provider-callback"
  | "duplicate-submit"
  | "background-retry"
  | "operator-recovery"
  | "launch-decision";

export type CheckoutReversalEffect =
  | "no-side-effect"
  | "payment-void"
  | "payment-refund"
  | "order-cancel"
  | "inventory-release"
  | "label-cancel"
  | "label-refund"
  | "payout-hold"
  | "payout-reversal"
  | "settlement-adjustment"
  | "tax-fee-credit-adjustment"
  | "notification-correction"
  | "account-history-correction"
  | "dispute-hold"
  | "support-review";

export type CheckoutReversalState =
  | "supported"
  | "support-only"
  | "disabled"
  | "deferred"
  | "unsupported"
  | "provider-outage"
  | "webhook-delayed"
  | "pending"
  | "committed"
  | "failed"
  | "recovered"
  | "held"
  | "duplicate-suppressed"
  | "partial"
  | "no-side-effect";

export type CheckoutReversalSourceFact =
  | "checkout-confirmation"
  | "checkout-seller-activity"
  | "readiness-snapshot"
  | "payments-authorization"
  | "payments-capture"
  | "payments-void"
  | "payments-refund"
  | "payments-dispute"
  | "ordering-order"
  | "ordering-cancellation"
  | "fulfillment-shipment"
  | "fulfillment-label"
  | "fulfillment-label-refund"
  | "settlement-hold"
  | "settlement-payout"
  | "settlement-reversal"
  | "notification-message"
  | "account-history-record"
  | "support-request"
  | "provider-callback"
  | "launch-decision-row"
  | "none-before-commit";

export type CheckoutReversalOwnerIssue =
  | "#1102"
  | "#1112"
  | "#1114"
  | "#1115"
  | "#1118"
  | "#1119"
  | "#1120"
  | "#1122"
  | "#1123"
  | "#1124"
  | "#1128"
  | "#1129"
  | "#1130"
  | "#1131"
  | "#1134"
  | "#1135"
  | "#1164"
  | "#1165";

export type CheckoutReversalControlKey =
  | "pre-confirmation-cancel-no-side-effect"
  | "payment-authorization-void-after-order-failure"
  | "captured-payment-refund-after-commit-failure"
  | "self-service-buy-cancellation-window"
  | "post-cutoff-support-cancel-request"
  | "inventory-reservation-release"
  | "tax-fee-credit-adjustment"
  | "seller-pending-handoff-no-fake-reversal"
  | "label-cancellation-and-refund"
  | "payout-hold-and-reversal"
  | "settlement-reversal-and-wallet-adjustment"
  | "notification-and-account-history-correction"
  | "duplicate-reversal-prevention"
  | "provider-replay-and-webhook-reconciliation"
  | "support-approved-operator-recovery"
  | "return-dispute-chargeback-launch-posture"
  | "launch-decision-reversal-states"
  | "observability-redaction"
  | "fresh-state-reversal-cleanup";

export type CheckoutReversalPolicyEntry = Readonly<{
  control: CheckoutReversalControlKey;
  docLabel: string;
  ownerIssues: readonly CheckoutReversalOwnerIssue[];
  ownerContext: CheckoutReversalOwnerContext;
  checkpoints: readonly CheckoutReversalCheckpoint[];
  audiences: readonly CheckoutReversalAudience[];
  states: readonly CheckoutReversalState[];
  effects: readonly CheckoutReversalEffect[];
  sourceFacts: readonly CheckoutReversalSourceFact[];
  idempotencyKeyShape: string;
  customerVisible: boolean;
  supportReferenceRequired: boolean;
  auditRequired: boolean;
  observabilityRequired: boolean;
  launchDecisionRequired: boolean;
  owningFactRequiredBeforeAction: boolean;
  duplicatePreventionRequired: boolean;
  redactsSensitiveData: boolean;
  noLegacyCompatibility: boolean;
  forbiddenSources: readonly string[];
  evidenceExpectation: string;
}>;

const buyerAudiences = ["guest-buyer", "signed-in-buyer"] as const satisfies readonly CheckoutReversalAudience[];
const sellerAudiences = ["guest-seller", "signed-in-seller"] as const satisfies readonly CheckoutReversalAudience[];
const allCustomerAudiences = [
  "guest-buyer",
  "signed-in-buyer",
  "guest-seller",
  "signed-in-seller",
] as const satisfies readonly CheckoutReversalAudience[];
const allAudiences = [
  "guest-buyer",
  "signed-in-buyer",
  "guest-seller",
  "signed-in-seller",
  "support-operator",
] as const satisfies readonly CheckoutReversalAudience[];

export const checkoutReversalForbiddenSources = [
  "old checkout route",
  "old checkout payload adapter",
  "old session payload repair",
  "old sell execution id",
  "old receipt row",
  "migration/backfill helper",
  "dual-write compatibility",
  "hidden repair",
  "manual database edit",
  "stale fixture bypass",
  "stale cached read model",
  "provider-dashboard-only recovery",
  "dense checkout fallback",
  "raw provider payload exposure",
  "card or bank data exposure",
  "synthetic downstream completion",
] as const;

export const checkoutReversalRequiredControls = [
  "pre-confirmation-cancel-no-side-effect",
  "payment-authorization-void-after-order-failure",
  "captured-payment-refund-after-commit-failure",
  "self-service-buy-cancellation-window",
  "post-cutoff-support-cancel-request",
  "inventory-reservation-release",
  "tax-fee-credit-adjustment",
  "seller-pending-handoff-no-fake-reversal",
  "label-cancellation-and-refund",
  "payout-hold-and-reversal",
  "settlement-reversal-and-wallet-adjustment",
  "notification-and-account-history-correction",
  "duplicate-reversal-prevention",
  "provider-replay-and-webhook-reconciliation",
  "support-approved-operator-recovery",
  "return-dispute-chargeback-launch-posture",
  "launch-decision-reversal-states",
  "observability-redaction",
  "fresh-state-reversal-cleanup",
] as const satisfies readonly CheckoutReversalControlKey[];

export const checkoutReversalLaunchRegisterStates: readonly CheckoutReversalState[] = [
  "support-only",
  "disabled",
  "deferred",
  "unsupported",
  "provider-outage",
  "webhook-delayed",
  "failed",
  "held",
  "partial",
] as const;

export const checkoutReversalPolicyEntries = [
  reversalPolicy({
    control: "pre-confirmation-cancel-no-side-effect",
    docLabel: "Pre-confirmation cancel no-side-effect",
    ownerIssues: ["#1165", "#1118", "#1119", "#1130"],
    ownerContext: "Checkout",
    checkpoints: ["pre-confirmation", "duplicate-submit"],
    audiences: allCustomerAudiences,
    states: ["supported", "no-side-effect"],
    effects: ["no-side-effect"],
    sourceFacts: ["readiness-snapshot", "none-before-commit"],
    idempotencyKeyShape: "checkout:cancel_pre_confirmation:<source-ref>:<readiness-version>",
    customerVisible: true,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: false,
    owningFactRequiredBeforeAction: false,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "Before confirmation, cancellation is simply returning to cart/list/readiness recovery with proof that no payment, order, label, payout, settlement, notification, support, refund, void, reversal, or adjustment side effect exists.",
  }),
  reversalPolicy({
    control: "payment-authorization-void-after-order-failure",
    docLabel: "Payment authorization void after order failure",
    ownerIssues: ["#1165", "#1130", "#1134", "#1124", "#1122"],
    ownerContext: "Payments",
    checkpoints: ["payment-authorized", "provider-callback", "background-retry", "operator-recovery"],
    audiences: buyerAudiences,
    states: ["supported", "pending", "committed", "failed", "webhook-delayed", "duplicate-suppressed"],
    effects: ["payment-void", "notification-correction", "account-history-correction"],
    sourceFacts: ["payments-authorization", "payments-void", "provider-callback", "support-request"],
    idempotencyKeyShape: "payments:void:<payment-authorization-id>:<order-failure-ref>",
    customerVisible: true,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    owningFactRequiredBeforeAction: true,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "If authorization exists but order creation fails before capture, Payments owns an idempotent void or provider-delayed void state; Checkout cannot create an order or refund substitute.",
  }),
  reversalPolicy({
    control: "captured-payment-refund-after-commit-failure",
    docLabel: "Captured payment refund after commit failure",
    ownerIssues: ["#1165", "#1130", "#1128", "#1124", "#1122", "#1129"],
    ownerContext: "Payments",
    checkpoints: ["payment-captured", "order-committed", "provider-callback", "operator-recovery"],
    audiences: buyerAudiences,
    states: ["supported", "pending", "committed", "failed", "partial", "webhook-delayed", "duplicate-suppressed"],
    effects: ["payment-refund", "tax-fee-credit-adjustment", "notification-correction", "account-history-correction"],
    sourceFacts: ["payments-capture", "payments-refund", "ordering-order", "provider-callback", "support-request"],
    idempotencyKeyShape: "payments:refund:<payment-capture-id>:<refund-effect-id>",
    customerVisible: true,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    owningFactRequiredBeforeAction: true,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "Captured payment recovery uses Payments-owned refund facts and refund-effect idempotency; partial, delayed, or failed refunds stay support-visible and cannot be hidden by checkout repair.",
  }),
  reversalPolicy({
    control: "self-service-buy-cancellation-window",
    docLabel: "Self-service buy cancellation window",
    ownerIssues: ["#1165", "#1120", "#1135", "#1130", "#1129"],
    ownerContext: "Ordering",
    checkpoints: ["order-committed", "shipment-or-label-committed"],
    audiences: buyerAudiences,
    states: ["supported", "pending", "committed", "duplicate-suppressed"],
    effects: ["order-cancel", "payment-refund", "inventory-release", "notification-correction"],
    sourceFacts: ["ordering-order", "ordering-cancellation", "fulfillment-shipment", "payments-refund"],
    idempotencyKeyShape: "ordering:purchase_cancel:<order-id>:<cancellation-window-version>",
    customerVisible: true,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: false,
    owningFactRequiredBeforeAction: true,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "Buyer self-service cancellation is available only while Ordering and Fulfillment facts show the cancellation window is open; Payments refunds a captured payment idempotently after the Ordering cancellation fact exists.",
  }),
  reversalPolicy({
    control: "post-cutoff-support-cancel-request",
    docLabel: "Post-cutoff support cancel request",
    ownerIssues: ["#1165", "#1122", "#1135", "#1114"],
    ownerContext: "Support",
    checkpoints: ["order-committed", "shipment-or-label-committed", "operator-recovery", "launch-decision"],
    audiences: [...buyerAudiences, "support-operator"],
    states: ["support-only", "pending", "held", "deferred", "recovered"],
    effects: ["support-review", "payment-refund", "notification-correction", "account-history-correction"],
    sourceFacts: ["ordering-order", "fulfillment-shipment", "support-request", "launch-decision-row"],
    idempotencyKeyShape: "support:buyer_cancel_request:<support-request-id>:<resolution>",
    customerVisible: true,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    owningFactRequiredBeforeAction: true,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "After Fulfillment closes the cancellation window, cancellation is Support-owned and may resolve to refund, no action, or review without direct Checkout cancellation or database repair.",
  }),
  reversalPolicy({
    control: "inventory-reservation-release",
    docLabel: "Inventory reservation release",
    ownerIssues: ["#1165", "#1119", "#1130", "#1164"],
    ownerContext: "Ordering",
    checkpoints: ["order-committed", "background-retry", "operator-recovery"],
    audiences: buyerAudiences,
    states: ["supported", "pending", "committed", "failed", "duplicate-suppressed"],
    effects: ["inventory-release", "order-cancel", "account-history-correction"],
    sourceFacts: ["ordering-order", "ordering-cancellation", "support-request"],
    idempotencyKeyShape: "ordering:inventory_release:<order-or-group-id>:<cancellation-id>",
    customerVisible: true,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    owningFactRequiredBeforeAction: true,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "Inventory or reservation release follows Ordering cancellation/group facts and is idempotent per order group; Checkout does not release inventory from stale session data.",
  }),
  reversalPolicy({
    control: "tax-fee-credit-adjustment",
    docLabel: "Tax, fee, and credit adjustment",
    ownerIssues: ["#1165", "#1128", "#1124", "#1130"],
    ownerContext: "Payments",
    checkpoints: ["payment-captured", "order-committed", "provider-callback", "operator-recovery"],
    audiences: buyerAudiences,
    states: ["supported", "pending", "committed", "failed", "partial", "deferred"],
    effects: ["tax-fee-credit-adjustment", "payment-refund", "settlement-adjustment"],
    sourceFacts: [
      "payments-capture",
      "payments-refund",
      "ordering-order",
      "settlement-reversal",
      "launch-decision-row",
    ],
    idempotencyKeyShape: "payments:adjustment:<order-or-payment-ref>:<component>:<effect-id>",
    customerVisible: true,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    owningFactRequiredBeforeAction: true,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "Tax, marketplace fee, wallet credit, promo, gift-card, label-fee, payout, and settlement adjustments link to Payments/Settlement owner facts or a launch-decision deferral.",
  }),
  reversalPolicy({
    control: "seller-pending-handoff-no-fake-reversal",
    docLabel: "Seller pending handoff no fake reversal",
    ownerIssues: ["#1165", "#1135", "#1130", "#1120"],
    ownerContext: "Checkout",
    checkpoints: ["seller-confirmation-recorded", "marketplace-handoff-recorded", "launch-decision"],
    audiences: sellerAudiences,
    states: ["pending", "deferred", "no-side-effect"],
    effects: ["support-review", "no-side-effect"],
    sourceFacts: ["checkout-seller-activity", "checkout-confirmation", "launch-decision-row"],
    idempotencyKeyShape: "checkout:seller_pending_reversal:<confirmation-id>:<downstream-owner>",
    customerVisible: true,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    owningFactRequiredBeforeAction: false,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "When seller activity shows only confirmation or pending handoff, reversal records customer-safe pending/deferred/no-side-effect status and must not create fake label, payout, settlement, notification, or account-history correction facts.",
  }),
  reversalPolicy({
    control: "label-cancellation-and-refund",
    docLabel: "Label cancellation and refund",
    ownerIssues: ["#1165", "#1135", "#1130", "#1122"],
    ownerContext: "Fulfillment",
    checkpoints: ["shipment-or-label-committed", "provider-callback", "background-retry", "operator-recovery"],
    audiences: sellerAudiences,
    states: ["supported", "pending", "committed", "failed", "webhook-delayed", "duplicate-suppressed"],
    effects: ["label-cancel", "label-refund", "notification-correction", "account-history-correction"],
    sourceFacts: ["fulfillment-shipment", "fulfillment-label", "fulfillment-label-refund", "provider-callback"],
    idempotencyKeyShape: "fulfillment:label_cancel:<shipment-or-label-id>:<void-effect-id>",
    customerVisible: true,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    owningFactRequiredBeforeAction: true,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "Label cancellation and postage refund state comes from Fulfillment label/shipment/provider refund facts; failed or delayed provider refund remains support-visible and idempotent.",
  }),
  reversalPolicy({
    control: "payout-hold-and-reversal",
    docLabel: "Payout hold and reversal",
    ownerIssues: ["#1165", "#1130", "#1135", "#1124", "#1122"],
    ownerContext: "Settlement",
    checkpoints: ["payout-or-settlement-committed", "provider-callback", "background-retry", "operator-recovery"],
    audiences: sellerAudiences,
    states: ["supported", "pending", "committed", "failed", "held", "webhook-delayed", "duplicate-suppressed"],
    effects: ["payout-hold", "payout-reversal", "settlement-adjustment", "notification-correction"],
    sourceFacts: ["settlement-hold", "settlement-payout", "settlement-reversal", "provider-callback"],
    idempotencyKeyShape: "settlement:payout_reversal:<payout-or-hold-id>:<reason>",
    customerVisible: true,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    owningFactRequiredBeforeAction: true,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "Payout holds and reversals are Settlement-owned, provider-safe, and idempotent; Checkout cannot bypass payout readiness or expose bank/provider details.",
  }),
  reversalPolicy({
    control: "settlement-reversal-and-wallet-adjustment",
    docLabel: "Settlement reversal and wallet adjustment",
    ownerIssues: ["#1165", "#1128", "#1124", "#1130", "#1122"],
    ownerContext: "Settlement",
    checkpoints: ["payout-or-settlement-committed", "operator-recovery", "provider-callback"],
    audiences: allCustomerAudiences,
    states: ["supported", "pending", "committed", "failed", "partial", "duplicate-suppressed"],
    effects: ["settlement-adjustment", "payout-reversal", "payment-refund", "tax-fee-credit-adjustment"],
    sourceFacts: ["settlement-hold", "settlement-payout", "settlement-reversal", "payments-refund", "support-request"],
    idempotencyKeyShape: "settlement:wallet_adjustment:<wallet-or-ledger-ref>:<effect-id>",
    customerVisible: true,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    owningFactRequiredBeforeAction: true,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "Seller refund debits, dispute holds, hold releases, payout failure reversals, and wallet adjustments are Settlement-owned ledger facts with exactly-once reversal evidence.",
  }),
  reversalPolicy({
    control: "notification-and-account-history-correction",
    docLabel: "Notification and account-history correction",
    ownerIssues: ["#1165", "#1129", "#1135", "#1130", "#1102", "#1112"],
    ownerContext: "Notifications",
    checkpoints: [
      "order-committed",
      "shipment-or-label-committed",
      "payout-or-settlement-committed",
      "background-retry",
    ],
    audiences: allCustomerAudiences,
    states: ["supported", "pending", "committed", "failed", "duplicate-suppressed"],
    effects: ["notification-correction", "account-history-correction", "support-review"],
    sourceFacts: ["notification-message", "account-history-record", "support-request"],
    idempotencyKeyShape: "notifications:reversal_correction:<source-owner>:<source-id>:<status>",
    customerVisible: true,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    owningFactRequiredBeforeAction: true,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "Cancellation, refund, void, reversal, adjustment, label-canceled, payout-held, and payout-reversed copy appears in notifications and account history only after the owning fact exists.",
  }),
  reversalPolicy({
    control: "duplicate-reversal-prevention",
    docLabel: "Duplicate reversal prevention",
    ownerIssues: ["#1165", "#1130", "#1131", "#1115"],
    ownerContext: "Checkout",
    checkpoints: ["duplicate-submit", "background-retry", "provider-callback", "operator-recovery"],
    audiences: allAudiences,
    states: ["supported", "duplicate-suppressed", "recovered", "pending", "committed"],
    effects: [
      "payment-void",
      "payment-refund",
      "order-cancel",
      "label-cancel",
      "payout-reversal",
      "settlement-adjustment",
    ],
    sourceFacts: ["checkout-confirmation", "payments-refund", "ordering-cancellation", "settlement-reversal"],
    idempotencyKeyShape: "<owner-context>:reversal:<source-ref>:<effect-kind>:<effect-id>",
    customerVisible: false,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: false,
    owningFactRequiredBeforeAction: true,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "Duplicate customer action, provider replay, background retry, and operator retry all resolve to the same owner effect id without duplicate refunds, voids, labels, holds, payouts, notifications, or account-history rows.",
  }),
  reversalPolicy({
    control: "provider-replay-and-webhook-reconciliation",
    docLabel: "Provider replay and webhook reconciliation",
    ownerIssues: ["#1165", "#1134", "#1130", "#1124", "#1114"],
    ownerContext: "Payments",
    checkpoints: ["provider-callback", "background-retry", "operator-recovery"],
    audiences: allAudiences,
    states: ["supported", "webhook-delayed", "failed", "recovered", "duplicate-suppressed"],
    effects: ["payment-void", "payment-refund", "label-refund", "payout-reversal", "dispute-hold"],
    sourceFacts: ["provider-callback", "payments-refund", "payments-dispute", "fulfillment-label-refund"],
    idempotencyKeyShape: "provider:<provider-event-id>:<effect-kind>:<owner-context>",
    customerVisible: false,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    owningFactRequiredBeforeAction: true,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "Provider refund, void, dispute, label refund, and payout webhook replay is signature-checked, metadata-correlated, redacted, and reconciled without duplicate owner effects.",
  }),
  reversalPolicy({
    control: "support-approved-operator-recovery",
    docLabel: "Support-approved operator recovery",
    ownerIssues: ["#1165", "#1122", "#1114", "#1124"],
    ownerContext: "Support",
    checkpoints: ["operator-recovery", "launch-decision"],
    audiences: ["support-operator"],
    states: ["support-only", "pending", "failed", "recovered", "held", "deferred"],
    effects: [
      "support-review",
      "payment-refund",
      "order-cancel",
      "label-cancel",
      "payout-hold",
      "settlement-adjustment",
    ],
    sourceFacts: [
      "support-request",
      "payments-refund",
      "ordering-cancellation",
      "settlement-hold",
      "launch-decision-row",
    ],
    idempotencyKeyShape: "support:approved_reversal:<support-request-id>:<owner-action>",
    customerVisible: true,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    owningFactRequiredBeforeAction: true,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "Approved operator recovery uses support permissions, audited owner actions, support-safe references, and launch-decision deferrals; support never edits rows or uses provider dashboards as the source of truth.",
  }),
  reversalPolicy({
    control: "return-dispute-chargeback-launch-posture",
    docLabel: "Return, dispute, and chargeback launch posture",
    ownerIssues: ["#1165", "#1122", "#1124", "#1102", "#1112"],
    ownerContext: "Support",
    checkpoints: ["operator-recovery", "provider-callback", "launch-decision"],
    audiences: allCustomerAudiences,
    states: ["support-only", "disabled", "deferred", "unsupported", "held", "partial"],
    effects: ["support-review", "payment-refund", "dispute-hold", "settlement-adjustment", "notification-correction"],
    sourceFacts: ["support-request", "payments-dispute", "settlement-hold", "launch-decision-row"],
    idempotencyKeyShape: "launch-decision:exception:<return-or-dispute-capability>:<state>",
    customerVisible: true,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    owningFactRequiredBeforeAction: true,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "Buyer returns, payment disputes, chargebacks, provider-initiated reversals, partial refunds, and unsupported provider capabilities are explicitly supported, disabled, or deferred with copy, visual, support, observability, and follow-up evidence.",
  }),
  reversalPolicy({
    control: "launch-decision-reversal-states",
    docLabel: "Launch decision reversal states",
    ownerIssues: ["#1165", "#1102", "#1112", "#1114", "#1115", "#1122", "#1123", "#1124"],
    ownerContext: "Platform",
    checkpoints: ["launch-decision", "operator-recovery"],
    audiences: allAudiences,
    states: [
      "support-only",
      "disabled",
      "deferred",
      "unsupported",
      "provider-outage",
      "webhook-delayed",
      "failed",
      "held",
      "partial",
      "no-side-effect",
    ],
    effects: [
      "payment-void",
      "payment-refund",
      "order-cancel",
      "label-cancel",
      "payout-hold",
      "payout-reversal",
      "settlement-adjustment",
      "support-review",
    ],
    sourceFacts: ["launch-decision-row", "support-request"],
    idempotencyKeyShape: "launch-decision:reversal:<capability>:<state>",
    customerVisible: true,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    owningFactRequiredBeforeAction: true,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "Supported, disabled, deferred, unsupported, provider-outage, webhook-delayed, support-only, pending, failed, recovered, held, duplicate, partial, and no-side-effect reversal states have owner-scoped launch handling where launch-visible.",
  }),
  reversalPolicy({
    control: "observability-redaction",
    docLabel: "Observability redaction",
    ownerIssues: ["#1165", "#1114", "#1124", "#1122"],
    ownerContext: "Checkout",
    checkpoints: ["pre-confirmation", "provider-callback", "background-retry", "operator-recovery", "launch-decision"],
    audiences: allAudiences,
    states: ["supported", "pending", "committed", "failed", "held", "duplicate-suppressed", "no-side-effect"],
    effects: [
      "payment-void",
      "payment-refund",
      "order-cancel",
      "label-cancel",
      "payout-reversal",
      "settlement-adjustment",
      "notification-correction",
      "account-history-correction",
    ],
    sourceFacts: ["checkout-confirmation", "provider-callback", "support-request", "launch-decision-row"],
    idempotencyKeyShape: "checkout:reversal_observability:<event-name>:<support-safe-reference>",
    customerVisible: false,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    owningFactRequiredBeforeAction: true,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "Reversal telemetry reports owner, state, effect kind, duplicate-prevention outcome, support-safe reference, and launch-decision state without raw provider payloads, card data, bank data, addresses, or risk signals.",
  }),
  reversalPolicy({
    control: "fresh-state-reversal-cleanup",
    docLabel: "Fresh-state reversal cleanup",
    ownerIssues: ["#1165", "#1124", "#1115"],
    ownerContext: "Platform",
    checkpoints: ["pre-confirmation", "operator-recovery", "launch-decision"],
    audiences: allAudiences,
    states: ["supported", "disabled", "deferred", "unsupported", "no-side-effect"],
    effects: [
      "no-side-effect",
      "payment-void",
      "payment-refund",
      "order-cancel",
      "label-cancel",
      "payout-reversal",
      "settlement-adjustment",
    ],
    sourceFacts: ["launch-decision-row", "none-before-commit"],
    idempotencyKeyShape: "checkout:reversal_fresh_state:<scan-or-route-id>:<result>",
    customerVisible: false,
    supportReferenceRequired: true,
    auditRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    owningFactRequiredBeforeAction: true,
    duplicatePreventionRequired: true,
    redactsSensitiveData: true,
    noLegacyCompatibility: true,
    forbiddenSources: checkoutReversalForbiddenSources,
    evidenceExpectation:
      "Fresh-state scans prove cancellation, refund, void, reversal, and adjustment paths cannot succeed through old routes, old payload adapters, old sell execution ids, old receipt rows, migrations, hidden repair, stale fixtures/read models, provider-dashboard-only recovery, or dense checkout fallback.",
  }),
] as const satisfies readonly CheckoutReversalPolicyEntry[];

export function assertCheckoutReversalRecoveryPolicyCoverage(): void {
  const byControl = new Map(checkoutReversalPolicyEntries.map((entry) => [entry.control, entry]));

  for (const control of checkoutReversalRequiredControls) {
    if (!byControl.has(control)) {
      throw new Error(`Missing checkout reversal recovery policy for '${control}'.`);
    }
  }

  if (byControl.size !== checkoutReversalPolicyEntries.length) {
    throw new Error("Checkout reversal recovery controls must be unique.");
  }

  for (const entry of checkoutReversalPolicyEntries) {
    if (!entry.ownerIssues.includes("#1165")) {
      throw new Error(`Checkout reversal recovery '${entry.control}' must include #1165.`);
    }
    if (entry.docLabel.trim().length === 0 || entry.evidenceExpectation.trim().length === 0) {
      throw new Error(`Checkout reversal recovery '${entry.control}' needs documentation text.`);
    }
    if (
      entry.checkpoints.length === 0 ||
      entry.audiences.length === 0 ||
      entry.states.length === 0 ||
      entry.effects.length === 0 ||
      entry.sourceFacts.length === 0
    ) {
      throw new Error(`Checkout reversal recovery '${entry.control}' needs complete coverage fields.`);
    }
    if (entry.duplicatePreventionRequired && entry.idempotencyKeyShape.trim().length === 0) {
      throw new Error(`Checkout reversal recovery '${entry.control}' needs an idempotency key shape.`);
    }
    if (!entry.auditRequired || !entry.observabilityRequired || !entry.redactsSensitiveData) {
      throw new Error(`Checkout reversal recovery '${entry.control}' must be audited and redacted.`);
    }
    if (!entry.noLegacyCompatibility) {
      throw new Error(`Checkout reversal recovery '${entry.control}' must reject legacy compatibility.`);
    }
    if (
      entry.states.some((state) => checkoutReversalLaunchRegisterStates.includes(state)) &&
      (!entry.launchDecisionRequired || !entry.supportReferenceRequired)
    ) {
      throw new Error(`Checkout reversal recovery '${entry.control}' must launch-decision customer-impacting states.`);
    }
    if (entry.effects.some(isOwnerEffect) && !entry.owningFactRequiredBeforeAction) {
      throw new Error(`Checkout reversal recovery '${entry.control}' must require an owner fact before action.`);
    }
    if (entry.customerVisible && !entry.supportReferenceRequired) {
      throw new Error(`Checkout reversal recovery '${entry.control}' needs a support-safe customer reference.`);
    }
    if (
      (entry.ownerContext === "Payments" || entry.ownerContext === "Settlement") &&
      !entry.ownerIssues.includes("#1124")
    ) {
      throw new Error(`Checkout reversal recovery '${entry.control}' needs #1124 for money-sensitive behavior.`);
    }
    for (const forbiddenSource of checkoutReversalForbiddenSources) {
      if (!entry.forbiddenSources.includes(forbiddenSource)) {
        throw new Error(`Checkout reversal recovery '${entry.control}' must forbid '${forbiddenSource}'.`);
      }
    }
  }

  for (const effect of [
    "payment-void",
    "payment-refund",
    "order-cancel",
    "inventory-release",
    "label-cancel",
    "label-refund",
    "payout-hold",
    "payout-reversal",
    "settlement-adjustment",
    "tax-fee-credit-adjustment",
    "notification-correction",
    "account-history-correction",
    "dispute-hold",
  ] as const satisfies readonly CheckoutReversalEffect[]) {
    if (!checkoutReversalPolicyEntries.some((entry) => entry.effects.includes(effect))) {
      throw new Error(`Checkout reversal recovery must cover '${effect}'.`);
    }
  }
}

function isOwnerEffect(effect: CheckoutReversalEffect): boolean {
  return effect !== "no-side-effect" && effect !== "support-review";
}

function reversalPolicy(input: CheckoutReversalPolicyEntry): CheckoutReversalPolicyEntry {
  return input;
}
