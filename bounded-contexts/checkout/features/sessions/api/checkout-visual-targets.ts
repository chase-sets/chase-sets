import type { CheckoutCopyOwnerIssue, CheckoutCopySurfaceKey } from "./checkout-copy-policy";
import type { CheckoutPerformanceSurfaceKey, CheckoutPerformanceVisibleState } from "./checkout-performance-budgets";

export const checkoutVisualTargetDocPath = "bounded-contexts/checkout/docs/checkout-visual-targets.md" as const;
export const checkoutVisualTargetAssetDirectory = "bounded-contexts/checkout/docs/visual-targets" as const;

export type CheckoutVisualViewport = "desktop" | "mobile";

export type CheckoutVisualArtifactKey = "buy-flow" | "sell-flow" | "recovery-launch" | "capability-states";

export type CheckoutVisualEvidenceSource =
  | "generated-image"
  | "supplied-shopify-reference"
  | "implemented-baseline"
  | "pr-attached-screenshot"
  | "launch-evidence-row";

export type CheckoutVisualLayoutRequirement =
  | "desktop-two-column-checkout"
  | "mobile-single-column-checkout"
  | "mobile-collapsible-summary"
  | "mobile-sticky-primary-action"
  | "cart-list-before-checkout"
  | "saved-info-editable-rows"
  | "support-safe-reference-visible"
  | "pending-vs-committed-separated"
  | "no-horizontal-overflow";

export type CheckoutVisualForbiddenPattern =
  | "dense-checkout-panel"
  | "allocation-control"
  | "provider-diagnostic"
  | "old-route-recovery"
  | "legacy-payload-wording"
  | "hidden-repair"
  | "nested-card-stack"
  | "fake-downstream-completion"
  | "migration-backfill-wording";

export type CheckoutVisualLaunchRegisterStatus = "required" | "not-required";

export type CheckoutVisualOwnerIssue =
  | CheckoutCopyOwnerIssue
  | "#1098"
  | "#1104"
  | "#1108"
  | "#1109"
  | "#1110"
  | "#1111";

export type CheckoutVisualTargetKey =
  | "buy-cart-review-ready"
  | "buy-readiness-unassigned-fulfillment"
  | "buy-readiness-optimization"
  | "guest-buy-checkout"
  | "signed-in-buy-checkout"
  | "sell-list-review-ready"
  | "sell-list-readiness-blocked"
  | "guest-sell-checkout"
  | "signed-in-sell-checkout"
  | "seller-confirmation-activity"
  | "active-session-stale-recovery"
  | "address-serviceability-failure"
  | "changed-economics-review"
  | "risk-hold-provider-return-failure"
  | "split-group-summary"
  | "kill-switch-checkout-unavailable"
  | "temporary-recovery-loading"
  | "disabled-accelerated-saved-instrument"
  | "promo-credit-gift-card-state"
  | "notification-support-reference"
  | "account-history-handoff"
  | "reconciliation-pending"
  | "reversal-recovery-status"
  | "fresh-state-cleanup-absence";

export type CheckoutVisualArtifact = Readonly<{
  key: CheckoutVisualArtifactKey;
  path: string;
  alt: string;
  promptUseCase: "ui-mockup";
  source: "built-in-image-gen";
  reviewStatus: "ready-for-design-review";
}>;

export type CheckoutVisualTarget = Readonly<{
  surface: CheckoutVisualTargetKey;
  docLabel: string;
  ownerIssues: readonly CheckoutVisualOwnerIssue[];
  evidenceSources: readonly CheckoutVisualEvidenceSource[];
  artifact: CheckoutVisualArtifactKey;
  frames: readonly string[];
  viewports: readonly CheckoutVisualViewport[];
  copySurface: CheckoutCopySurfaceKey;
  performanceSurface: CheckoutPerformanceSurfaceKey;
  visibleState: CheckoutPerformanceVisibleState;
  launchRegisterStatus: CheckoutVisualLaunchRegisterStatus;
  layoutRequirements: readonly CheckoutVisualLayoutRequirement[];
  forbiddenPatterns: readonly CheckoutVisualForbiddenPattern[];
  readinessBeforeCheckout: boolean;
  noSideEffectEvidenceRequired: boolean;
  pendingDownstreamBoundaryRequired: boolean;
  deltaOwnerIssues: readonly CheckoutVisualOwnerIssue[];
  exitEvidence: string;
}>;

