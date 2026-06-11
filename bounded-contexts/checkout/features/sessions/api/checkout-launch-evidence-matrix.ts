import type { CheckoutCopySurfaceKey } from "./checkout-copy-policy";
import { checkoutCopyPolicyEntries } from "./checkout-copy-policy";
import type {
  CheckoutPerformanceActorMode,
  CheckoutPerformanceEntrySource,
  CheckoutPerformanceSurfaceKey,
  CheckoutPerformanceVerificationKind,
  CheckoutPerformanceVisibleState,
  CheckoutSideEffectClass,
} from "./checkout-performance-budgets";
import { checkoutPerformanceBudgets } from "./checkout-performance-budgets";
import type {
  CheckoutVisualOwnerIssue,
  CheckoutVisualTargetKey,
  CheckoutVisualViewport,
} from "./checkout-visual-targets";
import { checkoutVisualRequiredTargets, checkoutVisualTargets } from "./checkout-visual-targets";

export const checkoutLaunchEvidenceMatrixDocPath =
  "bounded-contexts/checkout/docs/checkout-launch-evidence-matrix.md" as const;

export type CheckoutLaunchScenarioState =
  | "normal"
  | "loading"
  | "slow-budget"
  | "active-session-stale"
  | "blocked"
  | "production-proof-readiness"
  | "unassigned-fulfillment"
  | "optimization-available"
  | "optimization-accepted"
  | "optimization-declined"
  | "disabled-capability"
  | "deferred-capability"
  | "provider-outage"
  | "risk-hold"
  | "split-group"
  | "pending-downstream"
  | "committed-downstream"
  | "notification"
  | "support"
  | "reconciliation"
  | "reversal-recovery"
  | "kill-switch"
  | "fresh-state-cleanup";

export type CheckoutLaunchPhase =
  | "cart-list-readiness"
  | "checkout-review"
  | "confirmation"
  | "post-confirmation-handoff"
  | "recovery"
  | "launch-governance";

export type CheckoutLaunchReadinessContract =
  | "checkout.cart-readiness.v1"
  | "checkout.sell-list-readiness.v1"
  | "checkout.session-read-model"
  | "checkout.sell-list-confirmation-pages"
  | "downstream-owned-fact"
  | "launch-register"
  | "production-proof-canary"
  | "fresh-state-cleanup";

export type CheckoutLaunchRegisterStatus = "required" | "not-required";

export type CheckoutLaunchSideEffectStatus =
  | "forbidden-before-confirm"
  | "not-attempted"
  | "pending-downstream"
  | "downstream-owned-committed"
  | "owner-approved-deferred";

export type CheckoutLaunchEvidenceKind =
  | CheckoutPerformanceVerificationKind
  | "copy-policy"
  | "visual-target"
  | "observability-event"
  | "support-runbook"
  | "security-policy"
  | "launch-register"
  | "fresh-state-scan";

export type CheckoutLaunchExternalEvidenceIssue = "#1227" | "#1228" | "#1237";

export type CheckoutLaunchEvidenceRow = Readonly<{
  state: CheckoutVisualTargetKey;
  docLabel: string;
  ownerIssues: readonly CheckoutVisualOwnerIssue[];
  externalEvidenceIssues?: readonly CheckoutLaunchExternalEvidenceIssue[];
  scenarioStates: readonly CheckoutLaunchScenarioState[];
  phase: CheckoutLaunchPhase;
  readinessContract: CheckoutLaunchReadinessContract;
  entrySources: readonly CheckoutPerformanceEntrySource[];
  actorModes: readonly CheckoutPerformanceActorMode[];
  viewports: readonly CheckoutVisualViewport[];
  copySurface: CheckoutCopySurfaceKey;
  visualTarget: CheckoutVisualTargetKey;
  performanceSurface: CheckoutPerformanceSurfaceKey;
  visibleState: CheckoutPerformanceVisibleState;
  requiredEvidence: readonly CheckoutLaunchEvidenceKind[];
  launchRegisterStatus: CheckoutLaunchRegisterStatus;
  readinessBeforeCheckout: boolean;
  noSideEffectProofRequired: boolean;
  pendingDownstreamBoundaryRequired: boolean;
  freshStateCleanupProofRequired: boolean;
  sideEffectStatus: CheckoutLaunchSideEffectStatus;
  sideEffectClasses: readonly CheckoutSideEffectClass[];
  supportReferenceRequired: boolean;
  launchEvidenceExpectation: string;
}>;

