export const checkoutPerformanceBudgetDocPath =
  "bounded-contexts/checkout/docs/checkout-performance-budgets.md" as const;

export const checkoutPerformancePlatformGatewayTimeoutMs = 45_000;

export type CheckoutPerformanceEnvironment = "local" | "staging" | "production-like";

export type CheckoutPerformanceEntrySource = "buy-now" | "buy-cart-readiness" | "sell-list-readiness";

export type CheckoutPerformanceActorMode = "guest" | "signed-in";

export type CheckoutPerformanceVisibleState =
  | "cart-or-list-review-visible"
  | "readiness-decision-visible"
  | "checkout-review-visible"
  | "checkout-temporary-recovery-visible"
  | "checkout-permanent-recovery-visible"
  | "confirmation-visible"
  | "payment-or-payout-handoff-visible"
  | "account-history-handoff-visible"
  | "support-safe-status-visible"
  | "reversal-or-recovery-status-visible";

export type CheckoutPerformanceVerificationKind =
  | "unit-contract"
  | "route-test"
  | "e2e"
  | "visual-mobile"
  | "accessibility"
  | "canary"
  | "metrics"
  | "runbook";

export type CheckoutSideEffectClass =
  | "payment"
  | "order"
  | "label"
  | "payout"
  | "settlement"
  | "notification"
  | "account-history"
  | "support";

export type CheckoutPerformanceSurfaceKey =
  | "cart-list-initial-render"
  | "buy-cart-readiness-evaluation"
  | "sell-list-readiness-evaluation"
  | "fulfillment-optimization-decision"
  | "checkout-entry-review-render"
  | "checkout-entry-temporary-recovery-render"
  | "checkout-entry-permanent-recovery-render"
  | "active-session-reload"
  | "totals-refresh"
  | "payment-payout-setup-handoff"
  | "final-confirmation-visible-state"
  | "provider-return-confirmation"
  | "account-history-handoff"
  | "support-lookup"
  | "reversal-recovery-status-refresh"
  | "mobile-sticky-action-interaction";

export type CheckoutPerformanceBudget = Readonly<{
  surface: CheckoutPerformanceSurfaceKey;
  docLabel: string;
  ownerIssue: "#1123" | "#1115" | "#1164" | "#1165";
  pathRole: string;
  entrySources: readonly CheckoutPerformanceEntrySource[];
  actorModes: readonly CheckoutPerformanceActorMode[];
  p95Ms: number;
  timeoutMs: number;
  gatewayHeadroomMs: number;
  maxLines: number;
  maxFulfillmentGroups: number;
  maxSummaryRows: number;
  visibleStates: readonly CheckoutPerformanceVisibleState[];
  ambiguousNoStateFails: true;
  skeletonOrPendingStateRequired: boolean;
  sideEffectsForbiddenBeforeExplicitConfirm: readonly CheckoutSideEffectClass[];
  environments: readonly CheckoutPerformanceEnvironment[];
  verification: readonly CheckoutPerformanceVerificationKind[];
  coverageNote: string;
}>;

const allEnvironments = [
  "local",
  "staging",
  "production-like",
] as const satisfies readonly CheckoutPerformanceEnvironment[];
const allEntrySources = [
  "buy-now",
  "buy-cart-readiness",
  "sell-list-readiness",
] as const satisfies readonly CheckoutPerformanceEntrySource[];
const allActorModes = ["guest", "signed-in"] as const satisfies readonly CheckoutPerformanceActorMode[];
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

