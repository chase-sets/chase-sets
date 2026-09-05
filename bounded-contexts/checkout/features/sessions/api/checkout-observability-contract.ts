export const checkoutObservabilityContractDocPath =
  "bounded-contexts/checkout/docs/checkout-observability-contract.md" as const;

export const checkoutObservabilityMetricName = "chase_sets_checkout_observability_events_total" as const;

export type CheckoutObservabilityTelemetryClass =
  | "funnel"
  | "readiness"
  | "checkout-entry"
  | "confirmation"
  | "handoff"
  | "recovery"
  | "capability-state";

export type CheckoutObservabilityDimension =
  | "entry-source"
  | "actor-mode"
  | "scenario-state"
  | "visible-state"
  | "readiness-contract"
  | "readiness-snapshot-version"
  | "source-revision"
  | "fresh-write-receipt-presence"
  | "side-effect-status"
  | "support-safe-reference"
  | "performance-budget-id"
  | "latency-ms"
  | "provider-category"
  | "risk-category"
  | "downstream-status"
  | "capability-decision";

export type CheckoutObservabilityForbiddenField =
  | "raw-after-write"
  | "cookie"
  | "email"
  | "address"
  | "provider-payload"
  | "checkout-session-id"
  | "account-id"
  | "event-id"
  | "full-url"
  | "anonymous-owner-key"
  | "request-header"
  | "request-body"
  | "raw-exception-message"
  | "raw-exception-stack"
  | "card-data"
  | "bank-data"
  | "secret"
  | "sensitive-risk-signal";

export type CheckoutObservabilityAlertClass =
  | "event-only"
  | "operator-alert"
  | "provider-alert"
  | "support-alert"
  | "fresh-state-alert";

export type CheckoutScenarioState =
  | "normal"
  | "loading"
  | "slow-budget"
  | "active-session-stale"
  | "blocked"
  | "unassigned-fulfillment"
  | "optimization-available"
  | "optimization-accepted"
  | "optimization-declined"
  | "disabled-capability"
  | "unsupported-capability"
  | "provider-outage"
  | "risk-hold"
  | "split-group"
  | "pending-downstream"
  | "committed-downstream"
  | "notification"
  | "support"
  | "reconciliation"
  | "reversal-recovery";

export const checkoutObservabilityRequiredStates = [
  "buy-cart-review-ready",
  "buy-readiness-unassigned-fulfillment",
  "buy-readiness-optimization",
  "guest-buy-checkout",
  "cart-merge-best-effort-failed",
  "signed-in-buy-checkout",
  "sell-list-review-ready",
  "sell-list-readiness-blocked",
  "guest-sell-checkout",
  "signed-in-sell-checkout",
  "seller-confirmation-activity",
  "active-session-stale-recovery",
  "address-serviceability-failure",
  "changed-economics-review",
  "risk-hold-provider-return-failure",
  "split-group-summary",
  "temporary-recovery-loading",
  "disabled-accelerated-saved-instrument",
  "promo-credit-gift-card-state",
  "notification-support-reference",
  "account-history-handoff",
  "reconciliation-pending",
  "reversal-recovery-status",
] as const;

export type CheckoutObservabilityState = (typeof checkoutObservabilityRequiredStates)[number];
export type CheckoutObservabilityOwnerIssue = `#${number}`;

export type CheckoutObservabilityProfile = Readonly<{
  state: CheckoutObservabilityState;
  eventName: `checkout.${string}`;
  docLabel: string;
  ownerIssues: readonly CheckoutObservabilityOwnerIssue[];
  telemetryClass: CheckoutObservabilityTelemetryClass;
  scenarioStates: readonly CheckoutScenarioState[];
  dimensions: readonly CheckoutObservabilityDimension[];
  forbiddenFields: readonly CheckoutObservabilityForbiddenField[];
  alertClass: CheckoutObservabilityAlertClass;
  operatorSignalRequired: boolean;
  expectation: string;
}>;

export const checkoutObservabilityForbiddenFields = [
  "raw-after-write",
  "cookie",
  "email",
  "address",
  "provider-payload",
  "checkout-session-id",
  "account-id",
  "event-id",
  "full-url",
  "anonymous-owner-key",
  "request-header",
  "request-body",
  "raw-exception-message",
  "raw-exception-stack",
  "card-data",
  "bank-data",
  "secret",
  "sensitive-risk-signal",
] as const satisfies readonly CheckoutObservabilityForbiddenField[];

