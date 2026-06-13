export const checkoutRiskControlPolicyDocPath =
  "bounded-contexts/checkout/docs/checkout-risk-control-policy.md" as const;

export type CheckoutRiskAudience =
  | "guest-buyer"
  | "signed-in-buyer"
  | "guest-seller"
  | "signed-in-seller"
  | "support-operator";

export type CheckoutRiskOwnerContext =
  | "Checkout"
  | "Marketplace"
  | "Payments"
  | "Settlement"
  | "Identity"
  | "Inventory"
  | "Fulfillment"
  | "Support"
  | "Platform";

export type CheckoutRiskCheckpoint =
  | "cart-list-readiness"
  | "checkout-session-create"
  | "active-session-return"
  | "provider-or-wallet-return"
  | "guest-merge"
  | "duplicate-submit"
  | "reservation-renew-or-expire"
  | "final-confirmation"
  | "operator-support";

export type CheckoutRiskOutcome =
  | "allowed"
  | "blocked"
  | "held"
  | "challenged"
  | "disabled"
  | "deferred"
  | "unsupported"
  | "provider-unavailable"
  | "recovered"
  | "no-side-effect";

export type CheckoutRiskSurface =
  | "cart-list-readiness"
  | "checkout-recovery"
  | "provider-return-recovery"
  | "confirmation-hold"
  | "support-runbook"
  | "launch-evidence"
  | "none";

export type CheckoutRiskLaunchDecision = "required-for-launch" | "launch-decision-required" | "not-customer-facing";

export type CheckoutRiskProtectedAction =
  | "buy-cart-line-capture"
  | "buy-readiness-evaluation"
  | "buy-checkout-session-create"
  | "buy-final-confirmation"
  | "sell-list-line-capture"
  | "sell-readiness-evaluation"
  | "sell-checkout-session-create"
  | "sell-final-confirmation"
  | "payment-authorization-or-capture"
  | "payout-setup-or-eligibility"
  | "inventory-reservation"
  | "support-escalation";

export type CheckoutRiskOwnerIssue =
  | "#1102"
  | "#1112"
  | "#1113"
  | "#1114"
  | "#1115"
  | "#1548"
  | "#1117"
  | "#1118"
  | "#1119"
  | "#1121"
  | "#1122"
  | "#1123"
  | "#1124"
  | "#1127"
  | "#1128"
  | "#1130"
  | "#1131"
  | "#1134"
  | "#1135"
  | "#1164"
  | "#1165";

export type CheckoutRiskControlKey =
  | "guest-velocity-and-bot-protection"
  | "signed-in-velocity-and-duplicate-attempts"
  | "inventory-hoarding-and-reservation-limits"
  | "payment-provider-risk-decline-or-hold"
  | "payout-provider-risk-hold"
  | "seller-readiness-and-listing-abuse"
  | "address-contact-payment-payout-mismatch"
  | "active-session-risk-revalidation"
  | "guest-merge-abuse"
  | "duplicate-submit-idempotency"
  | "support-safe-risk-escalation"
  | "launch-decision-risk-states"
  | "observability-redaction"
  | "no-side-effect-risk-blocks"
  | "fresh-state-risk-cleanup";

export type CheckoutRiskControlPolicyEntry = Readonly<{
  control: CheckoutRiskControlKey;
  docLabel: string;
  ownerIssues: readonly CheckoutRiskOwnerIssue[];
  ownerContext: CheckoutRiskOwnerContext;
  checkpoints: readonly CheckoutRiskCheckpoint[];
  protectedActions: readonly CheckoutRiskProtectedAction[];
  audiences: readonly CheckoutRiskAudience[];
  outcomeStates: readonly CheckoutRiskOutcome[];
  customerSurface: CheckoutRiskSurface;
  launchDecision: CheckoutRiskLaunchDecision;
  supportReferenceRequired: boolean;
  observabilityRequired: boolean;
  launchDecisionRequired: boolean;
  noSideEffectBeforeCommitRequired: boolean;
  redactsSensitiveSignals: boolean;
  staysBeforeCheckout: boolean;
  idempotencyKeyShape: string;
  forbiddenMechanisms: readonly string[];
  evidenceExpectation: string;
}>;