export const checkoutVisualTargetArtifacts = [
  visualArtifact({
    key: "buy-flow",
    path: `${checkoutVisualTargetAssetDirectory}/checkout-visual-targets-buy-flow.png`,
    alt: "Buy checkout visual targets covering desktop cart review, mobile readiness savings, desktop guest checkout, and mobile signed-in checkout.",
    promptUseCase: "ui-mockup",
    source: "built-in-image-gen",
    reviewStatus: "ready-for-design-review",
  }),
  visualArtifact({
    key: "sell-flow",
    path: `${checkoutVisualTargetAssetDirectory}/checkout-visual-targets-sell-flow.png`,
    alt: "Sell checkout visual targets covering desktop Sell List review, mobile readiness, signed-in seller checkout, and seller activity confirmation.",
    promptUseCase: "ui-mockup",
    source: "built-in-image-gen",
    reviewStatus: "ready-for-design-review",
  }),
  visualArtifact({
    key: "recovery-launch",
    path: `${checkoutVisualTargetAssetDirectory}/checkout-visual-targets-recovery-launch.png`,
    alt: "Checkout recovery and launch visual targets covering stale sessions, address failure, changed economics, risk recovery, split groups, and kill switch.",
    promptUseCase: "ui-mockup",
    source: "built-in-image-gen",
    reviewStatus: "ready-for-design-review",
  }),
  visualArtifact({
    key: "capability-states",
    path: `${checkoutVisualTargetAssetDirectory}/checkout-visual-targets-capability-states.png`,
    alt: "Checkout capability visual targets covering guest sell checkout, disabled saved instruments, promo and credit states, support references, account history, and reversal recovery.",
    promptUseCase: "ui-mockup",
    source: "built-in-image-gen",
    reviewStatus: "ready-for-design-review",
  }),
] as const satisfies readonly CheckoutVisualArtifact[];

export const checkoutVisualSuppliedReferenceFiles = [
  "screencapture-pokebash-co-cart-2026-06-08-20_55_09.png",
  "screencapture-pokebash-co-checkouts-cn-hWND7gfApDDIyRwIKmWZGplZ-en-us-2026-06-08-20_51_29.png",
  "screencapture-pokebash-co-checkouts-cn-hWND7gfApDDIyRwIKmWZGplZ-en-us-2026-06-08-20_53_52.png",
  "screencapture-pokebash-co-checkouts-cn-hWND7gfApDDIyRwIKmWZGplZ-en-us-2026-06-08-20_54_20.png",
  "screencapture-shop-app-checkout-68792320022-cn-hWND7gfApDDIyRwIKmWZGplZ-en-us-shoppay-2026-06-08-20_50_58.png",
  "screencapture-shop-app-checkout-68792320022-cn-hWND7gfApDDIyRwIKmWZGplZ-en-us-shoppay-2026-06-08-20_52_52.png",
  "screencapture-shop-app-checkout-68792320022-cn-hWND7gfApDDIyRwIKmWZGplZ-en-us-shoppay-2026-06-08-20_53_19.png",
] as const;

const universalForbiddenPatterns = [
  "dense-checkout-panel",
  "allocation-control",
  "provider-diagnostic",
  "old-route-recovery",
  "legacy-payload-wording",
  "hidden-repair",
  "nested-card-stack",
  "fake-downstream-completion",
  "migration-backfill-wording",
] as const satisfies readonly CheckoutVisualForbiddenPattern[];

const desktopCheckoutLayout = [
  "desktop-two-column-checkout",
  "no-horizontal-overflow",
] as const satisfies readonly CheckoutVisualLayoutRequirement[];