const allActorModes = ["guest", "signed-in"] as const satisfies readonly CheckoutPerformanceActorMode[];
const buySources = ["buy-now", "buy-cart-readiness"] as const satisfies readonly CheckoutPerformanceEntrySource[];
const cartSource = ["buy-cart-readiness"] as const satisfies readonly CheckoutPerformanceEntrySource[];
const sellSource = ["sell-list-readiness"] as const satisfies readonly CheckoutPerformanceEntrySource[];
const allSources = [
  "buy-now",
  "buy-cart-readiness",
  "sell-list-readiness",
] as const satisfies readonly CheckoutPerformanceEntrySource[];
const downstreamSideEffects = [
  "payment",
  "order",
  "label",
  "payout",
  "settlement",
  "notification",
  "account-history",
  "support",
] as const satisfies readonly CheckoutSideEffectClass[];
const visualCopyPerformanceEvidence = [
  "copy-policy",
  "visual-target",
  "unit-contract",
] as const satisfies readonly CheckoutLaunchEvidenceKind[];
const launchEvidence = [
  "copy-policy",
  "visual-target",
  "unit-contract",
  "route-test",
  "e2e",
  "visual-mobile",
  "accessibility",
  "metrics",
  "observability-event",
  "support-runbook",
  "launch-register",
] as const satisfies readonly CheckoutLaunchEvidenceKind[];

export const checkoutLaunchEvidenceRequiredScenarioStates = [
  "normal",
  "loading",
  "slow-budget",
  "active-session-stale",
  "blocked",
  "production-proof-readiness",
  "unassigned-fulfillment",
  "optimization-available",
  "optimization-accepted",
  "optimization-declined",
  "disabled-capability",
  "deferred-capability",
  "provider-outage",
  "risk-hold",
  "split-group",
  "pending-downstream",
  "committed-downstream",
  "notification",
  "support",
  "reconciliation",
  "reversal-recovery",
  "kill-switch",
  "fresh-state-cleanup",
] as const satisfies readonly CheckoutLaunchScenarioState[];

