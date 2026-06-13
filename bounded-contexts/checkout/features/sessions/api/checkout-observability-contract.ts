import type { CheckoutVisualOwnerIssue, CheckoutVisualTargetKey } from "./checkout-visual-targets";
import { checkoutLaunchEvidenceRows, type CheckoutLaunchScenarioState } from "./checkout-launch-evidence-matrix";

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
  | "launch-governance"
  | "fresh-state-cleanup";

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
  | "launch-decision-decision"
  | "fresh-state-scan-result"
  | "canary-final-state"
  | "promotion-decision"
  | "release-run-id";

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
  | "card-data"
  | "bank-data"
  | "secret"
  | "sensitive-risk-signal";

export type CheckoutObservabilityAlertClass =
  | "dashboard-only"
  | "launch-alert"
  | "provider-alert"
  | "support-alert"
  | "fresh-state-alert";

export type CheckoutObservabilityProfile = Readonly<{
  state: CheckoutVisualTargetKey;
  eventName: `checkout.${string}`;
  docLabel: string;
  ownerIssues: readonly CheckoutVisualOwnerIssue[];
  telemetryClass: CheckoutObservabilityTelemetryClass;
  scenarioStates: readonly CheckoutLaunchScenarioState[];
  dimensions: readonly CheckoutObservabilityDimension[];
  forbiddenFields: readonly CheckoutObservabilityForbiddenField[];
  alertClass: CheckoutObservabilityAlertClass;
  releaseHealthRequired: boolean;
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
    ownerIssues: ["#1114", "#1115", "#1548"],
    telemetryClass: "funnel",
    scenarioStates: ["normal"],
    dimensions: ["readiness-contract", "source-revision", "performance-budget-id", "latency-ms"],
    alertClass: "dashboard-only",
    releaseHealthRequired: false,
    expectation: "Cart review telemetry proves mutable intent rendered without checkout repair machinery.",
  }),
  profile({
    state: "buy-readiness-unassigned-fulfillment",
    eventName: "checkout.readiness.unassigned_fulfillment",
    docLabel: "Buy readiness attention",
    ownerIssues: ["#1114", "#1115", "#1548", "#1117"],
    telemetryClass: "readiness",
    scenarioStates: ["blocked", "unassigned-fulfillment"],
    dimensions: [
      "readiness-contract",
      "readiness-snapshot-version",
      "source-revision",
      "launch-decision-decision",
      "fresh-state-scan-result",
    ],
    alertClass: "support-alert",
    releaseHealthRequired: true,
    expectation: "Unassigned fulfillment telemetry stays in readiness and proves no downstream side effects started.",
  }),
  profile({
    state: "buy-readiness-optimization",
    eventName: "checkout.readiness.optimization_decision",
    docLabel: "Buy readiness savings optimization",
    ownerIssues: ["#1114", "#1115", "#1548", "#1117"],
    telemetryClass: "readiness",
    scenarioStates: ["optimization-available", "optimization-accepted", "optimization-declined"],
    dimensions: ["readiness-contract", "readiness-snapshot-version", "source-revision", "performance-budget-id"],
    alertClass: "dashboard-only",
    releaseHealthRequired: false,
    expectation: "Optimization telemetry records accepted or declined savings before checkout entry.",
  }),
  profile({
    state: "guest-buy-checkout",
    eventName: "checkout.buy.guest_review_rendered",
    docLabel: "Guest Buy Checkout",
    ownerIssues: ["#1114", "#1115", "#1548"],
    telemetryClass: "checkout-entry",
    scenarioStates: ["normal"],
    dimensions: ["readiness-contract", "readiness-snapshot-version", "performance-budget-id", "latency-ms"],
    alertClass: "dashboard-only",
    releaseHealthRequired: false,
    expectation: "Guest buy checkout telemetry proves form-first review rendered from current readiness only.",
  }),
  profile({
    state: "signed-in-buy-checkout",
    eventName: "checkout.buy.signed_in_review_rendered",
    docLabel: "Signed-in Buy Checkout",
    ownerIssues: ["#1114", "#1115", "#1548", "#1121"],
    telemetryClass: "checkout-entry",
    scenarioStates: ["normal"],
    dimensions: ["readiness-contract", "readiness-snapshot-version", "source-revision", "performance-budget-id"],
    alertClass: "dashboard-only",
    releaseHealthRequired: false,
    expectation: "Signed-in buy telemetry proves saved rows rendered with fresh account facts.",
  }),
  profile({
    state: "sell-list-review-ready",
    eventName: "checkout.sell_list.review_ready",
    docLabel: "Sell List review ready",
    ownerIssues: ["#1114", "#1115", "#1548"],
    telemetryClass: "funnel",
    scenarioStates: ["normal"],
    dimensions: ["readiness-contract", "source-revision", "performance-budget-id", "latency-ms"],
    alertClass: "dashboard-only",
    releaseHealthRequired: false,
    expectation: "Sell List review telemetry proves seller intent rendered before sale action commitment.",
  }),
  profile({
    state: "sell-list-readiness-blocked",
    eventName: "checkout.sell_list.readiness_blocked",
    docLabel: "Sell List readiness blocked",
    ownerIssues: ["#1114", "#1115", "#1548"],
    telemetryClass: "readiness",
    scenarioStates: ["blocked"],
    dimensions: [
      "readiness-contract",
      "readiness-snapshot-version",
      "provider-category",
      "launch-decision-decision",
      "fresh-state-scan-result",
    ],
    alertClass: "support-alert",
    releaseHealthRequired: true,
    expectation: "Seller readiness telemetry keeps eligibility, payout, label, and provider blockers before checkout.",
  }),
  profile({
    state: "guest-sell-checkout",
    eventName: "checkout.sell.guest_review_rendered",
    docLabel: "Guest Sell Checkout",
    ownerIssues: ["#1114", "#1115", "#1548", "#1113"],
    telemetryClass: "checkout-entry",
    scenarioStates: ["normal", "deferred-capability"],
    dimensions: ["readiness-contract", "readiness-snapshot-version", "launch-decision-decision", "provider-category"],
    alertClass: "launch-alert",
    releaseHealthRequired: true,
    expectation:
      "Guest sell telemetry records whether seller account or payout setup is enabled, disabled, or deferred.",
  }),
  profile({
    state: "signed-in-sell-checkout",
    eventName: "checkout.sell.signed_in_review_rendered",
    docLabel: "Signed-in Sell Checkout",
    ownerIssues: ["#1114", "#1115", "#1548", "#1121"],
    telemetryClass: "checkout-entry",
    scenarioStates: ["normal"],
    dimensions: ["readiness-contract", "readiness-snapshot-version", "provider-category", "performance-budget-id"],
    alertClass: "dashboard-only",
    releaseHealthRequired: false,
    expectation: "Signed-in sell telemetry proves provider-ready facts were consumed without rebuilding diagnostics.",
  }),
  profile({
    state: "seller-confirmation-activity",
    eventName: "checkout.sell.confirmation_activity_recorded",
    docLabel: "Seller confirmation activity",
    ownerIssues: ["#1114", "#1115", "#1548", "#1135"],
    telemetryClass: "confirmation",
    scenarioStates: ["pending-downstream"],
    dimensions: [
      "readiness-contract",
      "readiness-snapshot-version",
      "downstream-status",
      "support-safe-reference",
      "launch-decision-decision",
    ],
    alertClass: "support-alert",
    releaseHealthRequired: true,
    expectation: "Seller confirmation telemetry separates recorded handoff from downstream completion.",
  }),
  profile({
    state: "active-session-stale-recovery",
    eventName: "checkout.session.active_stale_recovery",
    docLabel: "Active-session stale recovery",
    ownerIssues: ["#1114", "#1115", "#1548", "#1118"],
    telemetryClass: "recovery",
    scenarioStates: ["active-session-stale", "blocked"],
    dimensions: [
      "readiness-contract",
      "readiness-snapshot-version",
      "source-revision",
      "fresh-write-receipt-presence",
      "support-safe-reference",
      "launch-decision-decision",
      "fresh-state-scan-result",
    ],
    alertClass: "fresh-state-alert",
    releaseHealthRequired: true,
    expectation: "Active-session recovery telemetry proves source revalidation failed closed before side effects.",
  }),
  profile({
    state: "address-serviceability-failure",
    eventName: "checkout.address.serviceability_failed",
    docLabel: "Address or serviceability failure",
    ownerIssues: ["#1114", "#1115", "#1548", "#1127"],
    telemetryClass: "recovery",
    scenarioStates: ["blocked"],
    dimensions: ["readiness-contract", "provider-category", "support-safe-reference", "launch-decision-decision"],
    alertClass: "support-alert",
    releaseHealthRequired: true,
    expectation: "Address telemetry proves serviceability failed safely without exposing address contents.",
  }),
  profile({
    state: "changed-economics-review",
    eventName: "checkout.economics.changed_review_required",
    docLabel: "Changed economics review",
    ownerIssues: ["#1114", "#1115", "#1548", "#1128"],
    telemetryClass: "recovery",
    scenarioStates: ["blocked"],
    dimensions: ["readiness-contract", "source-revision", "support-safe-reference", "launch-decision-decision"],
    alertClass: "support-alert",
    releaseHealthRequired: true,
    expectation: "Economics telemetry proves changed totals require review before confirmation.",
  }),
  profile({
    state: "risk-hold-provider-return-failure",
    eventName: "checkout.provider_or_risk.recovery_required",
    docLabel: "Risk hold or provider-return failure",
    ownerIssues: ["#1114", "#1115", "#1548", "#1131", "#1134"],
    telemetryClass: "recovery",
    scenarioStates: ["risk-hold", "provider-outage", "blocked"],
    dimensions: [
      "provider-category",
      "risk-category",
      "support-safe-reference",
      "launch-decision-decision",
      "fresh-state-scan-result",
    ],
    alertClass: "provider-alert",
    releaseHealthRequired: true,
    expectation: "Provider and risk telemetry gives support-safe status without sensitive provider or risk details.",
  }),
  profile({
    state: "split-group-summary",
    eventName: "checkout.buy.split_group_summary_rendered",
    docLabel: "Split package summary",
    ownerIssues: ["#1114", "#1115", "#1548", "#1164"],
    telemetryClass: "checkout-entry",
    scenarioStates: ["split-group"],
    dimensions: [
      "readiness-contract",
      "readiness-snapshot-version",
      "support-safe-reference",
      "performance-budget-id",
      "launch-decision-decision",
    ],
    alertClass: "launch-alert",
    releaseHealthRequired: true,
    expectation:
      "Split-group telemetry preserves readiness-produced group references without checkout-time regrouping.",
  }),
  profile({
    state: "kill-switch-checkout-unavailable",
    eventName: "checkout.launch.kill_switch_unavailable",
    docLabel: "Checkout unavailable",
    ownerIssues: ["#1114", "#1115", "#1548", "#1103"],
    telemetryClass: "launch-governance",
    scenarioStates: ["kill-switch"],
    dimensions: ["launch-decision-decision", "support-safe-reference", "fresh-state-scan-result", "release-run-id"],
    alertClass: "launch-alert",
    releaseHealthRequired: true,
    expectation: "Kill-switch telemetry proves checkout failed closed without legacy fallback.",
  }),
  profile({
    state: "temporary-recovery-loading",
    eventName: "checkout.entry.temporary_recovery_visible",
    docLabel: "Temporary recovery loading",
    ownerIssues: ["#1114", "#1115", "#1548", "#1206"],
    telemetryClass: "checkout-entry",
    scenarioStates: ["loading", "slow-budget"],
    dimensions: [
      "fresh-write-receipt-presence",
      "performance-budget-id",
      "latency-ms",
      "canary-final-state",
      "promotion-decision",
      "launch-decision-decision",
    ],
    alertClass: "fresh-state-alert",
    releaseHealthRequired: true,
    expectation: "Temporary recovery telemetry distinguishes safe waiting from ambiguous no-state renders.",
  }),
  profile({
    state: "production-proof-buy-now-readiness",
    eventName: "checkout.launch.production_proof_buy_now",
    docLabel: "Production proof Buy Now readiness",
    ownerIssues: ["#1114", "#1115", "#1548", "#1123"],
    telemetryClass: "launch-governance",
    scenarioStates: ["production-proof-readiness", "slow-budget"],
    dimensions: [
      "fresh-write-receipt-presence",
      "performance-budget-id",
      "latency-ms",
      "canary-final-state",
      "promotion-decision",
      "release-run-id",
      "launch-decision-decision",
    ],
    alertClass: "launch-alert",
    releaseHealthRequired: true,
    expectation:
      "Production proof telemetry records pay-ready success or checkout-ready SLO failure without side effects.",
  }),
  profile({
    state: "disabled-accelerated-saved-instrument",
    eventName: "checkout.capability.accelerated_or_saved_disabled",
    docLabel: "Disabled accelerated or saved instrument",
    ownerIssues: ["#1114", "#1115", "#1548", "#1113"],
    telemetryClass: "launch-governance",
    scenarioStates: ["disabled-capability", "deferred-capability"],
    dimensions: ["provider-category", "launch-decision-decision", "support-safe-reference", "fresh-state-scan-result"],
    alertClass: "launch-alert",
    releaseHealthRequired: true,
    expectation: "Capability telemetry proves shortcuts cannot bypass readiness or final review.",
  }),
  profile({
    state: "promo-credit-gift-card-state",
    eventName: "checkout.capability.promo_credit_gift_card_state",
    docLabel: "Promo, credit, gift card, and fee state",
    ownerIssues: ["#1114", "#1115", "#1548", "#1128"],
    telemetryClass: "launch-governance",
    scenarioStates: ["deferred-capability", "blocked"],
    dimensions: ["source-revision", "launch-decision-decision", "support-safe-reference"],
    alertClass: "launch-alert",
    releaseHealthRequired: true,
    expectation: "Promo and credit telemetry records explicit enabled, disabled, or deferred launch state.",
  }),
  profile({
    state: "notification-support-reference",
    eventName: "checkout.notification.expectation_recorded",
    docLabel: "Notification expectation and support reference",
    ownerIssues: ["#1114", "#1115", "#1548", "#1129"],
    telemetryClass: "handoff",
    scenarioStates: ["notification", "support", "pending-downstream"],
    dimensions: ["downstream-status", "support-safe-reference", "launch-decision-decision"],
    alertClass: "support-alert",
    releaseHealthRequired: true,
    expectation: "Notification telemetry records expectation and support reference without implying delivery.",
  }),
  profile({
    state: "account-history-handoff",
    eventName: "checkout.account_history.handoff_visible",
    docLabel: "Account history handoff",
    ownerIssues: ["#1114", "#1115", "#1548", "#1135"],
    telemetryClass: "handoff",
    scenarioStates: ["committed-downstream", "support"],
    dimensions: ["downstream-status", "support-safe-reference", "performance-budget-id", "launch-decision-decision"],
    alertClass: "support-alert",
    releaseHealthRequired: true,
    expectation:
      "Account-history telemetry links only committed downstream records and support-safe source references.",
  }),
  profile({
    state: "reconciliation-pending",
    eventName: "checkout.reconciliation.pending_visible",
    docLabel: "Reconciliation pending",
    ownerIssues: ["#1114", "#1115", "#1548", "#1130"],
    telemetryClass: "handoff",
    scenarioStates: ["reconciliation", "pending-downstream"],
    dimensions: ["downstream-status", "support-safe-reference", "performance-budget-id", "launch-decision-decision"],
    alertClass: "support-alert",
    releaseHealthRequired: true,
    expectation: "Reconciliation telemetry distinguishes pending recovery from committed downstream facts.",
  }),
  profile({
    state: "reversal-recovery-status",
    eventName: "checkout.reversal_or_adjustment.status_visible",
    docLabel: "Reversal and adjustment recovery",
    ownerIssues: ["#1114", "#1115", "#1548", "#1165"],
    telemetryClass: "handoff",
    scenarioStates: ["reversal-recovery", "support"],
    dimensions: ["downstream-status", "support-safe-reference", "performance-budget-id", "launch-decision-decision"],
    alertClass: "support-alert",
    releaseHealthRequired: true,
    expectation: "Reversal telemetry is audited, support-safe, and separated from completed refund or payout facts.",
  }),
  profile({
    state: "fresh-state-cleanup-absence",
    eventName: "checkout.launch.fresh_state_cleanup_verified",
    docLabel: "Fresh-state cleanup absence",
    ownerIssues: ["#1114", "#1115", "#1548", "#1132"],
    telemetryClass: "fresh-state-cleanup",
    scenarioStates: ["fresh-state-cleanup", "kill-switch"],
    dimensions: ["fresh-state-scan-result", "launch-decision-decision", "release-run-id"],
    alertClass: "fresh-state-alert",
    releaseHealthRequired: true,
    expectation:
      "Cleanup telemetry proves old routes, payloads, shims, fixtures, docs, and runbooks cannot satisfy launch.",
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
  const matrixByState = new Map(checkoutLaunchEvidenceRows.map((row) => [row.state, row]));
  const profileByState = new Map(checkoutObservabilityProfiles.map((profile) => [profile.state, profile]));

  if (profileByState.size !== checkoutObservabilityProfiles.length) {
    throw new Error("Checkout observability profiles must be unique by state.");
  }

  for (const row of checkoutLaunchEvidenceRows) {
    const profile = profileByState.get(row.state);

    if (!profile) {
      throw new Error(`Missing checkout observability profile for launch row '${row.state}'.`);
    }

    if (!profile.eventName.startsWith("checkout.")) {
      throw new Error(`Checkout observability event '${profile.eventName}' must use the checkout namespace.`);
    }

    for (const requiredDimension of checkoutObservabilityRequiredDimensions) {
      if (!profile.dimensions.includes(requiredDimension)) {
        throw new Error(`Observability profile '${row.state}' is missing '${requiredDimension}'.`);
      }
    }

    for (const scenarioState of row.scenarioStates) {
      if (!profile.scenarioStates.includes(scenarioState)) {
        throw new Error(`Observability profile '${row.state}' is missing scenario '${scenarioState}'.`);
      }
    }

    if (row.launchDecisionStatus === "required" && !profile.dimensions.includes("launch-decision-decision")) {
      throw new Error(`Launch decision row '${row.state}' must emit launch-decision-decision.`);
    }

    if (row.noSideEffectProofRequired && !profile.dimensions.includes("side-effect-status")) {
      throw new Error(`No-side-effect row '${row.state}' must emit side-effect-status.`);
    }

    if (row.supportReferenceRequired && !profile.dimensions.includes("support-safe-reference")) {
      throw new Error(`Support row '${row.state}' must emit support-safe-reference.`);
    }

    if (row.pendingDownstreamBoundaryRequired && !profile.dimensions.includes("downstream-status")) {
      throw new Error(`Pending downstream row '${row.state}' must emit downstream-status.`);
    }

    if (row.state === "fresh-state-cleanup-absence" && !profile.dimensions.includes("fresh-state-scan-result")) {
      throw new Error("Fresh-state cleanup observability must emit fresh-state-scan-result.");
    }

    if (profile.forbiddenFields.length !== checkoutObservabilityForbiddenFields.length) {
      throw new Error(`Observability profile '${row.state}' must use the standard forbidden field set.`);
    }
  }

  for (const profile of checkoutObservabilityProfiles) {
    if (!matrixByState.has(profile.state)) {
      throw new Error(`Observability profile '${profile.state}' is not backed by a launch evidence row.`);
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