const mobileCheckoutLayout = [
  "mobile-single-column-checkout",
  "mobile-collapsible-summary",
  "mobile-sticky-primary-action",
  "no-horizontal-overflow",
] as const satisfies readonly CheckoutVisualLayoutRequirement[];

export const checkoutVisualTargets = [
  visualTarget({
    surface: "buy-cart-review-ready",
    docLabel: "Buy Cart review ready",
    ownerIssues: ["#1112", "#1104", "#1117", "#1118"],
    evidenceSources: ["generated-image", "supplied-shopify-reference", "implemented-baseline"],
    artifact: "buy-flow",
    frames: ["1 Desktop Buy Cart review"],
    viewports: ["desktop"],
    copySurface: "cart-list-review",
    performanceSurface: "cart-list-initial-render",
    visibleState: "cart-or-list-review-visible",
    launchRegisterStatus: "not-required",
    layoutRequirements: ["cart-list-before-checkout", "no-horizontal-overflow"],
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: true,
    noSideEffectEvidenceRequired: false,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1115", "#1116"],
    exitEvidence: "Desktop Buy Cart can remain simple while showing readiness before checkout starts.",
  }),
  visualTarget({
    surface: "buy-readiness-unassigned-fulfillment",
    docLabel: "Buy readiness attention",
    ownerIssues: ["#1112", "#1117", "#1118", "#1119", "#1116"],
    evidenceSources: ["generated-image"],
    artifact: "buy-flow",
    frames: ["2 Mobile Buy Cart readiness and savings"],
    viewports: ["mobile"],
    copySurface: "readiness-unassigned-fulfillment",
    performanceSurface: "buy-cart-readiness-evaluation",
    visibleState: "readiness-decision-visible",
    launchRegisterStatus: "required",
    layoutRequirements: ["cart-list-before-checkout", "mobile-single-column-checkout", "no-horizontal-overflow"],
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: true,
    noSideEffectEvidenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Unassigned fulfillment is shown as cart/readiness attention, not checkout form repair.",
  }),
  visualTarget({
    surface: "buy-readiness-optimization",
    docLabel: "Buy readiness savings optimization",
    ownerIssues: ["#1112", "#1117", "#1128", "#1116"],
    evidenceSources: ["generated-image"],
    artifact: "buy-flow",
    frames: ["2 Mobile Buy Cart readiness and savings"],
    viewports: ["mobile"],
    copySurface: "readiness-optimization-offer",
    performanceSurface: "fulfillment-optimization-decision",
    visibleState: "readiness-decision-visible",
    launchRegisterStatus: "not-required",
    layoutRequirements: ["cart-list-before-checkout", "mobile-single-column-checkout", "no-horizontal-overflow"],
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: true,
    noSideEffectEvidenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1102", "#1115"],
    exitEvidence: "Optional savings appear before checkout with accept and keep-current decisions visible.",
  }),
  visualTarget({
    surface: "guest-buy-checkout",
    docLabel: "Guest Buy Checkout",
    ownerIssues: ["#1112", "#1105", "#1107", "#1127", "#1128"],
    evidenceSources: ["generated-image", "supplied-shopify-reference", "implemented-baseline"],
    artifact: "buy-flow",
    frames: ["3 Desktop Guest Buy Checkout"],
    viewports: ["desktop"],
    copySurface: "checkout-review",
    performanceSurface: "checkout-entry-review-render",
    visibleState: "checkout-review-visible",
    launchRegisterStatus: "not-required",
    layoutRequirements: desktopCheckoutLayout,
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: false,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Guest buy checkout follows the Shopify-simple two-column form and summary target.",
  }),
  visualTarget({
    surface: "signed-in-buy-checkout",
    docLabel: "Signed-in Buy Checkout",
    ownerIssues: ["#1112", "#1106", "#1121", "#1113"],
    evidenceSources: ["generated-image", "supplied-shopify-reference", "implemented-baseline"],
    artifact: "buy-flow",
    frames: ["4 Mobile Signed-in Buy Checkout"],
    viewports: ["mobile"],
    copySurface: "checkout-saved-info-rows",
    performanceSurface: "mobile-sticky-action-interaction",
    visibleState: "checkout-review-visible",
    launchRegisterStatus: "not-required",
    layoutRequirements: ["saved-info-editable-rows", ...mobileCheckoutLayout],
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: false,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Signed-in buy checkout uses concise editable saved rows with a sticky mobile primary action.",
  }),
  visualTarget({
    surface: "sell-list-review-ready",
    docLabel: "Sell List review ready",
    ownerIssues: ["#1112", "#1108", "#1118"],
    evidenceSources: ["generated-image", "implemented-baseline"],
    artifact: "sell-flow",
    frames: ["1 Desktop Sell List review"],
    viewports: ["desktop"],
    copySurface: "cart-list-review",
    performanceSurface: "cart-list-initial-render",
    visibleState: "cart-or-list-review-visible",
    launchRegisterStatus: "not-required",
    layoutRequirements: ["cart-list-before-checkout", "no-horizontal-overflow"],
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: true,
    noSideEffectEvidenceRequired: false,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1115", "#1116"],
    exitEvidence: "Sell List review stays role-specific and avoids checkout machinery.",
  }),
  visualTarget({
    surface: "sell-list-readiness-blocked",
    docLabel: "Sell List readiness blocked",
    ownerIssues: ["#1112", "#1117", "#1118", "#1119", "#1121", "#1131", "#1116"],
    evidenceSources: ["generated-image"],
    artifact: "sell-flow",
    frames: ["2 Mobile Sell List readiness"],
    viewports: ["mobile"],
    copySurface: "readiness-blocked-or-unavailable",
    performanceSurface: "sell-list-readiness-evaluation",
    visibleState: "readiness-decision-visible",
    launchRegisterStatus: "required",
    layoutRequirements: ["cart-list-before-checkout", "mobile-single-column-checkout", "no-horizontal-overflow"],
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: true,
    noSideEffectEvidenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Ship-from, payout, and label blockers stay in Sell List readiness before seller checkout.",
  }),
  visualTarget({
    surface: "guest-sell-checkout",
    docLabel: "Guest Sell Checkout",
    ownerIssues: ["#1112", "#1109", "#1121", "#1113"],
    evidenceSources: ["generated-image"],
    artifact: "capability-states",
    frames: ["1 Guest Sell Checkout desktop"],
    viewports: ["desktop"],
    copySurface: "checkout-review",
    performanceSurface: "checkout-entry-review-render",
    visibleState: "checkout-review-visible",
    launchRegisterStatus: "not-required",
    layoutRequirements: desktopCheckoutLayout,
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: false,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Guest seller checkout remains a form-first path without settlement internals.",
  }),
  visualTarget({
    surface: "signed-in-sell-checkout",
    docLabel: "Signed-in Sell Checkout",
    ownerIssues: ["#1112", "#1110", "#1111", "#1121", "#1113"],
    evidenceSources: ["generated-image", "implemented-baseline"],
    artifact: "sell-flow",
    frames: ["3 Desktop Signed-in Seller Checkout"],
    viewports: ["desktop"],
    copySurface: "checkout-saved-info-rows",
    performanceSurface: "checkout-entry-review-render",
    visibleState: "checkout-review-visible",
    launchRegisterStatus: "not-required",
    layoutRequirements: ["saved-info-editable-rows", ...desktopCheckoutLayout],
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: false,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence:
      "Signed-in seller checkout compresses ship-from, payout, label service, and plan facts into editable rows.",
  }),
  visualTarget({
    surface: "seller-confirmation-activity",
    docLabel: "Seller confirmation activity",
    ownerIssues: ["#1112", "#1120", "#1135", "#1129", "#1116"],
    evidenceSources: ["generated-image", "implemented-baseline", "launch-evidence-row"],
    artifact: "sell-flow",
    frames: ["4 Mobile Seller confirmation/activity"],
    viewports: ["mobile"],
    copySurface: "seller-pending-activity",
    performanceSurface: "final-confirmation-visible-state",
    visibleState: "confirmation-visible",
    launchRegisterStatus: "required",
    layoutRequirements: ["pending-vs-committed-separated", "support-safe-reference-visible", ...mobileCheckoutLayout],
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: false,
    pendingDownstreamBoundaryRequired: true,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Seller activity can be recorded while label, payout, notification, and settlement remain pending.",
  }),
  visualTarget({
    surface: "active-session-stale-recovery",
    docLabel: "Active-session stale recovery",
    ownerIssues: ["#1112", "#1118", "#1119", "#1122", "#1116"],
    evidenceSources: ["generated-image", "launch-evidence-row"],
    artifact: "recovery-launch",
    frames: ["1 Active-session stale recovery desktop"],
    viewports: ["desktop"],
    copySurface: "active-session-stale-recovery",
    performanceSurface: "active-session-reload",
    visibleState: "checkout-permanent-recovery-visible",
    launchRegisterStatus: "required",
    layoutRequirements: ["support-safe-reference-visible", "no-horizontal-overflow"],
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Already-open checkout sessions route back to current review facts when source data changes.",
  }),
  visualTarget({
    surface: "address-serviceability-failure",
    docLabel: "Address or serviceability failure",
    ownerIssues: ["#1112", "#1127", "#1121", "#1122", "#1116"],
    evidenceSources: ["generated-image"],
    artifact: "recovery-launch",
    frames: ["2 Address/serviceability failure mobile"],
    viewports: ["mobile"],
    copySurface: "address-correction",
    performanceSurface: "totals-refresh",
    visibleState: "checkout-permanent-recovery-visible",
    launchRegisterStatus: "required",
    layoutRequirements: mobileCheckoutLayout,
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Address recovery stays inline, customer-safe, and visible with the total and next action.",
  }),
  visualTarget({
    surface: "changed-economics-review",
    docLabel: "Changed economics review",
    ownerIssues: ["#1112", "#1119", "#1128", "#1130", "#1116"],
    evidenceSources: ["generated-image"],
    artifact: "recovery-launch",
    frames: ["3 Changed economics desktop"],
    viewports: ["desktop"],
    copySurface: "economics-discount-credit-promo",
    performanceSurface: "totals-refresh",
    visibleState: "checkout-review-visible",
    launchRegisterStatus: "required",
    layoutRequirements: desktopCheckoutLayout,
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Changed totals require customer review before commitment and show that payment has not started.",
  }),
  visualTarget({
    surface: "risk-hold-provider-return-failure",
    docLabel: "Risk hold or provider-return failure",
    ownerIssues: ["#1112", "#1113", "#1131", "#1134", "#1124", "#1116"],
    evidenceSources: ["generated-image"],
    artifact: "recovery-launch",
    frames: ["4 Risk hold/provider return failure mobile"],
    viewports: ["mobile"],
    copySurface: "risk-hold-or-block",
    performanceSurface: "provider-return-confirmation",
    visibleState: "checkout-permanent-recovery-visible",
    launchRegisterStatus: "required",
    layoutRequirements: ["support-safe-reference-visible", ...mobileCheckoutLayout],
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Risk and provider failures keep sensitive signals hidden and provide a support-safe next step.",
  }),
  visualTarget({
    surface: "split-group-summary",
    docLabel: "Split package summary",
    ownerIssues: ["#1112", "#1164", "#1120", "#1130", "#1116"],
    evidenceSources: ["generated-image"],
    artifact: "recovery-launch",
    frames: ["5 Split-group summary desktop"],
    viewports: ["desktop"],
    copySurface: "split-group-summary",
    performanceSurface: "checkout-entry-review-render",
    visibleState: "checkout-review-visible",
    launchRegisterStatus: "required",
    layoutRequirements: desktopCheckoutLayout,
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: false,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Split packages preserve one customer-facing payment action and avoid seller allocation controls.",
  }),
  visualTarget({
    surface: "kill-switch-checkout-unavailable",
    docLabel: "Checkout unavailable",
    ownerIssues: ["#1112", "#1103", "#1116"],
    evidenceSources: ["generated-image", "launch-evidence-row"],
    artifact: "recovery-launch",
    frames: ["6 Launch kill switch/checkout unavailable mobile"],
    viewports: ["mobile"],
    copySurface: "kill-switch-disabled-checkout",
    performanceSurface: "checkout-entry-permanent-recovery-render",
    visibleState: "checkout-permanent-recovery-visible",
    launchRegisterStatus: "required",
    layoutRequirements: mobileCheckoutLayout,
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Kill switches fail closed to review without restoring old checkout surfaces.",
  }),
  visualTarget({
    surface: "temporary-recovery-loading",
    docLabel: "Temporary recovery loading",
    ownerIssues: ["#1112", "#1123", "#1206", "#1114", "#1116"],
    evidenceSources: ["generated-image", "launch-evidence-row"],
    artifact: "recovery-launch",
    frames: ["1 Active-session stale recovery desktop"],
    viewports: ["desktop"],
    copySurface: "checkout-temporary-recovery",
    performanceSurface: "checkout-entry-temporary-recovery-render",
    visibleState: "checkout-temporary-recovery-visible",
    launchRegisterStatus: "required",
    layoutRequirements: ["support-safe-reference-visible", "no-horizontal-overflow"],
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Temporary recovery remains a known Checkout-owned state rather than an ambiguous platform error.",
  }),
  visualTarget({
    surface: "disabled-accelerated-saved-instrument",
    docLabel: "Disabled accelerated or saved instrument",
    ownerIssues: ["#1112", "#1113", "#1121", "#1124", "#1116"],
    evidenceSources: ["generated-image"],
    artifact: "capability-states",
    frames: ["2 Disabled accelerated checkout/saved instrument fallback mobile"],
    viewports: ["mobile"],
    copySurface: "accelerated-saved-instrument-fallback",
    performanceSurface: "payment-payout-setup-handoff",
    visibleState: "payment-or-payout-handoff-visible",
    launchRegisterStatus: "required",
    layoutRequirements: mobileCheckoutLayout,
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence:
      "Convenience methods can be disabled without blocking the simple checkout path or bypassing readiness.",
  }),
  visualTarget({
    surface: "promo-credit-gift-card-state",
    docLabel: "Promo, credit, gift card, and fee state",
    ownerIssues: ["#1112", "#1128", "#1124", "#1116"],
    evidenceSources: ["generated-image"],
    artifact: "capability-states",
    frames: ["3 Promo, credit, gift-card, and fee state desktop"],
    viewports: ["desktop"],
    copySurface: "economics-discount-credit-promo",
    performanceSurface: "totals-refresh",
    visibleState: "checkout-review-visible",
    launchRegisterStatus: "required",
    layoutRequirements: desktopCheckoutLayout,
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Supported and unavailable economics remain visible before the customer commits.",
  }),
  visualTarget({
    surface: "notification-support-reference",
    docLabel: "Notification expectation and support reference",
    ownerIssues: ["#1112", "#1129", "#1122", "#1120", "#1116"],
    evidenceSources: ["generated-image"],
    artifact: "capability-states",
    frames: ["4 Notification expectation and support reference mobile"],
    viewports: ["mobile"],
    copySurface: "notification-expectation",
    performanceSurface: "final-confirmation-visible-state",
    visibleState: "confirmation-visible",
    launchRegisterStatus: "required",
    layoutRequirements: ["pending-vs-committed-separated", "support-safe-reference-visible", ...mobileCheckoutLayout],
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: false,
    pendingDownstreamBoundaryRequired: true,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Notification copy says updates will be sent when ready without promising early delivery.",
  }),
  visualTarget({
    surface: "account-history-handoff",
    docLabel: "Account history handoff",
    ownerIssues: ["#1112", "#1135", "#1120", "#1122", "#1116"],
    evidenceSources: ["generated-image", "implemented-baseline", "launch-evidence-row"],
    artifact: "capability-states",
    frames: ["5 Account history handoff desktop"],
    viewports: ["desktop"],
    copySurface: "account-history-handoff",
    performanceSurface: "account-history-handoff",
    visibleState: "account-history-handoff-visible",
    launchRegisterStatus: "required",
    layoutRequirements: ["pending-vs-committed-separated", "support-safe-reference-visible", "no-horizontal-overflow"],
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: false,
    pendingDownstreamBoundaryRequired: true,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Pending Checkout activity and committed downstream detail appear as separate destinations.",
  }),
  visualTarget({
    surface: "reconciliation-pending",
    docLabel: "Reconciliation pending",
    ownerIssues: ["#1112", "#1130", "#1122", "#1116"],
    evidenceSources: ["generated-image", "launch-evidence-row"],
    artifact: "capability-states",
    frames: ["5 Account history handoff desktop"],
    viewports: ["desktop"],
    copySurface: "account-history-handoff",
    performanceSurface: "support-lookup",
    visibleState: "support-safe-status-visible",
    launchRegisterStatus: "required",
    layoutRequirements: ["pending-vs-committed-separated", "support-safe-reference-visible", "no-horizontal-overflow"],
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: false,
    pendingDownstreamBoundaryRequired: true,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Reconciliation pending states stay support-safe and do not synthesize completed downstream facts.",
  }),
  visualTarget({
    surface: "reversal-recovery-status",
    docLabel: "Reversal and adjustment recovery",
    ownerIssues: ["#1112", "#1165", "#1130", "#1122", "#1116"],
    evidenceSources: ["generated-image"],
    artifact: "capability-states",
    frames: ["6 Reversal and adjustment recovery mobile"],
    viewports: ["mobile"],
    copySurface: "cancellation-refund-reversal",
    performanceSurface: "reversal-recovery-status-refresh",
    visibleState: "reversal-or-recovery-status-visible",
    launchRegisterStatus: "required",
    layoutRequirements: ["pending-vs-committed-separated", "support-safe-reference-visible", ...mobileCheckoutLayout],
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: false,
    noSideEffectEvidenceRequired: false,
    pendingDownstreamBoundaryRequired: true,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Recovery status rows distinguish pending, held, and adjusted facts without provider internals.",
  }),
  visualTarget({
    surface: "fresh-state-cleanup-absence",
    docLabel: "Fresh-state cleanup absence",
    ownerIssues: ["#1112", "#1116", "#1132"],
    evidenceSources: ["generated-image", "launch-evidence-row"],
    artifact: "recovery-launch",
    frames: ["6 Launch kill switch/checkout unavailable mobile"],
    viewports: ["mobile"],
    copySurface: "fresh-state-localization-cleanup",
    performanceSurface: "checkout-entry-permanent-recovery-render",
    visibleState: "checkout-permanent-recovery-visible",
    launchRegisterStatus: "required",
    layoutRequirements: ["cart-list-before-checkout", ...mobileCheckoutLayout],
    forbiddenPatterns: universalForbiddenPatterns,
    readinessBeforeCheckout: true,
    noSideEffectEvidenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    deltaOwnerIssues: ["#1102", "#1115", "#1116"],
    exitEvidence: "Final visual targets include no dense legacy checkout, old route recovery, or compatibility UI.",
  }),
] as const satisfies readonly CheckoutVisualTarget[];