const buyerAudiences = ["guest-buyer", "signed-in-buyer"] as const satisfies readonly CheckoutRiskAudience[];
const sellerAudiences = ["guest-seller", "signed-in-seller"] as const satisfies readonly CheckoutRiskAudience[];
const allCustomerAudiences = [
  "guest-buyer",
  "signed-in-buyer",
  "guest-seller",
  "signed-in-seller",
] as const satisfies readonly CheckoutRiskAudience[];
const allAudiences = [
  "guest-buyer",
  "signed-in-buyer",
  "guest-seller",
  "signed-in-seller",
  "support-operator",
] as const satisfies readonly CheckoutRiskAudience[];

export const checkoutRiskForbiddenMechanisms = [
  "old checkout payload translation",
  "old sell execution replay",
  "old receipt-row repair",
  "dense checkout fallback",
  "legacy route recovery",
  "migration/backfill compatibility",
  "dual-write compatibility",
  "hidden repair",
  "manual database edit",
  "provider-dashboard-only fix",
  "stale fixture bypass",
  "raw provider payload exposure",
  "sensitive risk signal exposure",
] as const;

export const checkoutRiskControlRequiredControls = [
  "guest-velocity-and-bot-protection",
  "signed-in-velocity-and-duplicate-attempts",
  "inventory-hoarding-and-reservation-limits",
  "payment-provider-risk-decline-or-hold",
  "payout-provider-risk-hold",
  "seller-readiness-and-listing-abuse",
  "address-contact-payment-payout-mismatch",
  "active-session-risk-revalidation",
  "guest-merge-abuse",
  "duplicate-submit-idempotency",
  "support-safe-risk-escalation",
  "launch-decision-risk-states",
  "observability-redaction",
  "no-side-effect-risk-blocks",
  "fresh-state-risk-cleanup",
] as const satisfies readonly CheckoutRiskControlKey[];