const baseDimensions = [
  "entry-source",
  "actor-mode",
  "scenario-state",
  "visible-state",
  "side-effect-status",
  "support-safe-reference",
] as const satisfies readonly CheckoutObservabilityDimension[];

export const checkoutObservabilityProfiles = [
  profile({
    state: "buy-cart-review-ready",
    eventName: "checkout.cart.review_ready",
    docLabel: "Buy Cart review ready",
    ownerIssues: ["#1114", "#1115"],
    telemetryClass: "funnel",
    scenarioStates: ["normal"],
    dimensions: ["readiness-contract", "source-revision", "performance-budget-id", "latency-ms"],
    alertClass: "event-only",
    operatorSignalRequired: false,
    expectation: "Cart review telemetry shows mutable intent rendered without checkout repair machinery.",
  }),
  profile({
    state: "buy-readiness-unassigned-fulfillment",
    eventName: "checkout.readiness.unassigned_fulfillment",
    docLabel: "Buy readiness attention",
    ownerIssues: ["#1114", "#1115", "#1117"],
    telemetryClass: "readiness",
    scenarioStates: ["blocked", "unassigned-fulfillment"],
    dimensions: ["readiness-contract", "readiness-snapshot-version", "source-revision", "capability-decision"],
    alertClass: "support-alert",
    operatorSignalRequired: true,
    expectation: "Unassigned fulfillment telemetry stays in readiness and shows no downstream side effects started.",
  }),
  profile({
    state: "buy-readiness-optimization",
    eventName: "checkout.readiness.optimization_decision",
    docLabel: "Buy readiness savings optimization",
    ownerIssues: ["#1114", "#1115", "#1117"],
    telemetryClass: "readiness",
    scenarioStates: ["optimization-available", "optimization-accepted", "optimization-declined"],
    dimensions: ["readiness-contract", "readiness-snapshot-version", "source-revision", "performance-budget-id"],
    alertClass: "event-only",
    operatorSignalRequired: false,
    expectation: "Optimization telemetry records accepted or declined savings before checkout entry.",
  }),
  profile({
    state: "guest-buy-checkout",
    eventName: "checkout.buy.guest_review_rendered",
    docLabel: "Guest Buy Checkout",
    ownerIssues: ["#1114", "#1115"],
    telemetryClass: "checkout-entry",
    scenarioStates: ["normal"],
    dimensions: ["readiness-contract", "readiness-snapshot-version", "performance-budget-id", "latency-ms"],
    alertClass: "event-only",
    operatorSignalRequired: false,
    expectation: "Guest buy checkout telemetry shows one-step entry rendered from current union readiness only.",
  }),
  profile({
    state: "cart-merge-best-effort-failed",
    eventName: "checkout.entry.cart_merge_best_effort_failed",
    docLabel: "Cart merge best-effort failure",
    ownerIssues: ["#5734"],
    telemetryClass: "checkout-entry",
    scenarioStates: ["reconciliation"],
    dimensions: [],
    alertClass: "event-only",
    operatorSignalRequired: false,
    expectation: "Cart entry continues from the Account-plus-presented-anonymous union after a copy merge failure.",
  }),
  profile({
    state: "signed-in-buy-checkout",
    eventName: "checkout.buy.signed_in_review_rendered",
    docLabel: "Signed-in Buy Checkout",
    ownerIssues: ["#1114", "#1115", "#1121"],
    telemetryClass: "checkout-entry",
    scenarioStates: ["normal"],
    dimensions: ["readiness-contract", "readiness-snapshot-version", "source-revision", "performance-budget-id"],
    alertClass: "event-only",
    operatorSignalRequired: false,
    expectation: "Signed-in buy telemetry shows saved rows rendered with fresh account facts.",
  }),
  profile({
    state: "sell-list-review-ready",
    eventName: "checkout.sell_list.review_ready",
    docLabel: "Sell List review ready",
    ownerIssues: ["#1114", "#1115"],
    telemetryClass: "funnel",
    scenarioStates: ["normal"],
    dimensions: ["readiness-contract", "source-revision", "performance-budget-id", "latency-ms"],
    alertClass: "event-only",
    operatorSignalRequired: false,
    expectation: "Sell List review telemetry shows seller intent rendered before sale action commitment.",
  }),
  profile({
    state: "sell-list-readiness-blocked",
    eventName: "checkout.sell_list.readiness_blocked",
    docLabel: "Sell List readiness blocked",
    ownerIssues: ["#1114", "#1115"],
    telemetryClass: "readiness",
    scenarioStates: ["blocked"],
    dimensions: ["readiness-contract", "readiness-snapshot-version", "provider-category", "capability-decision"],
    alertClass: "support-alert",
    operatorSignalRequired: true,
    expectation: "Seller readiness telemetry keeps eligibility, payout, label, and provider blockers before checkout.",
  }),
  profile({
    state: "guest-sell-checkout",
    eventName: "checkout.sell.guest_review_rendered",
    docLabel: "Guest Sell Checkout",
    ownerIssues: ["#1114", "#1115", "#1113"],
    telemetryClass: "checkout-entry",
    scenarioStates: ["normal", "unsupported-capability"],
    dimensions: ["readiness-contract", "readiness-snapshot-version", "capability-decision", "provider-category"],
    alertClass: "operator-alert",
    operatorSignalRequired: true,
    expectation:
      "Guest sell telemetry records whether seller account or payout setup is enabled, disabled, or unsupported.",
  }),
  profile({
    state: "signed-in-sell-checkout",
    eventName: "checkout.sell.signed_in_review_rendered",
    docLabel: "Signed-in Sell Checkout",
    ownerIssues: ["#1114", "#1115", "#1121"],
    telemetryClass: "checkout-entry",
    scenarioStates: ["normal"],
    dimensions: ["readiness-contract", "readiness-snapshot-version", "provider-category", "performance-budget-id"],
    alertClass: "event-only",
    operatorSignalRequired: false,
    expectation: "Signed-in sell telemetry shows provider-ready facts were consumed without rebuilding diagnostics.",
  }),
  profile({
    state: "seller-confirmation-activity",
    eventName: "checkout.sell.confirmation_activity_recorded",
    docLabel: "Seller confirmation activity",
    ownerIssues: ["#1114", "#1115", "#1135"],
    telemetryClass: "confirmation",
    scenarioStates: ["pending-downstream"],
    dimensions: [
      "readiness-contract",
      "readiness-snapshot-version",
      "downstream-status",
      "support-safe-reference",
      "capability-decision",
    ],
    alertClass: "support-alert",
    operatorSignalRequired: true,
    expectation: "Seller confirmation telemetry separates recorded handoff from downstream completion.",
  }),
  profile({
    state: "active-session-stale-recovery",
    eventName: "checkout.session.active_stale_recovery",
    docLabel: "Active-session stale recovery",
    ownerIssues: ["#1114", "#1115", "#1118"],
    telemetryClass: "recovery",
    scenarioStates: ["active-session-stale", "blocked"],
    dimensions: [
      "readiness-contract",
      "readiness-snapshot-version",
      "source-revision",
      "fresh-write-receipt-presence",
      "support-safe-reference",
      "capability-decision",
    ],
    alertClass: "fresh-state-alert",
    operatorSignalRequired: true,
    expectation: "Active-session recovery telemetry shows source refresh failed closed before side effects.",
  }),
  profile({
    state: "address-serviceability-failure",
    eventName: "checkout.address.serviceability_failed",
    docLabel: "Address or serviceability failure",
    ownerIssues: ["#1114", "#1115", "#1127"],
    telemetryClass: "recovery",
    scenarioStates: ["blocked"],
    dimensions: ["readiness-contract", "provider-category", "support-safe-reference", "capability-decision"],
    alertClass: "support-alert",
    operatorSignalRequired: true,
    expectation: "Address telemetry shows serviceability failed safely without exposing address contents.",
  }),
  profile({
    state: "changed-economics-review",
    eventName: "checkout.economics.changed_review_required",
    docLabel: "Changed economics review",
    ownerIssues: ["#1114", "#1115", "#1128"],
    telemetryClass: "recovery",
    scenarioStates: ["blocked"],
    dimensions: ["readiness-contract", "source-revision", "support-safe-reference", "capability-decision"],
    alertClass: "support-alert",
    operatorSignalRequired: true,
    expectation: "Economics telemetry shows changed totals require review before confirmation.",
  }),
  profile({
    state: "risk-hold-provider-return-failure",
    eventName: "checkout.provider_or_risk.recovery_required",
    docLabel: "Risk hold or provider-return failure",
    ownerIssues: ["#1114", "#1115", "#1131", "#1134"],
    telemetryClass: "recovery",
    scenarioStates: ["risk-hold", "provider-outage", "blocked"],
    dimensions: ["provider-category", "risk-category", "support-safe-reference", "capability-decision"],
    alertClass: "provider-alert",
    operatorSignalRequired: true,
    expectation: "Provider and risk telemetry gives support-safe status without sensitive provider or risk details.",
  }),
  profile({
    state: "split-group-summary",
    eventName: "checkout.buy.split_group_summary_rendered",
    docLabel: "Split package summary",
    ownerIssues: ["#1114", "#1115", "#1164"],
    telemetryClass: "checkout-entry",
    scenarioStates: ["split-group"],
    dimensions: [
      "readiness-contract",
      "readiness-snapshot-version",
      "support-safe-reference",
      "performance-budget-id",
      "capability-decision",
    ],
    alertClass: "operator-alert",
    operatorSignalRequired: true,
    expectation:
      "Split-group telemetry preserves readiness-produced group references without checkout-time regrouping.",
  }),
  profile({
    state: "temporary-recovery-loading",
    eventName: "checkout.entry.temporary_recovery_visible",
    docLabel: "Temporary recovery loading",
    ownerIssues: ["#1114", "#1115", "#1206"],
    telemetryClass: "checkout-entry",
    scenarioStates: ["loading", "slow-budget"],
    dimensions: ["fresh-write-receipt-presence", "performance-budget-id", "latency-ms", "capability-decision"],
    alertClass: "fresh-state-alert",
    operatorSignalRequired: true,
    expectation: "Temporary recovery telemetry distinguishes safe waiting from ambiguous no-state renders.",
  }),
  profile({
    state: "disabled-accelerated-saved-instrument",
    eventName: "checkout.capability.accelerated_or_saved_disabled",
    docLabel: "Disabled accelerated or saved instrument",
    ownerIssues: ["#1114", "#1115", "#1113"],
    telemetryClass: "capability-state",
    scenarioStates: ["disabled-capability", "unsupported-capability"],
    dimensions: ["provider-category", "capability-decision", "support-safe-reference"],
    alertClass: "operator-alert",
    operatorSignalRequired: true,
    expectation: "Capability telemetry shows shortcuts cannot bypass readiness or final review.",
  }),
  profile({
    state: "promo-credit-gift-card-state",
    eventName: "checkout.capability.promo_credit_gift_card_state",
    docLabel: "Promo, credit, gift card, and fee state",
    ownerIssues: ["#1114", "#1115", "#1128"],
    telemetryClass: "capability-state",
    scenarioStates: ["unsupported-capability", "blocked"],
    dimensions: ["source-revision", "capability-decision", "support-safe-reference"],
    alertClass: "operator-alert",
    operatorSignalRequired: true,
    expectation: "Promo and credit telemetry records explicit enabled, disabled, or unsupported state.",
  }),
  profile({
    state: "notification-support-reference",
    eventName: "checkout.notification.expectation_recorded",
    docLabel: "Notification expectation and support reference",
    ownerIssues: ["#1114", "#1115", "#1129"],
    telemetryClass: "handoff",
    scenarioStates: ["notification", "support", "pending-downstream"],
    dimensions: ["downstream-status", "support-safe-reference", "capability-decision"],
    alertClass: "support-alert",
    operatorSignalRequired: true,
    expectation: "Notification telemetry records expectation and support reference without implying delivery.",
  }),
  profile({
    state: "account-history-handoff",
    eventName: "checkout.account_history.handoff_visible",
    docLabel: "Account history handoff",
    ownerIssues: ["#1114", "#1115", "#1135"],
    telemetryClass: "handoff",
    scenarioStates: ["committed-downstream", "support"],
    dimensions: ["downstream-status", "support-safe-reference", "performance-budget-id", "capability-decision"],
    alertClass: "support-alert",
    operatorSignalRequired: true,
    expectation:
      "Account-history telemetry links only committed downstream records and support-safe source references.",
  }),
  profile({
    state: "reconciliation-pending",
    eventName: "checkout.reconciliation.pending_visible",
    docLabel: "Reconciliation pending",
    ownerIssues: ["#1114", "#1115", "#1130"],
    telemetryClass: "handoff",
    scenarioStates: ["reconciliation", "pending-downstream"],
    dimensions: ["downstream-status", "support-safe-reference", "performance-budget-id", "capability-decision"],
    alertClass: "support-alert",
    operatorSignalRequired: true,
    expectation: "Reconciliation telemetry distinguishes pending recovery from committed downstream facts.",
  }),
  profile({
    state: "reversal-recovery-status",
    eventName: "checkout.reversal_or_adjustment.status_visible",
    docLabel: "Reversal and adjustment recovery",
    ownerIssues: ["#1114", "#1115", "#1165"],
    telemetryClass: "handoff",
    scenarioStates: ["reversal-recovery", "support"],
    dimensions: ["downstream-status", "support-safe-reference", "performance-budget-id", "capability-decision"],
    alertClass: "support-alert",
    operatorSignalRequired: true,
    expectation: "Reversal telemetry is audited, support-safe, and separated from completed refund or payout facts.",
  }),
] as const satisfies readonly CheckoutObservabilityProfile[];