export const checkoutVisualRequiredTargets = [
  "buy-cart-review-ready",
  "buy-readiness-unassigned-fulfillment",
  "buy-readiness-optimization",
  "guest-buy-checkout",
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
  "kill-switch-checkout-unavailable",
  "temporary-recovery-loading",
  "disabled-accelerated-saved-instrument",
  "promo-credit-gift-card-state",
  "notification-support-reference",
  "account-history-handoff",
  "reconciliation-pending",
  "reversal-recovery-status",
  "fresh-state-cleanup-absence",
] as const satisfies readonly CheckoutVisualTargetKey[];

export function assertCheckoutVisualTargetCoverage(): void {
  const artifactsByKey = new Map(checkoutVisualTargetArtifacts.map((artifact) => [artifact.key, artifact]));
  const targetsBySurface = new Map(checkoutVisualTargets.map((target) => [target.surface, target]));

  for (const requiredTarget of checkoutVisualRequiredTargets) {
    if (!targetsBySurface.has(requiredTarget)) {
      throw new Error(`Missing Checkout visual target '${requiredTarget}'.`);
    }
  }

  if (targetsBySurface.size !== checkoutVisualTargets.length) {
    throw new Error("Checkout visual target surfaces must be unique.");
  }

  for (const artifact of checkoutVisualTargetArtifacts) {
    if (!artifact.path.startsWith(`${checkoutVisualTargetAssetDirectory}/`)) {
      throw new Error(`Checkout visual artifact '${artifact.key}' is outside the visual target directory.`);
    }
    if (!artifact.path.endsWith(".png")) {
      throw new Error(`Checkout visual artifact '${artifact.key}' must be a PNG review artifact.`);
    }
  }

  for (const artifact of checkoutVisualTargetArtifacts) {
    if (!checkoutVisualTargets.some((target) => target.artifact === artifact.key)) {
      throw new Error(`Checkout visual artifact '${artifact.key}' is not referenced by any target.`);
    }
  }

  for (const target of checkoutVisualTargets) {
    if (!artifactsByKey.has(target.artifact)) {
      throw new Error(`Checkout visual target '${target.surface}' references an unknown artifact.`);
    }
    if (!target.ownerIssues.includes("#1112")) {
      throw new Error(`Checkout visual target '${target.surface}' must be owned by #1112.`);
    }
    if (target.frames.length === 0 || target.viewports.length === 0) {
      throw new Error(`Checkout visual target '${target.surface}' needs frames and viewports.`);
    }
    if (target.deltaOwnerIssues.length === 0) {
      throw new Error(`Checkout visual target '${target.surface}' needs a delta owner.`);
    }
    for (const pattern of universalForbiddenPatterns) {
      if (!target.forbiddenPatterns.includes(pattern)) {
        throw new Error(`Checkout visual target '${target.surface}' must forbid ${pattern}.`);
      }
    }
    if (target.launchRegisterStatus === "required" && !target.ownerIssues.includes("#1116")) {
      throw new Error(`Checkout visual target '${target.surface}' needs #1116 when launch register is required.`);
    }
    if (target.copySurface.length === 0 || target.performanceSurface.length === 0) {
      throw new Error(`Checkout visual target '${target.surface}' needs copy and performance mappings.`);
    }
    if (
      target.noSideEffectEvidenceRequired &&
      !target.ownerIssues.some((issue) => issue === "#1116" || issue === "#1122")
    ) {
      throw new Error(
        `Checkout visual target '${target.surface}' needs launch/support ownership for no-side-effect proof.`,
      );
    }
    if (
      target.pendingDownstreamBoundaryRequired &&
      !target.layoutRequirements.includes("pending-vs-committed-separated")
    ) {
      throw new Error(`Checkout visual target '${target.surface}' must separate pending and committed facts.`);
    }
  }

  const readinessTargets = checkoutVisualTargets.filter((target) => target.copySurface.startsWith("readiness-"));
  for (const target of readinessTargets) {
    if (!target.readinessBeforeCheckout || !target.layoutRequirements.includes("cart-list-before-checkout")) {
      throw new Error(`Checkout visual target '${target.surface}' must stay before checkout.`);
    }
  }
}

function visualArtifact(input: CheckoutVisualArtifact): CheckoutVisualArtifact {
  return input;
}

function visualTarget(input: CheckoutVisualTarget): CheckoutVisualTarget {
  return input;
}