export const checkoutPerformanceBudgets = [
  budget({
    surface: "cart-list-initial-render",
    docLabel: "Cart/list initial render",
    ownerIssue: "#1123",
    pathRole: "Show the mutable Buy Cart or Sell List review without checkout machinery.",
    entrySources: ["buy-cart-readiness", "sell-list-readiness"],
    actorModes: allActorModes,
    p95Ms: 900,
    timeoutMs: 3_000,
    gatewayHeadroomMs: 35_000,
    maxLines: 50,
    maxFulfillmentGroups: 8,
    maxSummaryRows: 60,
    visibleStates: ["cart-or-list-review-visible"],
    ambiguousNoStateFails: true,
    skeletonOrPendingStateRequired: true,
    sideEffectsForbiddenBeforeExplicitConfirm: downstreamSideEffects,
    environments: allEnvironments,
    verification: ["route-test", "e2e", "visual-mobile", "metrics"],
    coverageNote:
      "Buy Cart and Sell List review render within budget for ready, blocked, stale, and empty states on desktop and mobile.",
  }),
  budget({
    surface: "buy-cart-readiness-evaluation",
    docLabel: "Buy Cart readiness evaluation",
    ownerIssue: "#1123",
    pathRole: "Resolve Buy Cart fulfillment readiness before checkout entry.",
    entrySources: ["buy-cart-readiness"],
    actorModes: allActorModes,
    p95Ms: 1_250,
    timeoutMs: 5_000,
    gatewayHeadroomMs: 35_000,
    maxLines: 50,
    maxFulfillmentGroups: 8,
    maxSummaryRows: 60,
    visibleStates: ["readiness-decision-visible"],
    ambiguousNoStateFails: true,
    skeletonOrPendingStateRequired: true,
    sideEffectsForbiddenBeforeExplicitConfirm: downstreamSideEffects,
    environments: allEnvironments,
    verification: ["unit-contract", "route-test", "e2e", "metrics"],
    coverageNote:
      "Readiness cases cover ready carts, unresolved fulfillment, no-supply recovery, save-for-later, and source mutation.",
  }),
  budget({
    surface: "sell-list-readiness-evaluation",
    docLabel: "Sell List readiness evaluation",
    ownerIssue: "#1123",
    pathRole:
      "Resolve Sell List sale-action, ship-from, payout, label, and item-readiness blockers before seller checkout.",
    entrySources: ["sell-list-readiness"],
    actorModes: allActorModes,
    p95Ms: 1_500,
    timeoutMs: 5_000,
    gatewayHeadroomMs: 35_000,
    maxLines: 50,
    maxFulfillmentGroups: 8,
    maxSummaryRows: 60,
    visibleStates: ["readiness-decision-visible"],
    ambiguousNoStateFails: true,
    skeletonOrPendingStateRequired: true,
    sideEffectsForbiddenBeforeExplicitConfirm: downstreamSideEffects,
    environments: allEnvironments,
    verification: ["unit-contract", "route-test", "e2e", "metrics"],
    coverageNote:
      "Readiness cases cover selected offers, Smart Match offers, fallback listing decisions, stale payout/terms, and blocked seller facts.",
  }),
  budget({
    surface: "fulfillment-optimization-decision",
    docLabel: "Fulfillment optimization decision",
    ownerIssue: "#1123",
    pathRole: "Show optional savings before checkout without running allocation inside checkout.",
    entrySources: ["buy-cart-readiness"],
    actorModes: allActorModes,
    p95Ms: 1_500,
    timeoutMs: 5_000,
    gatewayHeadroomMs: 35_000,
    maxLines: 50,
    maxFulfillmentGroups: 8,
    maxSummaryRows: 60,
    visibleStates: ["readiness-decision-visible"],
    ambiguousNoStateFails: true,
    skeletonOrPendingStateRequired: true,
    sideEffectsForbiddenBeforeExplicitConfirm: downstreamSideEffects,
    environments: allEnvironments,
    verification: ["route-test", "e2e", "visual-mobile", "metrics"],
    coverageNote:
      "Optimization coverage records accepted, declined, unavailable, and stale outcomes before checkout session creation.",
  }),
  budget({
    surface: "checkout-entry-review-render",
    docLabel: "Checkout entry review render",
    ownerIssue: "#1123",
    pathRole: "Render checkout review after a valid fresh handoff.",
    entrySources: allEntrySources,
    actorModes: allActorModes,
    p95Ms: 2_500,
    timeoutMs: 8_000,
    gatewayHeadroomMs: 30_000,
    maxLines: 50,
    maxFulfillmentGroups: 8,
    maxSummaryRows: 60,
    visibleStates: ["checkout-review-visible"],
    ambiguousNoStateFails: true,
    skeletonOrPendingStateRequired: true,
    sideEffectsForbiddenBeforeExplicitConfirm: downstreamSideEffects,
    environments: allEnvironments,
    verification: ["route-test", "e2e", "canary", "metrics"],
    coverageNote:
      "Canary or E2E coverage reports time to checkout review for Buy Now, Buy Cart readiness, and Sell List readiness.",
  }),
  budget({
    surface: "checkout-entry-temporary-recovery-render",
    docLabel: "Checkout entry temporary recovery",
    ownerIssue: "#1123",
    pathRole: "Render Checkout-owned temporary recovery while a valid fresh-write handoff can still catch up.",
    entrySources: allEntrySources,
    actorModes: allActorModes,
    p95Ms: 3_000,
    timeoutMs: 8_000,
    gatewayHeadroomMs: 30_000,
    maxLines: 50,
    maxFulfillmentGroups: 8,
    maxSummaryRows: 60,
    visibleStates: ["checkout-temporary-recovery-visible"],
    ambiguousNoStateFails: true,
    skeletonOrPendingStateRequired: true,
    sideEffectsForbiddenBeforeExplicitConfirm: downstreamSideEffects,
    environments: allEnvironments,
    verification: ["route-test", "e2e", "canary", "metrics"],
    coverageNote:
      "Coverage distinguishes safe temporary recovery from platform error, permanent not-found, missing receipt, and ambiguous no-state render.",
  }),
  budget({
    surface: "checkout-entry-permanent-recovery-render",
    docLabel: "Checkout entry permanent recovery",
    ownerIssue: "#1123",
    pathRole: "Render customer-safe permanent recovery for expired, invalid, unsupported, or blocked handoffs.",
    entrySources: allEntrySources,
    actorModes: allActorModes,
    p95Ms: 1_500,
    timeoutMs: 5_000,
    gatewayHeadroomMs: 35_000,
    maxLines: 50,
    maxFulfillmentGroups: 8,
    maxSummaryRows: 60,
    visibleStates: ["checkout-permanent-recovery-visible"],
    ambiguousNoStateFails: true,
    skeletonOrPendingStateRequired: false,
    sideEffectsForbiddenBeforeExplicitConfirm: downstreamSideEffects,
    environments: allEnvironments,
    verification: ["route-test", "e2e", "visual-mobile", "accessibility"],
    coverageNote:
      "Recovery cases cover expired receipt, old payload, stale readiness, disabled capability, and kill-switched entry.",
  }),
  budget({
    surface: "active-session-reload",
    docLabel: "Active session reload",
    ownerIssue: "#1123",
    pathRole: "Reload or browser-return an existing active checkout session into review or recovery.",
    entrySources: allEntrySources,
    actorModes: allActorModes,
    p95Ms: 2_000,
    timeoutMs: 8_000,
    gatewayHeadroomMs: 30_000,
    maxLines: 50,
    maxFulfillmentGroups: 8,
    maxSummaryRows: 60,
    visibleStates: ["checkout-review-visible", "checkout-permanent-recovery-visible"],
    ambiguousNoStateFails: true,
    skeletonOrPendingStateRequired: true,
    sideEffectsForbiddenBeforeExplicitConfirm: downstreamSideEffects,
    environments: allEnvironments,
    verification: ["route-test", "e2e", "metrics"],
    coverageNote:
      "Reload cases cover current sessions, stale source facts, guest merge supersession, and duplicate submit prevention.",
  }),
  budget({
    surface: "totals-refresh",
    docLabel: "Totals refresh",
    ownerIssue: "#1123",
    pathRole:
      "Refresh shipping, tax, fee, credit, discount, payout, and seller-term totals without hidden confirmation.",
    entrySources: allEntrySources,
    actorModes: allActorModes,
    p95Ms: 2_000,
    timeoutMs: 8_000,
    gatewayHeadroomMs: 30_000,
    maxLines: 50,
    maxFulfillmentGroups: 8,
    maxSummaryRows: 60,
    visibleStates: ["checkout-review-visible", "checkout-permanent-recovery-visible"],
    ambiguousNoStateFails: true,
    skeletonOrPendingStateRequired: true,
    sideEffectsForbiddenBeforeExplicitConfirm: downstreamSideEffects,
    environments: allEnvironments,
    verification: ["route-test", "e2e", "visual-mobile", "metrics"],
    coverageNote:
      "Totals coverage records changed, unchanged, timeout, stale quote, and customer-review-required outcomes.",
  }),
  budget({
    surface: "payment-payout-setup-handoff",
    docLabel: "Payment/payout setup handoff",
    ownerIssue: "#1123",
    pathRole: "Move to payment detail, wallet review, payout setup, or provider-owned readiness from checkout.",
    entrySources: allEntrySources,
    actorModes: allActorModes,
    p95Ms: 2_500,
    timeoutMs: 10_000,
    gatewayHeadroomMs: 30_000,
    maxLines: 50,
    maxFulfillmentGroups: 8,
    maxSummaryRows: 60,
    visibleStates: ["payment-or-payout-handoff-visible", "checkout-permanent-recovery-visible"],
    ambiguousNoStateFails: true,
    skeletonOrPendingStateRequired: true,
    sideEffectsForbiddenBeforeExplicitConfirm: downstreamSideEffects,
    environments: allEnvironments,
    verification: ["route-test", "e2e", "metrics"],
    coverageNote:
      "Handoff coverage distinguishes payment/payout setup visibility from order, sale, label, payout, or account-history completion.",
  }),
  budget({
    surface: "final-confirmation-visible-state",
    docLabel: "Final confirmation visible state",
    ownerIssue: "#1123",
    pathRole: "After explicit final confirmation, show confirmation, downstream pending, or customer-safe recovery.",
    entrySources: allEntrySources,
    actorModes: allActorModes,
    p95Ms: 3_500,
    timeoutMs: 12_000,
    gatewayHeadroomMs: 25_000,
    maxLines: 50,
    maxFulfillmentGroups: 8,
    maxSummaryRows: 60,
    visibleStates: ["confirmation-visible", "checkout-permanent-recovery-visible"],
    ambiguousNoStateFails: true,
    skeletonOrPendingStateRequired: true,
    sideEffectsForbiddenBeforeExplicitConfirm: [],
    environments: allEnvironments,
    verification: ["route-test", "e2e", "visual-mobile", "accessibility", "metrics"],
    coverageNote:
      "Confirmation coverage records confirmation visible, downstream pending, stale confirmation blocked, duplicate submit, and partial failure recovery.",
  }),
  budget({
    surface: "provider-return-confirmation",
    docLabel: "Provider-return confirmation",
    ownerIssue: "#1123",
    pathRole: "Return from payment, identity, payout, or wallet provider into a Checkout-owned state.",
    entrySources: allEntrySources,
    actorModes: allActorModes,
    p95Ms: 3_000,
    timeoutMs: 12_000,
    gatewayHeadroomMs: 25_000,
    maxLines: 50,
    maxFulfillmentGroups: 8,
    maxSummaryRows: 60,
    visibleStates: ["confirmation-visible", "checkout-permanent-recovery-visible", "support-safe-status-visible"],
    ambiguousNoStateFails: true,
    skeletonOrPendingStateRequired: true,
    sideEffectsForbiddenBeforeExplicitConfirm: [],
    environments: allEnvironments,
    verification: ["route-test", "e2e", "metrics", "runbook"],
    coverageNote:
      "Provider-return coverage distinguishes confirmed, pending provider completion, provider failure, stale readiness, and support-safe recovery.",
  }),
  budget({
    surface: "account-history-handoff",
    docLabel: "Account-history handoff",
    ownerIssue: "#1123",
    pathRole:
      "Expose buyer order history, seller activity, committed sale/order links, or pending downstream activity.",
    entrySources: allEntrySources,
    actorModes: ["signed-in"],
    p95Ms: 2_500,
    timeoutMs: 10_000,
    gatewayHeadroomMs: 30_000,
    maxLines: 50,
    maxFulfillmentGroups: 8,
    maxSummaryRows: 80,
    visibleStates: ["account-history-handoff-visible", "support-safe-status-visible"],
    ambiguousNoStateFails: true,
    skeletonOrPendingStateRequired: true,
    sideEffectsForbiddenBeforeExplicitConfirm: [],
    environments: allEnvironments,
    verification: ["route-test", "e2e", "visual-mobile", "metrics"],
    coverageNote:
      "Account-history coverage distinguishes Checkout pending activity from committed Ordering, Fulfillment, Settlement, and Notification facts.",
  }),
  budget({
    surface: "support-lookup",
    docLabel: "Support lookup",
    ownerIssue: "#1123",
    pathRole: "Resolve support-safe checkout, confirmation, handoff, and downstream status references.",
    entrySources: allEntrySources,
    actorModes: allActorModes,
    p95Ms: 2_000,
    timeoutMs: 8_000,
    gatewayHeadroomMs: 30_000,
    maxLines: 50,
    maxFulfillmentGroups: 8,
    maxSummaryRows: 80,
    visibleStates: ["support-safe-status-visible"],
    ambiguousNoStateFails: true,
    skeletonOrPendingStateRequired: true,
    sideEffectsForbiddenBeforeExplicitConfirm: [],
    environments: allEnvironments,
    verification: ["route-test", "e2e", "metrics", "runbook"],
    coverageNote:
      "Support coverage uses support-safe references without raw provider payloads, old receipt rows, or dense checkout fallback.",
  }),
  budget({
    surface: "reversal-recovery-status-refresh",
    docLabel: "Reversal/recovery status refresh",
    ownerIssue: "#1165",
    pathRole:
      "Refresh cancellation, refund, void, label cancellation, payout hold/reversal, and adjustment recovery status.",
    entrySources: allEntrySources,
    actorModes: allActorModes,
    p95Ms: 2_500,
    timeoutMs: 10_000,
    gatewayHeadroomMs: 30_000,
    maxLines: 50,
    maxFulfillmentGroups: 8,
    maxSummaryRows: 80,
    visibleStates: ["reversal-or-recovery-status-visible", "support-safe-status-visible"],
    ambiguousNoStateFails: true,
    skeletonOrPendingStateRequired: true,
    sideEffectsForbiddenBeforeExplicitConfirm: [],
    environments: allEnvironments,
    verification: ["route-test", "e2e", "metrics", "runbook"],
    coverageNote:
      "Recovery cases cover pending, recovered, failed, duplicate-prevented, support-owned, and owned deferred states.",
  }),
  budget({
    surface: "mobile-sticky-action-interaction",
    docLabel: "Mobile sticky action interaction",
    ownerIssue: "#1115",
    pathRole: "Keep mobile sticky totals, summaries, saved rows, and primary actions responsive.",
    entrySources: allEntrySources,
    actorModes: allActorModes,
    p95Ms: 200,
    timeoutMs: 1_000,
    gatewayHeadroomMs: 40_000,
    maxLines: 50,
    maxFulfillmentGroups: 8,
    maxSummaryRows: 80,
    visibleStates: [
      "cart-or-list-review-visible",
      "checkout-review-visible",
      "confirmation-visible",
      "checkout-permanent-recovery-visible",
    ],
    ambiguousNoStateFails: true,
    skeletonOrPendingStateRequired: false,
    sideEffectsForbiddenBeforeExplicitConfirm: downstreamSideEffects,
    environments: allEnvironments,
    verification: ["visual-mobile", "accessibility", "e2e"],
    coverageNote:
      "Mobile checks record sticky action tap latency, summary expand/collapse, saved-row editing, no horizontal overflow, and no layout shift.",
  }),
] as const satisfies readonly CheckoutPerformanceBudget[];