export const checkoutObservabilityRequiredDimensions = [
  "entry-source",
  "actor-mode",
  "scenario-state",
  "visible-state",
  "side-effect-status",
  "support-safe-reference",
] as const satisfies readonly CheckoutObservabilityDimension[];

export function assertCheckoutObservabilityContractCoverage(): void {
  const profileByState = new Map(checkoutObservabilityProfiles.map((profile) => [profile.state, profile]));

  if (profileByState.size !== checkoutObservabilityProfiles.length) {
    throw new Error("Checkout observability profiles must be unique by state.");
  }

  for (const requiredState of checkoutObservabilityRequiredStates) {
    if (!profileByState.has(requiredState)) {
      throw new Error(`Missing checkout observability profile for state '${requiredState}'.`);
    }
  }

  for (const profile of checkoutObservabilityProfiles) {
    if (!profile.eventName.startsWith("checkout.")) {
      throw new Error(`Checkout observability event '${profile.eventName}' must use the checkout namespace.`);
    }

    for (const requiredDimension of checkoutObservabilityRequiredDimensions) {
      if (!profile.dimensions.includes(requiredDimension)) {
        throw new Error(`Observability profile '${profile.state}' is missing '${requiredDimension}'.`);
      }
    }

    if (profile.operatorSignalRequired && !profile.dimensions.includes("capability-decision")) {
      throw new Error(`Release-health profile '${profile.state}' must emit capability-decision.`);
    }

    if (profile.scenarioStates.includes("pending-downstream") && !profile.dimensions.includes("downstream-status")) {
      throw new Error(`Pending downstream profile '${profile.state}' must emit downstream-status.`);
    }

    if (profile.forbiddenFields.length !== checkoutObservabilityForbiddenFields.length) {
      throw new Error(`Observability profile '${profile.state}' must use the standard forbidden field set.`);
    }

    for (const forbiddenField of checkoutObservabilityForbiddenFields) {
      if (!profile.forbiddenFields.includes(forbiddenField)) {
        throw new Error(`Observability profile '${profile.state}' does not forbid '${forbiddenField}'.`);
      }
    }

    if (profile.expectation.match(/\b(todo|tbd)\b/i)) {
      throw new Error(`Observability profile '${profile.state}' has unfinished expectation text.`);
    }
  }
}
function profile<
  const TProfile extends Omit<CheckoutObservabilityProfile, "dimensions" | "forbiddenFields"> & {
    dimensions: readonly CheckoutObservabilityDimension[];
  },
>(input: TProfile): CheckoutObservabilityProfile {
  return {
    ...input,
    dimensions: [...new Set([...baseDimensions, ...input.dimensions])],
    forbiddenFields: checkoutObservabilityForbiddenFields,
  };
}