export const checkoutRiskControlPolicyEntries = [
  riskControl({
    control: "guest-velocity-and-bot-protection",
    docLabel: "Guest velocity and bot protection",
    ownerIssues: ["#1131", "#1118", "#1114", "#1115", "#1123"],
    ownerContext: "Checkout",
    checkpoints: ["cart-list-readiness", "checkout-session-create", "final-confirmation"],
    protectedActions: ["buy-cart-line-capture", "buy-checkout-session-create", "buy-final-confirmation"],
    audiences: ["guest-buyer"],
    outcomeStates: ["allowed", "blocked", "no-side-effect"],
    customerSurface: "cart-list-readiness",
    launchDecision: "required-for-launch",
    supportReferenceRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: false,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveSignals: true,
    staysBeforeCheckout: true,
    idempotencyKeyShape: "checkout:risk:guest_velocity:<device-or-session-fingerprint>:<window>",
    forbiddenMechanisms: checkoutRiskForbiddenMechanisms,
    evidenceExpectation:
      "Guest buy velocity and bot limits block excessive line capture or checkout entry before any payment, order, support, notification, or reservation side effect starts.",
  }),
  riskControl({
    control: "signed-in-velocity-and-duplicate-attempts",
    docLabel: "Signed-in velocity and duplicate attempts",
    ownerIssues: ["#1131", "#1118", "#1119", "#1130"],
    ownerContext: "Checkout",
    checkpoints: ["checkout-session-create", "duplicate-submit", "final-confirmation"],
    protectedActions: [
      "buy-checkout-session-create",
      "buy-final-confirmation",
      "sell-checkout-session-create",
      "sell-final-confirmation",
    ],
    audiences: ["signed-in-buyer", "signed-in-seller"],
    outcomeStates: ["allowed", "blocked", "recovered", "no-side-effect"],
    customerSurface: "checkout-recovery",
    launchDecision: "required-for-launch",
    supportReferenceRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: false,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveSignals: true,
    staysBeforeCheckout: false,
    idempotencyKeyShape: "checkout:risk:account_velocity:<account-id-redacted>:<intent-id>:<purpose>",
    forbiddenMechanisms: checkoutRiskForbiddenMechanisms,
    evidenceExpectation:
      "Signed-in duplicate submit and repeated confirmation attempts are idempotent and cannot create duplicate payments, orders, sales, labels, payouts, notifications, support requests, or reversal work.",
  }),
  riskControl({
    control: "inventory-hoarding-and-reservation-limits",
    docLabel: "Inventory hoarding and reservation limits",
    ownerIssues: ["#1131", "#1117", "#1119", "#1164"],
    ownerContext: "Inventory",
    checkpoints: ["cart-list-readiness", "reservation-renew-or-expire", "final-confirmation"],
    protectedActions: ["buy-readiness-evaluation", "inventory-reservation", "buy-final-confirmation"],
    audiences: buyerAudiences,
    outcomeStates: ["allowed", "blocked", "deferred", "no-side-effect"],
    customerSurface: "cart-list-readiness",
    launchDecision: "launch-decision-required",
    supportReferenceRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveSignals: true,
    staysBeforeCheckout: true,
    idempotencyKeyShape: "inventory:reservation_risk:<item-or-group-id>:<actor-or-device>:<window>",
    forbiddenMechanisms: checkoutRiskForbiddenMechanisms,
    evidenceExpectation:
      "Reservation limits and expiration prevent supply starvation in readiness; checkout never assigns fulfillment, extends hidden holds, or repairs unassigned fulfillment during confirmation.",
  }),
  riskControl({
    control: "payment-provider-risk-decline-or-hold",
    docLabel: "Payment provider risk decline or hold",
    ownerIssues: ["#1131", "#1124", "#1130", "#1134", "#1165"],
    ownerContext: "Payments",
    checkpoints: ["provider-or-wallet-return", "final-confirmation", "operator-support"],
    protectedActions: ["payment-authorization-or-capture", "buy-final-confirmation", "support-escalation"],
    audiences: buyerAudiences,
    outcomeStates: ["allowed", "blocked", "held", "provider-unavailable", "no-side-effect"],
    customerSurface: "provider-return-recovery",
    launchDecision: "required-for-launch",
    supportReferenceRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveSignals: true,
    staysBeforeCheckout: false,
    idempotencyKeyShape: "payments:risk:<payment-intent-or-provider-ref>:<risk-outcome>",
    forbiddenMechanisms: checkoutRiskForbiddenMechanisms,
    evidenceExpectation:
      "Provider risk declines, holds, outages, and wallet return failures block or hold buy confirmation with customer-safe copy and no synthetic order/refund/reversal facts.",
  }),
  riskControl({
    control: "payout-provider-risk-hold",
    docLabel: "Payout provider risk hold",
    ownerIssues: ["#1131", "#1113", "#1121", "#1124", "#1130", "#1165"],
    ownerContext: "Settlement",
    checkpoints: ["cart-list-readiness", "provider-or-wallet-return", "final-confirmation", "operator-support"],
    protectedActions: ["sell-readiness-evaluation", "payout-setup-or-eligibility", "sell-final-confirmation"],
    audiences: sellerAudiences,
    outcomeStates: ["allowed", "blocked", "held", "deferred", "provider-unavailable", "no-side-effect"],
    customerSurface: "cart-list-readiness",
    launchDecision: "launch-decision-required",
    supportReferenceRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveSignals: true,
    staysBeforeCheckout: true,
    idempotencyKeyShape: "settlement:payout_risk:<seller-account-ref>:<risk-outcome>",
    forbiddenMechanisms: checkoutRiskForbiddenMechanisms,
    evidenceExpectation:
      "Payout risk holds stay in Sell List readiness or owned hold states and cannot be bypassed by seller checkout confirmation.",
  }),
  riskControl({
    control: "seller-readiness-and-listing-abuse",
    docLabel: "Seller readiness and listing abuse",
    ownerIssues: ["#1131", "#1119", "#1121", "#1135"],
    ownerContext: "Marketplace",
    checkpoints: ["cart-list-readiness", "checkout-session-create", "final-confirmation"],
    protectedActions: ["sell-list-line-capture", "sell-readiness-evaluation", "sell-final-confirmation"],
    audiences: sellerAudiences,
    outcomeStates: ["allowed", "blocked", "held", "no-side-effect"],
    customerSurface: "cart-list-readiness",
    launchDecision: "required-for-launch",
    supportReferenceRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: false,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveSignals: true,
    staysBeforeCheckout: true,
    idempotencyKeyShape: "marketplace:seller_readiness_risk:<seller-ref>:<reviewed-line-or-action-key>",
    forbiddenMechanisms: checkoutRiskForbiddenMechanisms,
    evidenceExpectation:
      "Suspicious seller readiness, listing abuse, and offer-term risk stop in Sell List readiness before Marketplace handoff, fallback listing creation, sale, label, payout, notification, or account-history work starts.",
  }),
  riskControl({
    control: "address-contact-payment-payout-mismatch",
    docLabel: "Address, contact, payment, and payout mismatch",
    ownerIssues: ["#1131", "#1121", "#1127", "#1124"],
    ownerContext: "Identity",
    checkpoints: ["cart-list-readiness", "active-session-return", "provider-or-wallet-return", "final-confirmation"],
    protectedActions: [
      "buy-readiness-evaluation",
      "sell-readiness-evaluation",
      "payment-authorization-or-capture",
      "payout-setup-or-eligibility",
    ],
    audiences: allCustomerAudiences,
    outcomeStates: ["allowed", "blocked", "challenged", "held", "no-side-effect"],
    customerSurface: "checkout-recovery",
    launchDecision: "required-for-launch",
    supportReferenceRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveSignals: true,
    staysBeforeCheckout: false,
    idempotencyKeyShape: "identity:risk_mismatch:<actor-ref>:<source-revision>:<risk-outcome>",
    forbiddenMechanisms: checkoutRiskForbiddenMechanisms,
    evidenceExpectation:
      "Identity and instrument mismatch outcomes use customer-safe recovery or hold states and never expose addresses, emails, provider payloads, card/bank data, or raw risk signals.",
  }),
  riskControl({
    control: "active-session-risk-revalidation",
    docLabel: "Active-session risk revalidation",
    ownerIssues: ["#1131", "#1118", "#1119", "#1123"],
    ownerContext: "Checkout",
    checkpoints: ["active-session-return", "provider-or-wallet-return", "final-confirmation"],
    protectedActions: ["buy-final-confirmation", "sell-final-confirmation"],
    audiences: allCustomerAudiences,
    outcomeStates: ["allowed", "blocked", "recovered", "no-side-effect"],
    customerSurface: "checkout-recovery",
    launchDecision: "required-for-launch",
    supportReferenceRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: false,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveSignals: true,
    staysBeforeCheckout: false,
    idempotencyKeyShape: "checkout:risk_active_session:<session-ref-redacted>:<source-revision>:<checkpoint>",
    forbiddenMechanisms: checkoutRiskForbiddenMechanisms,
    evidenceExpectation:
      "Existing sessions revalidate current account, source, economics, provider, inventory, and risk facts on return and final confirmation instead of repairing stale state inside checkout.",
  }),
  riskControl({
    control: "guest-merge-abuse",
    docLabel: "Guest merge abuse",
    ownerIssues: ["#1131", "#1118", "#1121"],
    ownerContext: "Identity",
    checkpoints: ["guest-merge", "active-session-return", "final-confirmation"],
    protectedActions: ["buy-checkout-session-create", "buy-final-confirmation"],
    audiences: ["guest-buyer", "signed-in-buyer"],
    outcomeStates: ["allowed", "blocked", "recovered", "no-side-effect"],
    customerSurface: "checkout-recovery",
    launchDecision: "required-for-launch",
    supportReferenceRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: false,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveSignals: true,
    staysBeforeCheckout: false,
    idempotencyKeyShape: "identity:guest_merge_risk:<guest-source-ref>:<account-ref>:<source-revision>",
    forbiddenMechanisms: checkoutRiskForbiddenMechanisms,
    evidenceExpectation:
      "Guest-to-signed-in merge supersedes stale guest sessions and blocks mismatched source facts before payment, order, notification, support, or account-history side effects.",
  }),
  riskControl({
    control: "duplicate-submit-idempotency",
    docLabel: "Duplicate submit idempotency",
    ownerIssues: ["#1131", "#1130", "#1115"],
    ownerContext: "Checkout",
    checkpoints: ["duplicate-submit", "final-confirmation"],
    protectedActions: ["buy-final-confirmation", "sell-final-confirmation"],
    audiences: allCustomerAudiences,
    outcomeStates: ["allowed", "recovered", "no-side-effect"],
    customerSurface: "confirmation-hold",
    launchDecision: "required-for-launch",
    supportReferenceRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: false,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveSignals: true,
    staysBeforeCheckout: false,
    idempotencyKeyShape: "checkout:confirm:<confirmation-id-or-source-revision>:<actor-mode>",
    forbiddenMechanisms: checkoutRiskForbiddenMechanisms,
    evidenceExpectation:
      "Duplicate submit, reload, provider retry, and background retry share stable confirmation idempotency and cannot duplicate downstream work.",
  }),
  riskControl({
    control: "support-safe-risk-escalation",
    docLabel: "Support-safe risk escalation",
    ownerIssues: ["#1131", "#1122", "#1124"],
    ownerContext: "Support",
    checkpoints: ["operator-support"],
    protectedActions: ["support-escalation"],
    audiences: ["support-operator"],
    outcomeStates: ["blocked", "held", "challenged", "recovered"],
    customerSurface: "support-runbook",
    launchDecision: "required-for-launch",
    supportReferenceRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveSignals: true,
    staysBeforeCheckout: false,
    idempotencyKeyShape: "support:risk_escalation:<support-safe-reference>:<risk-outcome>",
    forbiddenMechanisms: checkoutRiskForbiddenMechanisms,
    evidenceExpectation:
      "Support can distinguish customer error from risk hold using masked status, support-safe references, and owning-context escalation without raw signals or manual data edits.",
  }),
  riskControl({
    control: "launch-decision-risk-states",
    docLabel: "Launch decision risk states",
    ownerIssues: ["#1131", "#1548", "#1102", "#1112"],
    ownerContext: "Platform",
    checkpoints: ["cart-list-readiness", "provider-or-wallet-return", "final-confirmation", "operator-support"],
    protectedActions: [
      "buy-final-confirmation",
      "sell-final-confirmation",
      "payment-authorization-or-capture",
      "payout-setup-or-eligibility",
      "inventory-reservation",
    ],
    audiences: allAudiences,
    outcomeStates: [
      "blocked",
      "held",
      "challenged",
      "disabled",
      "deferred",
      "unsupported",
      "provider-unavailable",
      "no-side-effect",
    ],
    customerSurface: "launch-evidence",
    launchDecision: "launch-decision-required",
    supportReferenceRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveSignals: true,
    staysBeforeCheckout: false,
    idempotencyKeyShape: "launch-decision:risk:<capability-or-provider>:<state>",
    forbiddenMechanisms: checkoutRiskForbiddenMechanisms,
    evidenceExpectation:
      "Blocked, held, challenged, disabled, deferred, unsupported, and provider-unavailable risk states have owner, copy, support path, observability, support path, and visual target evidence.",
  }),
  riskControl({
    control: "observability-redaction",
    docLabel: "Observability redaction",
    ownerIssues: ["#1131", "#1114", "#1124"],
    ownerContext: "Checkout",
    checkpoints: ["cart-list-readiness", "active-session-return", "provider-or-wallet-return", "final-confirmation"],
    protectedActions: [
      "buy-readiness-evaluation",
      "sell-readiness-evaluation",
      "payment-authorization-or-capture",
      "payout-setup-or-eligibility",
      "support-escalation",
    ],
    audiences: allAudiences,
    outcomeStates: ["allowed", "blocked", "held", "challenged", "provider-unavailable", "no-side-effect"],
    customerSurface: "launch-evidence",
    launchDecision: "required-for-launch",
    supportReferenceRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: false,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveSignals: true,
    staysBeforeCheckout: false,
    idempotencyKeyShape: "checkout:risk_observability:<event-name>:<support-safe-reference>",
    forbiddenMechanisms: checkoutRiskForbiddenMechanisms,
    evidenceExpectation:
      "Risk telemetry uses categories and support-safe references only; logs, metrics, canaries, and runbooks never expose raw addresses, emails, provider payloads, card/bank data, or sensitive risk signals.",
  }),
  riskControl({
    control: "no-side-effect-risk-blocks",
    docLabel: "No-side-effect risk blocks",
    ownerIssues: ["#1131", "#1548", "#1119", "#1130"],
    ownerContext: "Checkout",
    checkpoints: ["cart-list-readiness", "checkout-session-create", "final-confirmation"],
    protectedActions: [
      "buy-final-confirmation",
      "sell-final-confirmation",
      "payment-authorization-or-capture",
      "payout-setup-or-eligibility",
      "inventory-reservation",
    ],
    audiences: allCustomerAudiences,
    outcomeStates: ["blocked", "held", "no-side-effect"],
    customerSurface: "checkout-recovery",
    launchDecision: "required-for-launch",
    supportReferenceRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveSignals: true,
    staysBeforeCheckout: false,
    idempotencyKeyShape: "checkout:risk_no_side_effect:<source-ref>:<checkpoint>:<risk-outcome>",
    forbiddenMechanisms: checkoutRiskForbiddenMechanisms,
    evidenceExpectation:
      "Risk blocks prove no payment, order, sale, label, payout, settlement, notification, support, account-history, refund, void, or reversal side effect started.",
  }),
  riskControl({
    control: "fresh-state-risk-cleanup",
    docLabel: "Fresh-state risk cleanup",
    ownerIssues: ["#1131", "#1548", "#1124"],
    ownerContext: "Platform",
    checkpoints: ["cart-list-readiness", "checkout-session-create", "final-confirmation", "operator-support"],
    protectedActions: [
      "buy-checkout-session-create",
      "sell-checkout-session-create",
      "buy-final-confirmation",
      "sell-final-confirmation",
      "support-escalation",
    ],
    audiences: allAudiences,
    outcomeStates: ["blocked", "disabled", "unsupported", "no-side-effect"],
    customerSurface: "launch-evidence",
    launchDecision: "required-for-launch",
    supportReferenceRequired: true,
    observabilityRequired: true,
    launchDecisionRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveSignals: true,
    staysBeforeCheckout: false,
    idempotencyKeyShape: "checkout:risk_fresh_state:<scan-or-route-id>:<result>",
    forbiddenMechanisms: checkoutRiskForbiddenMechanisms,
    evidenceExpectation:
      "Fresh-state scans prove risk handling cannot succeed through old routes, payload adapters, migration/backfill helpers, dual writes, hidden repair, stale fixtures, or dense checkout fallback.",
  }),
] as const satisfies readonly CheckoutRiskControlPolicyEntry[];

