export const checkoutCopyPolicyDocPath = "bounded-contexts/checkout/docs/checkout-copy-policy.md" as const;

export type CheckoutCopyAudience =
  | "guest-buyer"
  | "signed-in-buyer"
  | "guest-seller"
  | "signed-in-seller"
  | "support-operator";

export type CheckoutCopyCapabilityState =
  | "enabled"
  | "disabled"
  | "deferred"
  | "retained-internal"
  | "kill-switched"
  | "stale"
  | "pending"
  | "committed"
  | "failed"
  | "recovered"
  | "held"
  | "reversed"
  | "no-side-effect";

export type CheckoutCopyDisclosureLevel =
  | "visible-required-fact"
  | "visible-recovery"
  | "reference-info"
  | "progressive-disclosure"
  | "policy-link"
  | "support-runbook";

export type CheckoutCopySurfaceKind =
  | "cart-list-readiness"
  | "checkout-form"
  | "confirmation"
  | "post-confirmation"
  | "support";

export type CheckoutCopyOwnerIssue =
  | "#1102"
  | "#1103"
  | "#1105"
  | "#1106"
  | "#1107"
  | "#1112"
  | "#1113"
  | "#1114"
  | "#1115"
  | "#1117"
  | "#1118"
  | "#1119"
  | "#1120"
  | "#1121"
  | "#1122"
  | "#1123"
  | "#1124"
  | "#1127"
  | "#1128"
  | "#1129"
  | "#1130"
  | "#1131"
  | "#1132"
  | "#1134"
  | "#1135"
  | "#1164"
  | "#1165"
  | "#1206";

export type CheckoutCopyPolicyDependency =
  | "none"
  | "payment-policy"
  | "payout-policy"
  | "tax-policy"
  | "shipping-policy"
  | "privacy-policy"
  | "terms-of-service"
  | "notification-policy"
  | "risk-review-policy"
  | "refund-reversal-policy"
  | "support-runbook"
  | "owner-rule-register";

export type CheckoutCopySurfaceKey =
  | "cart-list-review"
  | "readiness-unassigned-fulfillment"
  | "readiness-optimization-offer"
  | "readiness-blocked-or-unavailable"
  | "checkout-review"
  | "checkout-saved-info-rows"
  | "checkout-temporary-recovery"
  | "checkout-permanent-recovery"
  | "active-session-stale-recovery"
  | "accelerated-saved-instrument-fallback"
  | "address-correction"
  | "economics-discount-credit-promo"
  | "provider-return-recovery"
  | "risk-hold-or-block"
  | "split-group-summary"
  | "confirmation-receipt-next-steps"
  | "seller-pending-activity"
  | "account-history-handoff"
  | "support-reference"
  | "notification-expectation"
  | "cancellation-refund-reversal"
  | "kill-switch-disabled-checkout"
  | "policy-footer";

export type CheckoutCopySupportReference = Readonly<{
  required: boolean;
  safeFields: readonly string[];
  forbiddenFields: readonly string[];
}>;

export type CheckoutCopyPolicyEntry = Readonly<{
  surface: CheckoutCopySurfaceKey;
  docLabel: string;
  ownerIssues: readonly CheckoutCopyOwnerIssue[];
  kind: CheckoutCopySurfaceKind;
  customerVisible: boolean;
  audiences: readonly CheckoutCopyAudience[];
  capabilityStates: readonly CheckoutCopyCapabilityState[];
  disclosure: readonly CheckoutCopyDisclosureLevel[];
  requiredVisibleFacts: readonly string[];
  primaryAction: string;
  nextAction: string;
  allowedCustomerTerms: readonly string[];
  forbiddenCustomerTerms: readonly string[];
  policyDependencies: readonly CheckoutCopyPolicyDependency[];
  supportReference: CheckoutCopySupportReference;
  noSideEffectStatementRequired: boolean;
  pendingDownstreamBoundaryRequired: boolean;
  examples: readonly string[];
  customerSafeOutcome: string;
}>;

export const checkoutCopyForbiddenCustomerTerms = [
  "allocation",
  "selected seller listing",
  "provider payload",
  "projection",
  "projection repair",
  "stale read model",
  "session refresh internals",
  "old adapter",
  "migration",
  "backfill",
  "manual database edit",
  "old checkout",
  "old checkout URL",
  "dense checkout fallback",
  "hidden repair",
  "provider dashboard",
  "provider diagnostics",
  "raw id",
  "full url",
] as const;

export const checkoutCopyAllowedCustomerTerms = [
  "Buy Cart",
  "Sell List",
  "Smart Match",
  "checkout",
  "shipping",
  "payment",
  "payout",
  "support reference",
  "seller activity",
  "order detail",
  "sale detail",
] as const;