export const checkoutLaunchEvidenceRows = [
  row({
    state: "buy-cart-review-ready",
    docLabel: "Buy Cart review ready",
    ownerIssues: ["#1115", "#1116", "#1117"],
    scenarioStates: ["normal"],
    phase: "cart-list-readiness",
    readinessContract: "checkout.cart-readiness.v1",
    entrySources: cartSource,
    actorModes: allActorModes,
    viewports: ["desktop"],
    copySurface: "cart-list-review",
    visualTarget: "buy-cart-review-ready",
    performanceSurface: "cart-list-initial-render",
    visibleState: "cart-or-list-review-visible",
    requiredEvidence: [...visualCopyPerformanceEvidence, "route-test", "visual-mobile"],
    launchRegisterStatus: "not-required",
    readinessBeforeCheckout: true,
    noSideEffectProofRequired: false,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "forbidden-before-confirm",
    sideEffectClasses: downstreamSideEffects,
    supportReferenceRequired: false,
    launchEvidenceExpectation: "Buy Cart review shows mutable intent and no checkout repair machinery.",
  }),
  row({
    state: "buy-readiness-unassigned-fulfillment",
    docLabel: "Buy readiness attention",
    ownerIssues: ["#1115", "#1116", "#1117"],
    scenarioStates: ["blocked", "unassigned-fulfillment"],
    phase: "cart-list-readiness",
    readinessContract: "checkout.cart-readiness.v1",
    entrySources: cartSource,
    actorModes: allActorModes,
    viewports: ["mobile"],
    copySurface: "readiness-unassigned-fulfillment",
    visualTarget: "buy-readiness-unassigned-fulfillment",
    performanceSurface: "buy-cart-readiness-evaluation",
    visibleState: "readiness-decision-visible",
    requiredEvidence: [...launchEvidence, "fresh-state-scan"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: true,
    noSideEffectProofRequired: true,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "not-attempted",
    sideEffectClasses: downstreamSideEffects,
    supportReferenceRequired: true,
    launchEvidenceExpectation: "Unassigned fulfillment is resolved or removed before checkout starts.",
  }),
  row({
    state: "buy-readiness-optimization",
    docLabel: "Buy readiness savings optimization",
    ownerIssues: ["#1115", "#1117", "#1123"],
    scenarioStates: ["optimization-available", "optimization-accepted", "optimization-declined"],
    phase: "cart-list-readiness",
    readinessContract: "checkout.cart-readiness.v1",
    entrySources: cartSource,
    actorModes: allActorModes,
    viewports: ["mobile"],
    copySurface: "readiness-optimization-offer",
    visualTarget: "buy-readiness-optimization",
    performanceSurface: "fulfillment-optimization-decision",
    visibleState: "readiness-decision-visible",
    requiredEvidence: [...visualCopyPerformanceEvidence, "route-test", "e2e", "metrics"],
    launchRegisterStatus: "not-required",
    readinessBeforeCheckout: true,
    noSideEffectProofRequired: true,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "not-attempted",
    sideEffectClasses: downstreamSideEffects,
    supportReferenceRequired: false,
    launchEvidenceExpectation:
      "Accepted and declined savings decisions are recorded before checkout consumes readiness.",
  }),
  row({
    state: "guest-buy-checkout",
    docLabel: "Guest Buy Checkout",
    ownerIssues: ["#1105", "#1107", "#1115", "#1116"],
    scenarioStates: ["normal"],
    phase: "checkout-review",
    readinessContract: "checkout.session-read-model",
    entrySources: buySources,
    actorModes: ["guest"],
    viewports: ["desktop"],
    copySurface: "checkout-review",
    visualTarget: "guest-buy-checkout",
    performanceSurface: "checkout-entry-review-render",
    visibleState: "checkout-review-visible",
    requiredEvidence: [...visualCopyPerformanceEvidence, "route-test", "e2e", "accessibility", "metrics"],
    launchRegisterStatus: "not-required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: false,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "forbidden-before-confirm",
    sideEffectClasses: downstreamSideEffects,
    supportReferenceRequired: false,
    launchEvidenceExpectation:
      "Guest buy checkout renders form-first Shopify-simple review from current readiness only.",
  }),
  row({
    state: "signed-in-buy-checkout",
    docLabel: "Signed-in Buy Checkout",
    ownerIssues: ["#1106", "#1107", "#1115", "#1121"],
    scenarioStates: ["normal"],
    phase: "checkout-review",
    readinessContract: "checkout.session-read-model",
    entrySources: buySources,
    actorModes: ["signed-in"],
    viewports: ["mobile"],
    copySurface: "checkout-saved-info-rows",
    visualTarget: "signed-in-buy-checkout",
    performanceSurface: "mobile-sticky-action-interaction",
    visibleState: "checkout-review-visible",
    requiredEvidence: [...visualCopyPerformanceEvidence, "e2e", "visual-mobile", "accessibility"],
    launchRegisterStatus: "not-required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: false,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "forbidden-before-confirm",
    sideEffectClasses: downstreamSideEffects,
    supportReferenceRequired: false,
    launchEvidenceExpectation: "Signed-in buy checkout uses editable saved rows without stale account facts.",
  }),
  row({
    state: "sell-list-review-ready",
    docLabel: "Sell List review ready",
    ownerIssues: ["#1115", "#1116", "#1117"],
    scenarioStates: ["normal"],
    phase: "cart-list-readiness",
    readinessContract: "checkout.sell-list-readiness.v1",
    entrySources: sellSource,
    actorModes: allActorModes,
    viewports: ["desktop"],
    copySurface: "cart-list-review",
    visualTarget: "sell-list-review-ready",
    performanceSurface: "cart-list-initial-render",
    visibleState: "cart-or-list-review-visible",
    requiredEvidence: [...visualCopyPerformanceEvidence, "route-test", "visual-mobile"],
    launchRegisterStatus: "not-required",
    readinessBeforeCheckout: true,
    noSideEffectProofRequired: false,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "forbidden-before-confirm",
    sideEffectClasses: downstreamSideEffects,
    supportReferenceRequired: false,
    launchEvidenceExpectation: "Sell List review shows seller intent before sale action commitment.",
  }),
  row({
    state: "sell-list-readiness-blocked",
    docLabel: "Sell List readiness blocked",
    ownerIssues: ["#1115", "#1116", "#1117"],
    scenarioStates: ["blocked"],
    phase: "cart-list-readiness",
    readinessContract: "checkout.sell-list-readiness.v1",
    entrySources: sellSource,
    actorModes: allActorModes,
    viewports: ["mobile"],
    copySurface: "readiness-blocked-or-unavailable",
    visualTarget: "sell-list-readiness-blocked",
    performanceSurface: "sell-list-readiness-evaluation",
    visibleState: "readiness-decision-visible",
    requiredEvidence: [...launchEvidence, "fresh-state-scan"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: true,
    noSideEffectProofRequired: true,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "not-attempted",
    sideEffectClasses: downstreamSideEffects,
    supportReferenceRequired: true,
    launchEvidenceExpectation:
      "Seller eligibility, sale action, payout, label, and provider blockers stay in readiness.",
  }),
  row({
    state: "guest-sell-checkout",
    docLabel: "Guest Sell Checkout",
    ownerIssues: ["#1109", "#1115", "#1116", "#1121"],
    scenarioStates: ["normal", "deferred-capability"],
    phase: "checkout-review",
    readinessContract: "checkout.sell-list-readiness.v1",
    entrySources: sellSource,
    actorModes: ["guest"],
    viewports: ["desktop"],
    copySurface: "checkout-review",
    visualTarget: "guest-sell-checkout",
    performanceSurface: "checkout-entry-review-render",
    visibleState: "checkout-review-visible",
    requiredEvidence: [...launchEvidence, "security-policy"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: true,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "owner-approved-deferred",
    sideEffectClasses: ["payout", "settlement", "support"],
    supportReferenceRequired: true,
    launchEvidenceExpectation:
      "Guest sell checkout is launch-registered if seller account or payout setup is deferred.",
  }),
  row({
    state: "signed-in-sell-checkout",
    docLabel: "Signed-in Sell Checkout",
    ownerIssues: ["#1110", "#1111", "#1115", "#1116"],
    scenarioStates: ["normal"],
    phase: "checkout-review",
    readinessContract: "checkout.sell-list-readiness.v1",
    entrySources: sellSource,
    actorModes: ["signed-in"],
    viewports: ["desktop"],
    copySurface: "checkout-saved-info-rows",
    visualTarget: "signed-in-sell-checkout",
    performanceSurface: "checkout-entry-review-render",
    visibleState: "checkout-review-visible",
    requiredEvidence: [...visualCopyPerformanceEvidence, "route-test", "e2e", "metrics"],
    launchRegisterStatus: "not-required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: false,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "forbidden-before-confirm",
    sideEffectClasses: downstreamSideEffects,
    supportReferenceRequired: true,
    launchEvidenceExpectation:
      "Signed-in sell checkout consumes seller readiness without rebuilding provider diagnostics.",
  }),
  row({
    state: "seller-confirmation-activity",
    docLabel: "Seller confirmation activity",
    ownerIssues: ["#1115", "#1116", "#1120", "#1135"],
    scenarioStates: ["pending-downstream"],
    phase: "confirmation",
    readinessContract: "checkout.sell-list-confirmation-pages",
    entrySources: sellSource,
    actorModes: ["signed-in"],
    viewports: ["mobile"],
    copySurface: "seller-pending-activity",
    visualTarget: "seller-confirmation-activity",
    performanceSurface: "final-confirmation-visible-state",
    visibleState: "confirmation-visible",
    requiredEvidence: [...launchEvidence, "observability-event"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: false,
    pendingDownstreamBoundaryRequired: true,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "pending-downstream",
    sideEffectClasses: ["order", "label", "payout", "settlement", "notification", "account-history"],
    supportReferenceRequired: true,
    launchEvidenceExpectation: "Seller activity says confirmation is recorded without implying downstream completion.",
  }),
  row({
    state: "active-session-stale-recovery",
    docLabel: "Active-session stale recovery",
    ownerIssues: ["#1115", "#1116", "#1118", "#1119"],
    scenarioStates: ["active-session-stale", "blocked"],
    phase: "recovery",
    readinessContract: "checkout.session-read-model",
    entrySources: allSources,
    actorModes: allActorModes,
    viewports: ["desktop"],
    copySurface: "active-session-stale-recovery",
    visualTarget: "active-session-stale-recovery",
    performanceSurface: "active-session-reload",
    visibleState: "checkout-permanent-recovery-visible",
    requiredEvidence: [...launchEvidence, "fresh-state-scan"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: true,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "not-attempted",
    sideEffectClasses: downstreamSideEffects,
    supportReferenceRequired: true,
    launchEvidenceExpectation:
      "Reload, provider return, guest merge, and final submit revalidate source facts before side effects.",
  }),
  row({
    state: "address-serviceability-failure",
    docLabel: "Address or serviceability failure",
    ownerIssues: ["#1115", "#1116", "#1127"],
    scenarioStates: ["blocked"],
    phase: "recovery",
    readinessContract: "checkout.session-read-model",
    entrySources: buySources,
    actorModes: allActorModes,
    viewports: ["mobile"],
    copySurface: "address-correction",
    visualTarget: "address-serviceability-failure",
    performanceSurface: "totals-refresh",
    visibleState: "checkout-permanent-recovery-visible",
    requiredEvidence: [...launchEvidence, "security-policy"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: true,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "not-attempted",
    sideEffectClasses: downstreamSideEffects,
    supportReferenceRequired: true,
    launchEvidenceExpectation:
      "Invalid address and serviceability failures stop checkout without hidden fulfillment repair.",
  }),
  row({
    state: "changed-economics-review",
    docLabel: "Changed economics review",
    ownerIssues: ["#1115", "#1116", "#1119", "#1128"],
    scenarioStates: ["blocked"],
    phase: "recovery",
    readinessContract: "checkout.session-read-model",
    entrySources: allSources,
    actorModes: allActorModes,
    viewports: ["desktop"],
    copySurface: "economics-discount-credit-promo",
    visualTarget: "changed-economics-review",
    performanceSurface: "totals-refresh",
    visibleState: "checkout-review-visible",
    requiredEvidence: [...launchEvidence, "security-policy"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: true,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "not-attempted",
    sideEffectClasses: downstreamSideEffects,
    supportReferenceRequired: true,
    launchEvidenceExpectation:
      "Changed price, tax, fee, promo, credit, or payout facts require review before confirmation.",
  }),
  row({
    state: "risk-hold-provider-return-failure",
    docLabel: "Risk hold or provider-return failure",
    ownerIssues: ["#1115", "#1116", "#1131", "#1134"],
    scenarioStates: ["risk-hold", "provider-outage", "blocked"],
    phase: "recovery",
    readinessContract: "launch-register",
    entrySources: allSources,
    actorModes: allActorModes,
    viewports: ["mobile"],
    copySurface: "risk-hold-or-block",
    visualTarget: "risk-hold-provider-return-failure",
    performanceSurface: "provider-return-confirmation",
    visibleState: "checkout-permanent-recovery-visible",
    requiredEvidence: [...launchEvidence, "security-policy", "fresh-state-scan"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: true,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "not-attempted",
    sideEffectClasses: downstreamSideEffects,
    supportReferenceRequired: true,
    launchEvidenceExpectation: "Risk and provider-return failures are customer-safe and do not expose diagnostics.",
  }),
  row({
    state: "split-group-summary",
    docLabel: "Split package summary",
    ownerIssues: ["#1115", "#1116", "#1164"],
    scenarioStates: ["split-group"],
    phase: "checkout-review",
    readinessContract: "checkout.session-read-model",
    entrySources: buySources,
    actorModes: allActorModes,
    viewports: ["desktop"],
    copySurface: "split-group-summary",
    visualTarget: "split-group-summary",
    performanceSurface: "checkout-entry-review-render",
    visibleState: "checkout-review-visible",
    requiredEvidence: [...launchEvidence, "metrics"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: false,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "forbidden-before-confirm",
    sideEffectClasses: downstreamSideEffects,
    supportReferenceRequired: true,
    launchEvidenceExpectation:
      "Multi-group buy checkout keeps one customer-facing confirmation action and concise groups.",
  }),
  row({
    state: "kill-switch-checkout-unavailable",
    docLabel: "Checkout unavailable",
    ownerIssues: ["#1115", "#1116", "#1132"],
    scenarioStates: ["kill-switch"],
    phase: "launch-governance",
    readinessContract: "launch-register",
    entrySources: allSources,
    actorModes: allActorModes,
    viewports: ["mobile"],
    copySurface: "kill-switch-disabled-checkout",
    visualTarget: "kill-switch-checkout-unavailable",
    performanceSurface: "checkout-entry-permanent-recovery-render",
    visibleState: "checkout-permanent-recovery-visible",
    requiredEvidence: [...launchEvidence, "fresh-state-scan"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: true,
    noSideEffectProofRequired: true,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "not-attempted",
    sideEffectClasses: downstreamSideEffects,
    supportReferenceRequired: true,
    launchEvidenceExpectation: "Kill switches fail closed without restoring dense checkout or old payload adapters.",
  }),
  row({
    state: "temporary-recovery-loading",
    docLabel: "Temporary recovery loading",
    ownerIssues: ["#1115", "#1116", "#1123", "#1206"],
    scenarioStates: ["loading", "slow-budget"],
    phase: "recovery",
    readinessContract: "checkout.session-read-model",
    entrySources: allSources,
    actorModes: allActorModes,
    viewports: ["desktop"],
    copySurface: "checkout-temporary-recovery",
    visualTarget: "temporary-recovery-loading",
    performanceSurface: "checkout-entry-temporary-recovery-render",
    visibleState: "checkout-temporary-recovery-visible",
    requiredEvidence: [...launchEvidence, "metrics"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: true,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "not-attempted",
    sideEffectClasses: downstreamSideEffects,
    supportReferenceRequired: true,
    launchEvidenceExpectation:
      "Slow but valid fresh-write paths show bounded recovery instead of ambiguous no-state UI.",
  }),
  row({
    state: "production-proof-buy-now-readiness",
    docLabel: "Production proof Buy Now readiness",
    ownerIssues: ["#1115", "#1116", "#1123", "#1206"],
    externalEvidenceIssues: ["#1227", "#1228", "#1237"],
    scenarioStates: ["production-proof-readiness", "slow-budget"],
    phase: "launch-governance",
    readinessContract: "production-proof-canary",
    entrySources: ["buy-now"],
    actorModes: ["signed-in"],
    viewports: ["desktop"],
    copySurface: "checkout-review",
    visualTarget: "production-proof-buy-now-readiness",
    performanceSurface: "checkout-entry-review-render",
    visibleState: "checkout-review-visible",
    requiredEvidence: [
      "copy-policy",
      "visual-target",
      "unit-contract",
      "route-test",
      "e2e",
      "canary",
      "metrics",
      "observability-event",
      "support-runbook",
      "launch-register",
      "fresh-state-scan",
    ],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: true,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "not-attempted",
    sideEffectClasses: downstreamSideEffects,
    supportReferenceRequired: true,
    launchEvidenceExpectation:
      "Production proof-mode Buy Now must reach pay-ready checkout within the ready SLO; temporary recovery is safety evidence only, and checkout-ready-slo-exceeded artifacts remain launch blockers tied to projection runtime evidence.",
  }),
  row({
    state: "disabled-accelerated-saved-instrument",
    docLabel: "Disabled accelerated or saved instrument",
    ownerIssues: ["#1113", "#1115", "#1116", "#1121"],
    scenarioStates: ["disabled-capability", "deferred-capability"],
    phase: "checkout-review",
    readinessContract: "launch-register",
    entrySources: allSources,
    actorModes: allActorModes,
    viewports: ["mobile"],
    copySurface: "accelerated-saved-instrument-fallback",
    visualTarget: "disabled-accelerated-saved-instrument",
    performanceSurface: "payment-payout-setup-handoff",
    visibleState: "payment-or-payout-handoff-visible",
    requiredEvidence: [...launchEvidence, "security-policy"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: true,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "owner-approved-deferred",
    sideEffectClasses: ["payment", "payout", "settlement"],
    supportReferenceRequired: true,
    launchEvidenceExpectation:
      "Accelerated, saved payment, and payout setup shortcuts cannot bypass readiness or final review.",
  }),
  row({
    state: "promo-credit-gift-card-state",
    docLabel: "Promo, credit, gift card, and fee state",
    ownerIssues: ["#1115", "#1116", "#1128"],
    scenarioStates: ["deferred-capability", "blocked"],
    phase: "checkout-review",
    readinessContract: "launch-register",
    entrySources: buySources,
    actorModes: allActorModes,
    viewports: ["desktop"],
    copySurface: "economics-discount-credit-promo",
    visualTarget: "promo-credit-gift-card-state",
    performanceSurface: "totals-refresh",
    visibleState: "checkout-review-visible",
    requiredEvidence: [...launchEvidence, "security-policy"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: true,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "owner-approved-deferred",
    sideEffectClasses: ["payment", "order", "settlement"],
    supportReferenceRequired: true,
    launchEvidenceExpectation:
      "Discount, credit, gift-card, promo, and fee support is explicit, disabled, or deferred.",
  }),
  row({
    state: "notification-support-reference",
    docLabel: "Notification expectation and support reference",
    ownerIssues: ["#1115", "#1116", "#1122", "#1129"],
    scenarioStates: ["notification", "support", "pending-downstream"],
    phase: "post-confirmation-handoff",
    readinessContract: "downstream-owned-fact",
    entrySources: allSources,
    actorModes: allActorModes,
    viewports: ["mobile"],
    copySurface: "notification-expectation",
    visualTarget: "notification-support-reference",
    performanceSurface: "final-confirmation-visible-state",
    visibleState: "confirmation-visible",
    requiredEvidence: [...launchEvidence, "observability-event"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: false,
    pendingDownstreamBoundaryRequired: true,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "pending-downstream",
    sideEffectClasses: ["notification", "support", "account-history"],
    supportReferenceRequired: true,
    launchEvidenceExpectation:
      "Notification expectation is support-safe and does not imply delivery before Notifications commits.",
  }),
  row({
    state: "account-history-handoff",
    docLabel: "Account history handoff",
    ownerIssues: ["#1115", "#1116", "#1135"],
    scenarioStates: ["committed-downstream", "support"],
    phase: "post-confirmation-handoff",
    readinessContract: "downstream-owned-fact",
    entrySources: allSources,
    actorModes: allActorModes,
    viewports: ["desktop"],
    copySurface: "account-history-handoff",
    visualTarget: "account-history-handoff",
    performanceSurface: "account-history-handoff",
    visibleState: "account-history-handoff-visible",
    requiredEvidence: [...launchEvidence, "observability-event"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: false,
    pendingDownstreamBoundaryRequired: true,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "downstream-owned-committed",
    sideEffectClasses: ["order", "label", "payout", "settlement", "account-history"],
    supportReferenceRequired: true,
    launchEvidenceExpectation:
      "Account history shows links only for committed downstream records and source references.",
  }),
  row({
    state: "reconciliation-pending",
    docLabel: "Reconciliation pending",
    ownerIssues: ["#1115", "#1116", "#1130"],
    scenarioStates: ["reconciliation", "pending-downstream"],
    phase: "post-confirmation-handoff",
    readinessContract: "downstream-owned-fact",
    entrySources: allSources,
    actorModes: allActorModes,
    viewports: ["desktop"],
    copySurface: "account-history-handoff",
    visualTarget: "reconciliation-pending",
    performanceSurface: "support-lookup",
    visibleState: "support-safe-status-visible",
    requiredEvidence: [...launchEvidence, "observability-event"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: false,
    pendingDownstreamBoundaryRequired: true,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "pending-downstream",
    sideEffectClasses: ["payment", "order", "label", "payout", "settlement", "notification", "account-history"],
    supportReferenceRequired: true,
    launchEvidenceExpectation:
      "Reconciliation states remain support-safe and distinguish pending from committed records.",
  }),
  row({
    state: "reversal-recovery-status",
    docLabel: "Reversal and adjustment recovery",
    ownerIssues: ["#1115", "#1116", "#1165"],
    scenarioStates: ["reversal-recovery", "support"],
    phase: "post-confirmation-handoff",
    readinessContract: "downstream-owned-fact",
    entrySources: allSources,
    actorModes: allActorModes,
    viewports: ["mobile"],
    copySurface: "cancellation-refund-reversal",
    visualTarget: "reversal-recovery-status",
    performanceSurface: "reversal-recovery-status-refresh",
    visibleState: "reversal-or-recovery-status-visible",
    requiredEvidence: [...launchEvidence, "observability-event", "security-policy"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: false,
    noSideEffectProofRequired: false,
    pendingDownstreamBoundaryRequired: true,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "pending-downstream",
    sideEffectClasses: ["payment", "order", "label", "payout", "settlement", "support"],
    supportReferenceRequired: true,
    launchEvidenceExpectation:
      "Refund, void, label cancellation, payout hold, and reversal status is audited and support-safe.",
  }),
  row({
    state: "fresh-state-cleanup-absence",
    docLabel: "Fresh-state cleanup absence",
    ownerIssues: ["#1115", "#1116", "#1132"],
    scenarioStates: ["fresh-state-cleanup", "kill-switch"],
    phase: "launch-governance",
    readinessContract: "fresh-state-cleanup",
    entrySources: allSources,
    actorModes: allActorModes,
    viewports: ["mobile"],
    copySurface: "fresh-state-localization-cleanup",
    visualTarget: "fresh-state-cleanup-absence",
    performanceSurface: "checkout-entry-permanent-recovery-render",
    visibleState: "checkout-permanent-recovery-visible",
    requiredEvidence: [...launchEvidence, "fresh-state-scan"],
    launchRegisterStatus: "required",
    readinessBeforeCheckout: true,
    noSideEffectProofRequired: true,
    pendingDownstreamBoundaryRequired: false,
    freshStateCleanupProofRequired: true,
    sideEffectStatus: "not-attempted",
    sideEffectClasses: downstreamSideEffects,
    supportReferenceRequired: true,
    launchEvidenceExpectation:
      "Fresh-state proof deletes or hard-disables old routes, payloads, shims, fixtures, docs, and runbooks.",
  }),
] as const satisfies readonly CheckoutLaunchEvidenceRow[];

export function assertCheckoutLaunchEvidenceMatrixCoverage(): void {
  const copyBySurface = new Map(checkoutCopyPolicyEntries.map((entry) => [entry.surface, entry]));
  const performanceBySurface = new Map(checkoutPerformanceBudgets.map((budget) => [budget.surface, budget]));
  const visualBySurface = new Map(checkoutVisualTargets.map((target) => [target.surface, target]));
  const rowsByState = new Map(checkoutLaunchEvidenceRows.map((evidenceRow) => [evidenceRow.state, evidenceRow]));

  for (const requiredTarget of checkoutVisualRequiredTargets) {
    if (!rowsByState.has(requiredTarget)) {
      throw new Error(`Missing launch evidence row for visual target '${requiredTarget}'.`);
    }
  }

  if (rowsByState.size !== checkoutLaunchEvidenceRows.length) {
    throw new Error("Checkout launch evidence rows must be unique.");
  }

  const coveredScenarioStates = new Set(
    checkoutLaunchEvidenceRows.flatMap((evidenceRow) => evidenceRow.scenarioStates),
  );
  for (const scenarioState of checkoutLaunchEvidenceRequiredScenarioStates) {
    if (!coveredScenarioStates.has(scenarioState)) {
      throw new Error(`Missing launch evidence scenario state '${scenarioState}'.`);
    }
  }

  for (const evidenceRow of checkoutLaunchEvidenceRows) {
    const visualTarget = visualBySurface.get(evidenceRow.visualTarget);
    if (!visualTarget) {
      throw new Error(`Launch evidence row '${evidenceRow.state}' references an unknown visual target.`);
    }
    if (evidenceRow.state !== evidenceRow.visualTarget) {
      throw new Error(`Launch evidence row '${evidenceRow.state}' must use the matching visual target as anchor.`);
    }
    if (!copyBySurface.has(evidenceRow.copySurface)) {
      throw new Error(`Launch evidence row '${evidenceRow.state}' references an unknown copy surface.`);
    }
    const performanceBudget = performanceBySurface.get(evidenceRow.performanceSurface);
    if (!performanceBudget) {
      throw new Error(`Launch evidence row '${evidenceRow.state}' references an unknown performance surface.`);
    }
    if (!performanceBudget.visibleStates.includes(evidenceRow.visibleState)) {
      throw new Error(
        `Launch evidence row '${evidenceRow.state}' uses a visible state outside its performance budget.`,
      );
    }
    if (visualTarget.copySurface !== evidenceRow.copySurface) {
      throw new Error(`Launch evidence row '${evidenceRow.state}' has drifted from its visual copy surface.`);
    }
    if (visualTarget.performanceSurface !== evidenceRow.performanceSurface) {
      throw new Error(`Launch evidence row '${evidenceRow.state}' has drifted from its visual performance surface.`);
    }
    if (visualTarget.visibleState !== evidenceRow.visibleState) {
      throw new Error(`Launch evidence row '${evidenceRow.state}' has drifted from its visual visible state.`);
    }
    if (evidenceRow.ownerIssues.length === 0 || !evidenceRow.ownerIssues.includes("#1115")) {
      throw new Error(`Launch evidence row '${evidenceRow.state}' needs #1115 coverage ownership.`);
    }
    if (evidenceRow.launchRegisterStatus === "required" && !evidenceRow.ownerIssues.includes("#1116")) {
      throw new Error(`Launch evidence row '${evidenceRow.state}' needs #1116 launch ownership.`);
    }
    if (visualTarget.launchRegisterStatus === "required" && evidenceRow.launchRegisterStatus !== "required") {
      throw new Error(`Launch evidence row '${evidenceRow.state}' must honor visual launch-register status.`);
    }
    if (
      !evidenceRow.requiredEvidence.includes("copy-policy") ||
      !evidenceRow.requiredEvidence.includes("visual-target")
    ) {
      throw new Error(`Launch evidence row '${evidenceRow.state}' must link copy and visual evidence.`);
    }
    if (evidenceRow.launchEvidenceExpectation.trim().length === 0) {
      throw new Error(`Launch evidence row '${evidenceRow.state}' needs an evidence expectation.`);
    }
    if (/\b(todo|tbd)\b/i.test(evidenceRow.launchEvidenceExpectation)) {
      throw new Error(`Launch evidence row '${evidenceRow.state}' has placeholder evidence text.`);
    }
  }

  const readinessRows = checkoutLaunchEvidenceRows.filter((evidenceRow) => evidenceRow.readinessBeforeCheckout);
  for (const evidenceRow of readinessRows) {
    if (evidenceRow.phase !== "cart-list-readiness" && evidenceRow.phase !== "launch-governance") {
      throw new Error(`Readiness row '${evidenceRow.state}' must stay outside checkout.`);
    }
    if (
      evidenceRow.sideEffectStatus !== "forbidden-before-confirm" &&
      evidenceRow.sideEffectStatus !== "not-attempted"
    ) {
      throw new Error(`Readiness row '${evidenceRow.state}' cannot attempt downstream side effects.`);
    }
  }

  const noSideEffectRows = checkoutLaunchEvidenceRows.filter((evidenceRow) => evidenceRow.noSideEffectProofRequired);
  for (const evidenceRow of noSideEffectRows) {
    for (const sideEffect of downstreamSideEffects) {
      if (
        !evidenceRow.sideEffectClasses.includes(sideEffect) &&
        evidenceRow.sideEffectStatus !== "owner-approved-deferred"
      ) {
        throw new Error(`No-side-effect row '${evidenceRow.state}' is missing ${sideEffect} coverage.`);
      }
    }
    if (
      evidenceRow.sideEffectStatus !== "not-attempted" &&
      evidenceRow.sideEffectStatus !== "owner-approved-deferred"
    ) {
      throw new Error(`No-side-effect row '${evidenceRow.state}' has an unsafe side-effect status.`);
    }
  }

  const pendingRows = checkoutLaunchEvidenceRows.filter((evidenceRow) => evidenceRow.pendingDownstreamBoundaryRequired);
  for (const evidenceRow of pendingRows) {
    if (
      evidenceRow.sideEffectStatus === "downstream-owned-committed" &&
      evidenceRow.state !== "account-history-handoff"
    ) {
      throw new Error(`Pending row '${evidenceRow.state}' cannot imply committed downstream facts.`);
    }
    if (
      !evidenceRow.requiredEvidence.includes("support-runbook") ||
      !evidenceRow.requiredEvidence.includes("observability-event")
    ) {
      throw new Error(`Pending row '${evidenceRow.state}' needs support and observability evidence.`);
    }
  }

  const cleanupRows = checkoutLaunchEvidenceRows.filter((evidenceRow) => evidenceRow.freshStateCleanupProofRequired);
  if (cleanupRows.length !== checkoutLaunchEvidenceRows.length) {
    throw new Error("Every launch evidence row must require fresh-state cleanup proof.");
  }

  const productionProofRows = checkoutLaunchEvidenceRows.filter((evidenceRow) =>
    evidenceRow.scenarioStates.includes("production-proof-readiness"),
  );
  if (productionProofRows.length !== 1) {
    throw new Error("Checkout launch evidence must have one production proof readiness row.");
  }

  for (const evidenceRow of productionProofRows) {
    const externalEvidenceIssues = evidenceRow.externalEvidenceIssues ?? [];

    for (const requiredIssue of ["#1227", "#1228", "#1237"] as const) {
      if (!externalEvidenceIssues.includes(requiredIssue)) {
        throw new Error(`Production proof readiness row must link ${requiredIssue}.`);
      }
    }
    for (const requiredEvidence of [
      "canary",
      "metrics",
      "observability-event",
      "support-runbook",
      "launch-register",
      "fresh-state-scan",
    ] as const) {
      if (!evidenceRow.requiredEvidence.includes(requiredEvidence)) {
        throw new Error(`Production proof readiness row must require ${requiredEvidence}.`);
      }
    }
    if (evidenceRow.performanceSurface !== "checkout-entry-review-render") {
      throw new Error("Production proof readiness row must prove checkout review render.");
    }
    if (evidenceRow.visibleState !== "checkout-review-visible") {
      throw new Error("Production proof readiness row must prove the checkout review visible state.");
    }
    if (!evidenceRow.noSideEffectProofRequired || evidenceRow.sideEffectStatus !== "not-attempted") {
      throw new Error("Production proof readiness row must prove no payment or order side effects started.");
    }
    if (!/\bpay-ready\b/i.test(evidenceRow.launchEvidenceExpectation)) {
      throw new Error("Production proof readiness row must name pay-ready proof.");
    }
    if (!/temporary recovery/i.test(evidenceRow.launchEvidenceExpectation)) {
      throw new Error("Production proof readiness row must distinguish temporary recovery from launch proof.");
    }
  }
}

function row(input: CheckoutLaunchEvidenceRow): CheckoutLaunchEvidenceRow {
  return input;
}