export function assertCheckoutRiskControlPolicyCoverage(): void {
  const byControl = new Map(checkoutRiskControlPolicyEntries.map((entry) => [entry.control, entry]));

  for (const control of checkoutRiskControlRequiredControls) {
    if (!byControl.has(control)) {
      throw new Error(`Missing checkout risk control policy for '${control}'.`);
    }
  }

  if (byControl.size !== checkoutRiskControlPolicyEntries.length) {
    throw new Error("Checkout risk control policy controls must be unique.");
  }

  for (const entry of checkoutRiskControlPolicyEntries) {
    if (!entry.ownerIssues.includes("#1131")) {
      throw new Error(`Checkout risk control '${entry.control}' must include #1131 as an owner issue.`);
    }
    if (entry.docLabel.trim().length === 0 || entry.evidenceExpectation.trim().length === 0) {
      throw new Error(`Checkout risk control '${entry.control}' needs documentation text.`);
    }
    if (entry.audiences.length === 0 || entry.checkpoints.length === 0 || entry.protectedActions.length === 0) {
      throw new Error(`Checkout risk control '${entry.control}' needs audience, checkpoint, and action coverage.`);
    }
    if (!entry.observabilityRequired || !entry.redactsSensitiveSignals) {
      throw new Error(`Checkout risk control '${entry.control}' must require redacted observability.`);
    }
    if (entry.supportReferenceRequired && entry.idempotencyKeyShape.trim().length === 0) {
      throw new Error(`Checkout risk control '${entry.control}' needs an idempotency/support key shape.`);
    }
    if (
      entry.launchDecision === "launch-decision-required" &&
      (!entry.launchDecisionRequired || !entry.supportReferenceRequired)
    ) {
      throw new Error(`Checkout risk control '${entry.control}' needs launch decision and support coverage.`);
    }
    if (
      entry.outcomeStates.some((state) =>
        ["blocked", "held", "challenged", "disabled", "deferred", "unsupported", "provider-unavailable"].includes(
          state,
        ),
      ) &&
      (!entry.supportReferenceRequired || !entry.noSideEffectBeforeCommitRequired)
    ) {
      throw new Error(`Checkout risk control '${entry.control}' must be support-safe and no-side-effect guarded.`);
    }
    for (const forbiddenMechanism of checkoutRiskForbiddenMechanisms) {
      if (!entry.forbiddenMechanisms.includes(forbiddenMechanism)) {
        throw new Error(`Checkout risk control '${entry.control}' must forbid '${forbiddenMechanism}'.`);
      }
    }
  }

  for (const control of [
    "guest-velocity-and-bot-protection",
    "inventory-hoarding-and-reservation-limits",
    "payout-provider-risk-hold",
    "seller-readiness-and-listing-abuse",
  ] as const satisfies readonly CheckoutRiskControlKey[]) {
    const entry = byControl.get(control);
    if (!entry?.staysBeforeCheckout) {
      throw new Error(`Checkout risk control '${control}' must stay before checkout.`);
    }
  }

  const finalConfirmationControls = checkoutRiskControlPolicyEntries.filter((entry) =>
    entry.checkpoints.includes("final-confirmation"),
  );
  for (const entry of finalConfirmationControls) {
    if (!entry.noSideEffectBeforeCommitRequired) {
      throw new Error(`Checkout risk control '${entry.control}' must guard final confirmation side effects.`);
    }
  }
}

function riskControl(input: CheckoutRiskControlPolicyEntry): CheckoutRiskControlPolicyEntry {
  return input;
}