export const checkoutPerformanceRequiredSurfaces = [
  "cart-list-initial-render",
  "buy-cart-readiness-evaluation",
  "sell-list-readiness-evaluation",
  "fulfillment-optimization-decision",
  "checkout-entry-review-render",
  "checkout-entry-temporary-recovery-render",
  "checkout-entry-permanent-recovery-render",
  "active-session-reload",
  "totals-refresh",
  "payment-payout-setup-handoff",
  "final-confirmation-visible-state",
  "provider-return-confirmation",
  "account-history-handoff",
  "support-lookup",
  "reversal-recovery-status-refresh",
  "mobile-sticky-action-interaction",
] as const satisfies readonly CheckoutPerformanceSurfaceKey[];

export function assertCheckoutPerformanceBudgetCoverage(): void {
  const bySurface = new Map(checkoutPerformanceBudgets.map((budgetEntry) => [budgetEntry.surface, budgetEntry]));

  for (const surface of checkoutPerformanceRequiredSurfaces) {
    if (!bySurface.has(surface)) {
      throw new Error(`Missing Checkout performance budget for '${surface}'.`);
    }
  }

  for (const budgetEntry of checkoutPerformanceBudgets) {
    if (budgetEntry.p95Ms <= 0 || budgetEntry.timeoutMs < budgetEntry.p95Ms) {
      throw new Error(`Invalid latency budget for '${budgetEntry.surface}'.`);
    }
    if (budgetEntry.docLabel.trim().length === 0) {
      throw new Error(`Checkout performance budget '${budgetEntry.surface}' needs a documentation label.`);
    }
    if (budgetEntry.timeoutMs + budgetEntry.gatewayHeadroomMs > checkoutPerformancePlatformGatewayTimeoutMs) {
      throw new Error(`Checkout performance budget '${budgetEntry.surface}' can outlive the platform gateway.`);
    }
    if (budgetEntry.visibleStates.length === 0) {
      throw new Error(`Checkout performance budget '${budgetEntry.surface}' has no visible state target.`);
    }
    if (budgetEntry.ambiguousNoStateFails !== true) {
      throw new Error(`Checkout performance budget '${budgetEntry.surface}' must fail ambiguous no-state renders.`);
    }
    for (const environment of allEnvironments) {
      if (!budgetEntry.environments.includes(environment)) {
        throw new Error(`Checkout performance budget '${budgetEntry.surface}' is missing ${environment} coverage.`);
      }
    }
    if (budgetEntry.maxLines < 1 || budgetEntry.maxFulfillmentGroups < 1 || budgetEntry.maxSummaryRows < 1) {
      throw new Error(`Checkout performance budget '${budgetEntry.surface}' has invalid supported shape limits.`);
    }
    if (budgetEntry.maxSummaryRows < budgetEntry.maxLines) {
      throw new Error(
        `Checkout performance budget '${budgetEntry.surface}' cannot summarize its supported line count.`,
      );
    }
  }

  const checkoutEntryBudgets = checkoutPerformanceBudgets.filter((budgetEntry) =>
    budgetEntry.surface.startsWith("checkout-entry-"),
  );

  for (const entrySource of allEntrySources) {
    for (const actorMode of allActorModes) {
      if (
        !checkoutEntryBudgets.every(
          (budgetEntry) => budgetEntry.entrySources.includes(entrySource) && budgetEntry.actorModes.includes(actorMode),
        )
      ) {
        throw new Error(`Checkout entry budgets are missing ${actorMode} ${entrySource} coverage.`);
      }
    }
  }

  const preConfirmationSurfaces = checkoutPerformanceBudgets.filter(
    (budgetEntry) =>
      budgetEntry.surface !== "final-confirmation-visible-state" &&
      budgetEntry.surface !== "provider-return-confirmation" &&
      budgetEntry.surface !== "account-history-handoff" &&
      budgetEntry.surface !== "support-lookup" &&
      budgetEntry.surface !== "reversal-recovery-status-refresh",
  );

  for (const budgetEntry of preConfirmationSurfaces) {
    for (const sideEffect of downstreamSideEffects) {
      if (!budgetEntry.sideEffectsForbiddenBeforeExplicitConfirm.includes(sideEffect)) {
        throw new Error(
          `Checkout performance budget '${budgetEntry.surface}' must forbid ${sideEffect} before explicit confirmation.`,
        );
      }
    }
  }

  const compositeShapeBudgets = checkoutPerformanceBudgets.filter(
    (budgetEntry) => budgetEntry.maxFulfillmentGroups > 1,
  );
  for (const budgetEntry of compositeShapeBudgets) {
    if (!budgetEntry.verification.some((kind) => kind === "e2e" || kind === "metrics" || kind === "canary")) {
      throw new Error(`Multi-group budget '${budgetEntry.surface}' needs composite-shape coverage.`);
    }
  }
}

function budget(input: CheckoutPerformanceBudget): CheckoutPerformanceBudget {
  return input;
}