const buyerAudiences = ["guest-buyer", "signed-in-buyer"] as const satisfies readonly CheckoutCopyAudience[];
const sellerAudiences = ["guest-seller", "signed-in-seller"] as const satisfies readonly CheckoutCopyAudience[];
const allCustomerAudiences = [
  "guest-buyer",
  "signed-in-buyer",
  "guest-seller",
  "signed-in-seller",
] as const satisfies readonly CheckoutCopyAudience[];
const allAudiences = [
  "guest-buyer",
  "signed-in-buyer",
  "guest-seller",
  "signed-in-seller",
  "support-operator",
] as const satisfies readonly CheckoutCopyAudience[];
const allDownstreamSafeFields = [
  "support-safe reference",
  "confirmation id",
  "readiness snapshot version",
  "reviewed line/action key",
  "downstream status class",
] as const;
const sensitiveForbiddenFields = [
  "raw ids",
  "email addresses",
  "mailing addresses",
  "cookies",
  "session ids",
  "provider payloads",
  "full URLs",
  "card or bank details",
  "risk signals",
] as const;
const standardPolicyLinks = [
  "terms-of-service",
  "privacy-policy",
] as const satisfies readonly CheckoutCopyPolicyDependency[];

export const checkoutCopyPolicyEntries = [
  copyPolicy({
    surface: "cart-list-review",
    docLabel: "Cart/list review",
    ownerIssues: ["#1102", "#1117", "#1118"],
    kind: "cart-list-readiness",
    customerVisible: true,
    audiences: allCustomerAudiences,
    capabilityStates: ["enabled"],
    disclosure: ["visible-required-fact", "reference-info"],
    requiredVisibleFacts: ["item identity", "quantity", "price or payout preview", "primary review action"],
    primaryAction: "Review checkout",
    nextAction: "Continue when your items are ready.",
    allowedCustomerTerms: ["Buy Cart", "Sell List", "Smart Match"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["none"],
    supportReference: noSupportReference(),
    noSideEffectStatementRequired: false,
    pendingDownstreamBoundaryRequired: false,
    examples: ["Review your Buy Cart.", "Review your Sell List.", "Smart Match helps prepare product lines."],
    customerSafeOutcome: "Cart and Sell List copy stays concise and keeps checkout-only language out of review.",
  }),
  copyPolicy({
    surface: "readiness-unassigned-fulfillment",
    docLabel: "Readiness item attention",
    ownerIssues: ["#1102", "#1117", "#1118"],
    kind: "cart-list-readiness",
    customerVisible: true,
    audiences: buyerAudiences,
    capabilityStates: ["stale", "no-side-effect"],
    disclosure: ["visible-recovery", "reference-info"],
    requiredVisibleFacts: ["affected item count", "why checkout cannot start", "remove or save-for-later action"],
    primaryAction: "Review items",
    nextAction: "Remove items, save them for later, or choose an available option before checkout.",
    allowedCustomerTerms: ["Buy Cart", "shipping"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["shipping-policy", "support-runbook"],
    supportReference: noSupportReference(),
    noSideEffectStatementRequired: true,
    pendingDownstreamBoundaryRequired: false,
    examples: [
      "Some items need attention before checkout.",
      "No payment has started.",
      "Remove them or save them for later.",
    ],
    customerSafeOutcome: "Unready buyer items are resolved before checkout and never as checkout form copy.",
  }),
  copyPolicy({
    surface: "readiness-optimization-offer",
    docLabel: "Readiness savings offer",
    ownerIssues: ["#1102", "#1117", "#1128"],
    kind: "cart-list-readiness",
    customerVisible: true,
    audiences: buyerAudiences,
    capabilityStates: ["enabled", "stale", "no-side-effect"],
    disclosure: ["visible-required-fact", "reference-info"],
    requiredVisibleFacts: ["savings amount", "item impact", "accept action", "keep-current action"],
    primaryAction: "Save $X",
    nextAction: "Choose the savings option or keep the current plan before checkout.",
    allowedCustomerTerms: ["Buy Cart", "shipping"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["shipping-policy", "tax-policy"],
    supportReference: noSupportReference(),
    noSideEffectStatementRequired: true,
    pendingDownstreamBoundaryRequired: false,
    examples: ["Save $X with a different shipping plan.", "Keep current plan.", "No payment has started."],
    customerSafeOutcome:
      "Savings copy stays in readiness and does not ask customers to solve internals inside checkout.",
  }),
  copyPolicy({
    surface: "readiness-blocked-or-unavailable",
    docLabel: "Readiness blocked or unavailable",
    ownerIssues: ["#1102", "#1117", "#1118", "#1119", "#1127", "#1131"],
    kind: "cart-list-readiness",
    customerVisible: true,
    audiences: allCustomerAudiences,
    capabilityStates: ["disabled", "stale", "held", "failed", "no-side-effect"],
    disclosure: ["visible-recovery", "policy-link"],
    requiredVisibleFacts: ["blocking reason", "current status", "return path", "support option when needed"],
    primaryAction: "Return to review",
    nextAction: "Update the list or cart before checkout can continue.",
    allowedCustomerTerms: ["Buy Cart", "Sell List", "support reference"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["shipping-policy", "risk-review-policy", "support-runbook"],
    supportReference: supportReferenceRequired(),
    noSideEffectStatementRequired: true,
    pendingDownstreamBoundaryRequired: false,
    examples: ["Checkout is not ready yet.", "Return to review.", "No payment, label, or payout has started."],
    customerSafeOutcome: "Blocked readiness copy routes out of checkout with no downstream side effects.",
  }),
  copyPolicy({
    surface: "checkout-review",
    docLabel: "Checkout review",
    ownerIssues: ["#1102", "#1105", "#1106", "#1107", "#1112"],
    kind: "checkout-form",
    customerVisible: true,
    audiences: buyerAudiences,
    capabilityStates: ["enabled"],
    disclosure: ["visible-required-fact", "policy-link", "reference-info"],
    requiredVisibleFacts: [
      "contact",
      "delivery",
      "shipping method",
      "payment method",
      "final total",
      "primary payment action",
    ],
    primaryAction: "Pay now",
    nextAction: "Confirm when contact, delivery, shipping, payment, and total are correct.",
    allowedCustomerTerms: ["checkout", "payment", "shipping"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["payment-policy", "tax-policy", "shipping-policy", "terms-of-service", "privacy-policy"],
    supportReference: noSupportReference(),
    noSideEffectStatementRequired: false,
    pendingDownstreamBoundaryRequired: false,
    examples: ["Contact", "Delivery", "Shipping method", "Payment", "Pay now"],
    customerSafeOutcome: "Main checkout copy follows the Shopify-simple hierarchy and keeps required facts visible.",
  }),
  copyPolicy({
    surface: "checkout-saved-info-rows",
    docLabel: "Saved-info rows",
    ownerIssues: ["#1102", "#1121", "#1113"],
    kind: "checkout-form",
    customerVisible: true,
    audiences: ["signed-in-buyer", "signed-in-seller"],
    capabilityStates: ["enabled", "stale", "failed"],
    disclosure: ["visible-required-fact", "visible-recovery"],
    requiredVisibleFacts: ["masked saved value", "freshness status", "edit action", "fallback form"],
    primaryAction: "Edit",
    nextAction: "Review saved details or edit before continuing.",
    allowedCustomerTerms: ["Ship to", "Payment", "payout"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["privacy-policy", "payment-policy", "payout-policy"],
    supportReference: noSupportReference(),
    noSideEffectStatementRequired: false,
    pendingDownstreamBoundaryRequired: false,
    examples: ["Ship to", "Payment", "Payout method", "Edit"],
    customerSafeOutcome: "Signed-in rows stay concise, masked, editable, and recoverable when account facts change.",
  }),
  copyPolicy({
    surface: "checkout-temporary-recovery",
    docLabel: "Checkout temporary recovery",
    ownerIssues: ["#1102", "#1206", "#1123", "#1114"],
    kind: "checkout-form",
    customerVisible: true,
    audiences: allCustomerAudiences,
    capabilityStates: ["pending", "no-side-effect"],
    disclosure: ["visible-recovery", "support-runbook"],
    requiredVisibleFacts: ["temporary status", "safe wait or refresh action", "no side-effect statement"],
    primaryAction: "Refresh checkout",
    nextAction: "Wait a moment or refresh checkout.",
    allowedCustomerTerms: ["checkout", "support reference"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["support-runbook"],
    supportReference: supportReferenceRequired(),
    noSideEffectStatementRequired: true,
    pendingDownstreamBoundaryRequired: false,
    examples: ["We are still getting checkout ready.", "Refresh checkout.", "No payment has started."],
    customerSafeOutcome:
      "Temporary recovery is visible before gateway failure and does not expose freshness internals.",
  }),
  copyPolicy({
    surface: "checkout-permanent-recovery",
    docLabel: "Checkout permanent recovery",
    ownerIssues: ["#1102", "#1118", "#1119", "#1122"],
    kind: "checkout-form",
    customerVisible: true,
    audiences: allCustomerAudiences,
    capabilityStates: ["stale", "failed", "no-side-effect"],
    disclosure: ["visible-recovery", "support-runbook"],
    requiredVisibleFacts: [
      "why checkout cannot continue",
      "cart or list return action",
      "support reference when available",
    ],
    primaryAction: "Return to review",
    nextAction: "Review current items before starting checkout again.",
    allowedCustomerTerms: ["Buy Cart", "Sell List", "checkout", "support reference"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["support-runbook"],
    supportReference: supportReferenceRequired(),
    noSideEffectStatementRequired: true,
    pendingDownstreamBoundaryRequired: false,
    examples: ["This checkout can no longer continue.", "Return to review.", "No payment or payout has started."],
    customerSafeOutcome: "Permanent recovery fails closed to current cart/list facts without old-flow wording.",
  }),
  copyPolicy({
    surface: "active-session-stale-recovery",
    docLabel: "Active-session stale recovery",
    ownerIssues: ["#1102", "#1118", "#1119", "#1121", "#1122"],
    kind: "checkout-form",
    customerVisible: true,
    audiences: allCustomerAudiences,
    capabilityStates: ["stale", "no-side-effect"],
    disclosure: ["visible-recovery", "support-runbook"],
    requiredVisibleFacts: ["changed fact category", "return action", "no side-effect statement"],
    primaryAction: "Review changes",
    nextAction: "Review the cart or list again before checkout can continue.",
    allowedCustomerTerms: ["Buy Cart", "Sell List", "checkout"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["support-runbook"],
    supportReference: supportReferenceRequired(),
    noSideEffectStatementRequired: true,
    pendingDownstreamBoundaryRequired: false,
    examples: [
      "Your cart changed after checkout started.",
      "Review changes.",
      "No payment, label, or payout has started.",
    ],
    customerSafeOutcome:
      "Stale active sessions use customer-safe recovery and never explain internal freshness mechanics.",
  }),
  copyPolicy({
    surface: "accelerated-saved-instrument-fallback",
    docLabel: "Accelerated and saved-instrument fallback",
    ownerIssues: ["#1102", "#1113", "#1121", "#1124"],
    kind: "checkout-form",
    customerVisible: true,
    audiences: allCustomerAudiences,
    capabilityStates: ["enabled", "disabled", "deferred", "failed", "no-side-effect"],
    disclosure: ["visible-required-fact", "visible-recovery", "policy-link"],
    requiredVisibleFacts: ["available method", "masked method when saved", "fallback action", "privacy-safe status"],
    primaryAction: "Continue with card",
    nextAction: "Use another available payment or payout method.",
    allowedCustomerTerms: ["payment", "payout"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["payment-policy", "payout-policy", "privacy-policy"],
    supportReference: supportReferenceRequired(),
    noSideEffectStatementRequired: true,
    pendingDownstreamBoundaryRequired: false,
    examples: [
      "Express checkout is unavailable.",
      "Continue with card.",
      "Use another payout method.",
      "No payment or payout has started.",
    ],
    customerSafeOutcome: "Convenience paths cannot bypass readiness or sensitive-data copy rules.",
  }),
  copyPolicy({
    surface: "address-correction",
    docLabel: "Address correction",
    ownerIssues: ["#1102", "#1127", "#1121"],
    kind: "checkout-form",
    customerVisible: true,
    audiences: allCustomerAudiences,
    capabilityStates: ["stale", "failed", "no-side-effect"],
    disclosure: ["visible-recovery", "policy-link"],
    requiredVisibleFacts: ["field needing correction", "serviceability status", "refresh action"],
    primaryAction: "Update address",
    nextAction: "Correct the address before continuing.",
    allowedCustomerTerms: ["shipping", "payout"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["shipping-policy", "tax-policy", "privacy-policy"],
    supportReference: noSupportReference(),
    noSideEffectStatementRequired: true,
    pendingDownstreamBoundaryRequired: false,
    examples: [
      "Update address.",
      "We need a deliverable address before checkout can continue.",
      "No payment or label has started.",
    ],
    customerSafeOutcome: "Address copy is inline and provider-safe for buyer delivery and seller ship-from recovery.",
  }),
  copyPolicy({
    surface: "economics-discount-credit-promo",
    docLabel: "Discount, credit, fee, and promotion state",
    ownerIssues: ["#1102", "#1128", "#1119"],
    kind: "checkout-form",
    customerVisible: true,
    audiences: allCustomerAudiences,
    capabilityStates: ["enabled", "disabled", "deferred", "stale", "failed", "no-side-effect"],
    disclosure: ["visible-required-fact", "visible-recovery", "policy-link"],
    requiredVisibleFacts: ["current total or payout", "changed state", "review action"],
    primaryAction: "Review total",
    nextAction: "Review the updated total before continuing.",
    allowedCustomerTerms: ["payment", "payout"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["tax-policy", "payment-policy", "payout-policy", "owner-rule-register"],
    supportReference: supportReferenceRequired(),
    noSideEffectStatementRequired: true,
    pendingDownstreamBoundaryRequired: false,
    examples: [
      "This discount changed.",
      "Review total.",
      "Gift cards are not available yet.",
      "No payment or payout has started.",
    ],
    customerSafeOutcome: "Economics copy covers supported, changed, disabled, and deferred states before commitment.",
  }),
  copyPolicy({
    surface: "provider-return-recovery",
    docLabel: "Provider or wallet return recovery",
    ownerIssues: ["#1102", "#1113", "#1134", "#1119", "#1122"],
    kind: "checkout-form",
    customerVisible: true,
    audiences: allCustomerAudiences,
    capabilityStates: ["stale", "failed", "pending", "no-side-effect"],
    disclosure: ["visible-recovery", "support-runbook"],
    requiredVisibleFacts: ["return status", "safe retry or review action", "no side-effect status when blocked"],
    primaryAction: "Review checkout",
    nextAction: "Review checkout before trying again.",
    allowedCustomerTerms: ["checkout", "support reference"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["payment-policy", "payout-policy", "support-runbook"],
    supportReference: supportReferenceRequired(),
    noSideEffectStatementRequired: true,
    pendingDownstreamBoundaryRequired: false,
    examples: ["Review checkout before trying again.", "No payment, label, or payout has started."],
    customerSafeOutcome: "Provider and wallet returns fail closed with new-flow copy and support-safe status.",
  }),
  copyPolicy({
    surface: "risk-hold-or-block",
    docLabel: "Risk hold or block",
    ownerIssues: ["#1102", "#1131", "#1124", "#1122"],
    kind: "checkout-form",
    customerVisible: true,
    audiences: allCustomerAudiences,
    capabilityStates: ["held", "disabled", "failed", "no-side-effect"],
    disclosure: ["visible-recovery", "policy-link", "support-runbook"],
    requiredVisibleFacts: ["hold or block status", "support path", "privacy-safe next step"],
    primaryAction: "Contact support",
    nextAction: "Contact support with the support reference.",
    allowedCustomerTerms: ["support reference"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["risk-review-policy", "privacy-policy", "support-runbook"],
    supportReference: supportReferenceRequired(),
    noSideEffectStatementRequired: true,
    pendingDownstreamBoundaryRequired: false,
    examples: [
      "This checkout needs review before it can continue.",
      "Contact support.",
      "No payment or payout has started.",
    ],
    customerSafeOutcome: "Risk copy exposes next steps without sensitive signals or provider details.",
  }),
  copyPolicy({
    surface: "split-group-summary",
    docLabel: "Split package summary",
    ownerIssues: ["#1102", "#1164", "#1135"],
    kind: "checkout-form",
    customerVisible: true,
    audiences: buyerAudiences,
    capabilityStates: ["enabled", "stale", "pending", "failed"],
    disclosure: ["visible-required-fact", "reference-info"],
    requiredVisibleFacts: ["package count", "delivery windows when different", "total remains visible"],
    primaryAction: "Review packages",
    nextAction: "Review package details before payment.",
    allowedCustomerTerms: ["shipping", "order detail"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["shipping-policy", "support-runbook"],
    supportReference: supportReferenceRequired(),
    noSideEffectStatementRequired: false,
    pendingDownstreamBoundaryRequired: true,
    examples: ["Ships in 2 packages.", "Delivery dates may differ.", "Review packages."],
    customerSafeOutcome:
      "Split-order copy explains customer-visible package facts without exposing grouping mechanics.",
  }),
  copyPolicy({
    surface: "confirmation-receipt-next-steps",
    docLabel: "Confirmation and next steps",
    ownerIssues: ["#1102", "#1120", "#1129", "#1135"],
    kind: "confirmation",
    customerVisible: true,
    audiences: allCustomerAudiences,
    capabilityStates: ["pending", "committed", "failed", "recovered"],
    disclosure: ["visible-required-fact", "policy-link", "reference-info"],
    requiredVisibleFacts: ["confirmation status", "next step", "support reference", "account or receipt destination"],
    primaryAction: "View details",
    nextAction: "Use the receipt, account activity, or support reference for next steps.",
    allowedCustomerTerms: ["support reference", "seller activity", "order detail", "sale detail"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["terms-of-service", "notification-policy", "support-runbook"],
    supportReference: supportReferenceRequired(),
    noSideEffectStatementRequired: false,
    pendingDownstreamBoundaryRequired: true,
    examples: ["Confirmation recorded.", "View details.", "Keep this support reference."],
    customerSafeOutcome:
      "Confirmation copy distinguishes receipt, pending activity, committed detail, and support paths.",
  }),
  copyPolicy({
    surface: "seller-pending-activity",
    docLabel: "Seller pending activity",
    ownerIssues: ["#1102", "#1120", "#1135", "#1130"],
    kind: "post-confirmation",
    customerVisible: true,
    audiences: sellerAudiences,
    capabilityStates: ["pending", "committed", "failed", "recovered", "held", "no-side-effect"],
    disclosure: ["visible-required-fact", "reference-info", "support-runbook"],
    requiredVisibleFacts: ["confirmation recorded status", "pending downstream status", "support reference"],
    primaryAction: "View seller activity",
    nextAction: "Check seller activity until sale, label, payout, and notification details are ready.",
    allowedCustomerTerms: ["seller activity", "sale detail", "label", "payout", "support reference"],
    forbiddenCustomerTerms: [
      ...checkoutCopyForbiddenCustomerTerms,
      "sale complete",
      "label ready",
      "payout ready",
      "settlement complete",
      "notification sent",
      "fulfillment complete",
    ],
    policyDependencies: ["payout-policy", "shipping-policy", "notification-policy", "support-runbook"],
    supportReference: supportReferenceRequired(),
    noSideEffectStatementRequired: false,
    pendingDownstreamBoundaryRequired: true,
    examples: ["Seller activity recorded.", "Sale details are pending.", "Keep this support reference."],
    customerSafeOutcome: "Seller copy never implies downstream completion before owning contexts commit facts.",
  }),
  copyPolicy({
    surface: "account-history-handoff",
    docLabel: "Account history handoff",
    ownerIssues: ["#1102", "#1135", "#1122"],
    kind: "post-confirmation",
    customerVisible: true,
    audiences: ["signed-in-buyer", "signed-in-seller"],
    capabilityStates: ["pending", "committed", "failed", "recovered", "held", "reversed"],
    disclosure: ["visible-required-fact", "reference-info"],
    requiredVisibleFacts: ["destination label", "current status", "support reference when needed"],
    primaryAction: "View activity",
    nextAction: "Open account activity or the committed detail page when it is ready.",
    allowedCustomerTerms: ["seller activity", "order detail", "sale detail", "support reference"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["privacy-policy", "support-runbook"],
    supportReference: supportReferenceRequired(),
    noSideEffectStatementRequired: false,
    pendingDownstreamBoundaryRequired: true,
    examples: ["View activity.", "Order detail is ready.", "Seller activity is pending."],
    customerSafeOutcome:
      "Account history copy routes pending Checkout activity and committed downstream facts separately.",
  }),
  copyPolicy({
    surface: "support-reference",
    docLabel: "Support reference",
    ownerIssues: ["#1102", "#1122", "#1114"],
    kind: "support",
    customerVisible: true,
    audiences: allAudiences,
    capabilityStates: ["pending", "failed", "recovered", "held", "reversed", "no-side-effect"],
    disclosure: ["visible-required-fact", "support-runbook"],
    requiredVisibleFacts: ["stable support reference", "safe status", "next support action"],
    primaryAction: "Contact support",
    nextAction: "Share the support reference if you need help.",
    allowedCustomerTerms: ["support reference"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["support-runbook", "privacy-policy"],
    supportReference: supportReferenceRequired(),
    noSideEffectStatementRequired: true,
    pendingDownstreamBoundaryRequired: true,
    examples: [
      "Support reference available.",
      "Share this support reference if you need help.",
      "No payment, order, label, payout, or notification has started.",
    ],
    customerSafeOutcome:
      "Support copy is stable across buy, sell, guest, signed-in, confirmation, and recovery states.",
  }),
  copyPolicy({
    surface: "notification-expectation",
    docLabel: "Notification expectation",
    ownerIssues: ["#1102", "#1129", "#1135"],
    kind: "post-confirmation",
    customerVisible: true,
    audiences: allCustomerAudiences,
    capabilityStates: ["pending", "committed", "failed", "deferred", "no-side-effect"],
    disclosure: ["visible-required-fact", "policy-link", "reference-info"],
    requiredVisibleFacts: ["what message may be sent", "status", "account or support destination"],
    primaryAction: "View activity",
    nextAction: "Check activity for the latest status.",
    allowedCustomerTerms: ["seller activity", "order detail", "sale detail", "support reference"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["notification-policy", "privacy-policy", "support-runbook"],
    supportReference: supportReferenceRequired(),
    noSideEffectStatementRequired: true,
    pendingDownstreamBoundaryRequired: true,
    examples: [
      "We will send updates when they are ready.",
      "Check activity for the latest status.",
      "No payment or notification has started.",
    ],
    customerSafeOutcome: "Notification copy avoids promising sent messages before Notifications commits them.",
  }),
  copyPolicy({
    surface: "cancellation-refund-reversal",
    docLabel: "Cancellation, refund, and reversal",
    ownerIssues: ["#1102", "#1165", "#1130", "#1124"],
    kind: "post-confirmation",
    customerVisible: true,
    audiences: allCustomerAudiences,
    capabilityStates: ["pending", "committed", "failed", "recovered", "held", "reversed", "deferred"],
    disclosure: ["visible-required-fact", "policy-link", "support-runbook"],
    requiredVisibleFacts: ["current recovery status", "expected next step", "support reference"],
    primaryAction: "View recovery status",
    nextAction: "Review the recovery status or contact support with the support reference.",
    allowedCustomerTerms: ["support reference", "order detail", "sale detail"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["refund-reversal-policy", "payment-policy", "payout-policy", "support-runbook"],
    supportReference: supportReferenceRequired(),
    noSideEffectStatementRequired: false,
    pendingDownstreamBoundaryRequired: true,
    examples: ["Refund pending.", "Payout hold active.", "View recovery status."],
    customerSafeOutcome: "Recovery copy explains status and next step without unsafe promises or provider detail.",
  }),
  copyPolicy({
    surface: "kill-switch-disabled-checkout",
    docLabel: "Checkout unavailable",
    ownerIssues: ["#1102", "#1103", "#1122"],
    kind: "checkout-form",
    customerVisible: true,
    audiences: allCustomerAudiences,
    capabilityStates: ["kill-switched", "disabled", "no-side-effect"],
    disclosure: ["visible-recovery", "support-runbook"],
    requiredVisibleFacts: ["checkout unavailable status", "return action", "support option"],
    primaryAction: "Return to review",
    nextAction: "Return to your cart or list and try again later.",
    allowedCustomerTerms: ["Buy Cart", "Sell List", "support reference"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: ["owner-rule-register", "support-runbook"],
    supportReference: supportReferenceRequired(),
    noSideEffectStatementRequired: true,
    pendingDownstreamBoundaryRequired: false,
    examples: ["Checkout is unavailable right now.", "Return to review.", "No payment, label, or payout has started."],
    customerSafeOutcome: "Kill switches fail closed into new-flow recovery without restoring old checkout copy.",
  }),
  copyPolicy({
    surface: "policy-footer",
    docLabel: "Policy footer",
    ownerIssues: ["#1102", "#1124"],
    kind: "checkout-form",
    customerVisible: true,
    audiences: allCustomerAudiences,
    capabilityStates: ["enabled"],
    disclosure: ["policy-link"],
    requiredVisibleFacts: ["terms link", "privacy link", "refund or support link when relevant"],
    primaryAction: "Review policies",
    nextAction: "Open policy links for detailed terms.",
    allowedCustomerTerms: ["support reference"],
    forbiddenCustomerTerms: checkoutCopyForbiddenCustomerTerms,
    policyDependencies: standardPolicyLinks,
    supportReference: noSupportReference(),
    noSideEffectStatementRequired: false,
    pendingDownstreamBoundaryRequired: false,
    examples: ["Refund policy", "Terms of service", "Privacy policy"],
    customerSafeOutcome: "Policy footer labels match Shopify-simple references while pointing to Chase Sets policies.",
  }),
] as const satisfies readonly CheckoutCopyPolicyEntry[];

export const checkoutCopyRequiredSurfaces = [
  "cart-list-review",
  "readiness-unassigned-fulfillment",
  "readiness-optimization-offer",
  "readiness-blocked-or-unavailable",
  "checkout-review",
  "checkout-saved-info-rows",
  "checkout-temporary-recovery",
  "checkout-permanent-recovery",
  "active-session-stale-recovery",
  "accelerated-saved-instrument-fallback",
  "address-correction",
  "economics-discount-credit-promo",
  "provider-return-recovery",
  "risk-hold-or-block",
  "split-group-summary",
  "confirmation-receipt-next-steps",
  "seller-pending-activity",
  "account-history-handoff",
  "support-reference",
  "notification-expectation",
  "cancellation-refund-reversal",
  "kill-switch-disabled-checkout",
  "policy-footer",
] as const satisfies readonly CheckoutCopySurfaceKey[];

const noSideEffectSurfaces = [
  "readiness-unassigned-fulfillment",
  "readiness-optimization-offer",
  "readiness-blocked-or-unavailable",
  "checkout-temporary-recovery",
  "checkout-permanent-recovery",
  "active-session-stale-recovery",
  "accelerated-saved-instrument-fallback",
  "address-correction",
  "economics-discount-credit-promo",
  "provider-return-recovery",
  "risk-hold-or-block",
  "support-reference",
  "notification-expectation",
  "kill-switch-disabled-checkout",
] as const satisfies readonly CheckoutCopySurfaceKey[];

const pendingBoundarySurfaces = [
  "split-group-summary",
  "confirmation-receipt-next-steps",
  "seller-pending-activity",
  "account-history-handoff",
  "support-reference",
  "notification-expectation",
  "cancellation-refund-reversal",
] as const satisfies readonly CheckoutCopySurfaceKey[];

export function assertCheckoutCopyPolicyCoverage(): void {
  const bySurface = new Map(checkoutCopyPolicyEntries.map((entry) => [entry.surface, entry]));

  for (const surface of checkoutCopyRequiredSurfaces) {
    if (!bySurface.has(surface)) {
      throw new Error(`Missing Checkout copy policy for '${surface}'.`);
    }
  }

  if (bySurface.size !== checkoutCopyPolicyEntries.length) {
    throw new Error("Checkout copy policy surfaces must be unique.");
  }

  for (const entry of checkoutCopyPolicyEntries) {
    if (!entry.ownerIssues.includes("#1102")) {
      throw new Error(`Checkout copy policy '${entry.surface}' must include #1102 as an owner issue.`);
    }
    if (entry.docLabel.trim().length === 0) {
      throw new Error(`Checkout copy policy '${entry.surface}' needs a documentation label.`);
    }
    if (entry.audiences.length === 0) {
      throw new Error(`Checkout copy policy '${entry.surface}' needs an audience.`);
    }
    if (entry.capabilityStates.length === 0) {
      throw new Error(`Checkout copy policy '${entry.surface}' needs a capability state.`);
    }
    if (entry.disclosure.length === 0) {
      throw new Error(`Checkout copy policy '${entry.surface}' needs a disclosure posture.`);
    }
    if (entry.requiredVisibleFacts.length === 0) {
      throw new Error(`Checkout copy policy '${entry.surface}' needs visible facts.`);
    }
    if (entry.primaryAction.trim().length === 0 || entry.nextAction.trim().length === 0) {
      throw new Error(`Checkout copy policy '${entry.surface}' needs action copy.`);
    }
    if (entry.customerSafeOutcome.trim().length === 0) {
      throw new Error(`Checkout copy policy '${entry.surface}' needs an customer-safe outcome.`);
    }

    if (entry.customerVisible) {
      const customerText = [entry.primaryAction, entry.nextAction, ...entry.examples].join(" ");
      const forbiddenTerm = findForbiddenTerm(customerText, entry.forbiddenCustomerTerms);
      if (forbiddenTerm) {
        throw new Error(`Checkout copy policy '${entry.surface}' exposes forbidden term '${forbiddenTerm}'.`);
      }
    }

    for (const allowedTerm of entry.allowedCustomerTerms) {
      if (checkoutCopyForbiddenCustomerTerms.some((forbiddenTerm) => sameTerm(forbiddenTerm, allowedTerm))) {
        throw new Error(`Checkout copy policy '${entry.surface}' both allows and forbids '${allowedTerm}'.`);
      }
    }

    if (entry.supportReference.required) {
      if (entry.supportReference.safeFields.length === 0 || entry.supportReference.forbiddenFields.length === 0) {
        throw new Error(`Checkout copy policy '${entry.surface}' has an incomplete support-reference policy.`);
      }
    }

    if (
      entry.capabilityStates.some((state) => state === "disabled" || state === "deferred" || state === "held") &&
      entry.policyDependencies.length === 1 &&
      entry.policyDependencies[0] === "none"
    ) {
      throw new Error(`Checkout copy policy '${entry.surface}' needs policy dependencies for constrained states.`);
    }
  }

  for (const surface of noSideEffectSurfaces) {
    const entry = bySurface.get(surface);
    if (!entry?.noSideEffectStatementRequired) {
      throw new Error(`Checkout copy policy '${surface}' must require no-side-effect copy.`);
    }
    if (!entry.capabilityStates.includes("no-side-effect")) {
      throw new Error(`Checkout copy policy '${surface}' must include the no-side-effect capability state.`);
    }
  }

  for (const surface of pendingBoundarySurfaces) {
    const entry = bySurface.get(surface);
    if (!entry?.pendingDownstreamBoundaryRequired) {
      throw new Error(`Checkout copy policy '${surface}' must protect pending-vs-committed language.`);
    }
  }

  for (const surface of [
    "readiness-unassigned-fulfillment",
    "readiness-optimization-offer",
    "readiness-blocked-or-unavailable",
  ] as const satisfies readonly CheckoutCopySurfaceKey[]) {
    if (bySurface.get(surface)?.kind !== "cart-list-readiness") {
      throw new Error(`Checkout copy policy '${surface}' must stay before checkout.`);
    }
  }

  for (const surface of noSideEffectSurfaces) {
    const entry = bySurface.get(surface);
    if (entry?.customerVisible && !entry.examples.some((example) => hasNoSideEffectCopy(example))) {
      throw new Error(`Checkout copy policy '${surface}' needs customer-safe no-side-effect example copy.`);
    }
  }

  const smartMatchAllowed = checkoutCopyPolicyEntries.some((entry) =>
    entry.allowedCustomerTerms.includes("Smart Match"),
  );
  if (!smartMatchAllowed) {
    throw new Error("Checkout copy policy must preserve Smart Match as user-facing language.");
  }
}

function copyPolicy(input: CheckoutCopyPolicyEntry): CheckoutCopyPolicyEntry {
  return input;
}

function noSupportReference(): CheckoutCopySupportReference {
  return {
    required: false,
    safeFields: [],
    forbiddenFields: sensitiveForbiddenFields,
  };
}

function supportReferenceRequired(): CheckoutCopySupportReference {
  return {
    required: true,
    safeFields: allDownstreamSafeFields,
    forbiddenFields: sensitiveForbiddenFields,
  };
}

function findForbiddenTerm(text: string, forbiddenTerms: readonly string[]): string | null {
  const normalized = text.toLocaleLowerCase("en-US");
  return forbiddenTerms.find((term) => normalized.includes(term.toLocaleLowerCase("en-US"))) ?? null;
}

function sameTerm(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

function hasNoSideEffectCopy(text: string): boolean {
  const normalized = text.toLocaleLowerCase("en-US");
  return normalized.startsWith("no ") && normalized.endsWith("started.");
}
