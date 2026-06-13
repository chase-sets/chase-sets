export const checkoutEconomicsPolicyDocPath = "bounded-contexts/checkout/docs/checkout-economics-policy.md" as const;

export type CheckoutEconomicsAudience =
  | "guest-buyer"
  | "signed-in-buyer"
  | "guest-seller"
  | "signed-in-seller"
  | "support-operator";

export type CheckoutEconomicsOwnerContext =
  | "Checkout"
  | "Ordering"
  | "Payments"
  | "Settlement"
  | "Tax"
  | "Fulfillment"
  | "Marketplace"
  | "Commercial Terms"
  | "Support"
  | "Platform";

export type CheckoutEconomicsCheckpoint =
  | "cart-list-readiness"
  | "checkout-session-create"
  | "checkout-render"
  | "active-session-return"
  | "address-change"
  | "wallet-or-express-return"
  | "saved-instrument-edit"
  | "provider-return"
  | "guest-merge"
  | "duplicate-submit"
  | "final-confirmation"
  | "post-confirmation-reversal"
  | "operator-support";

export type CheckoutEconomicsCapabilityStatus = "enabled" | "owner-rule-required" | "internal-only";

export type CheckoutEconomicsOutcome =
  | "valid"
  | "changed"
  | "expired"
  | "invalid"
  | "exhausted"
  | "stale"
  | "disabled"
  | "deferred"
  | "unsupported"
  | "provider-unavailable"
  | "risk-held"
  | "recovered"
  | "no-side-effect";

export type CheckoutEconomicsSurface =
  | "cart-list-readiness"
  | "checkout-summary"
  | "checkout-recovery"
  | "confirmation"
  | "support-runbook"
  | "operations-status";

export type CheckoutEconomicsAmountComponent =
  | "item-subtotal"
  | "shipping"
  | "tax"
  | "marketplace-checkout-fee"
  | "marketplace-sales-fee"
  | "seller-fee-adjustment"
  | "discount"
  | "promo"
  | "gift-card"
  | "wallet-credit"
  | "optional-fulfillment-savings"
  | "label-cost"
  | "payable-total"
  | "seller-payout"
  | "refund"
  | "void"
  | "reversal"
  | "adjustment";

export type CheckoutEconomicsOwnerIssue =
  | "#1102"
  | "#1112"
  | "#1113"
  | "#1114"
  | "#1115"
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

export type CheckoutEconomicsPolicyKey =
  | "buy-payable-total-ordering"
  | "seller-payout-estimate-ordering"
  | "buyer-wallet-credit-application"
  | "marketplace-checkout-fee-quote"
  | "promo-code-capability-status"
  | "gift-card-store-credit-capability-status"
  | "supported-discount-revalidation"
  | "seller-sales-fee-snapshot"
  | "seller-fee-adjustment-payout-deduction"
  | "optional-fulfillment-optimization-savings"
  | "tax-shipping-address-dependent-refresh"
  | "active-session-economics-revalidation"
  | "changed-economics-no-side-effect-recovery"
  | "reversal-economics-linkage"
  | "support-safe-economics-failure"
  | "fresh-state-economics-cleanup";

export type CheckoutEconomicsPolicyEntry = Readonly<{
  control: CheckoutEconomicsPolicyKey;
  docLabel: string;
  ownerIssues: readonly CheckoutEconomicsOwnerIssue[];
  ownerContext: CheckoutEconomicsOwnerContext;
  checkpoints: readonly CheckoutEconomicsCheckpoint[];
  audiences: readonly CheckoutEconomicsAudience[];
  outcomes: readonly CheckoutEconomicsOutcome[];
  surface: CheckoutEconomicsSurface;
  capabilityStatus: CheckoutEconomicsCapabilityStatus;
  amountComponents: readonly CheckoutEconomicsAmountComponent[];
  deterministicOrder: readonly CheckoutEconomicsAmountComponent[];
  snapshotRequired: boolean;
  finalConfirmationRevalidationRequired: boolean;
  ownerRuleRequired: boolean;
  supportReferenceRequired: boolean;
  observabilityRequired: boolean;
  noSideEffectBeforeCommitRequired: boolean;
  readinessOnlyDecision: boolean;
  customerInputAllowed: boolean;
  freshnessKeyShape: string;
  forbiddenMechanisms: readonly string[];
  customerSafeOutcome: string;
}>;

const buyerAudiences = ["guest-buyer", "signed-in-buyer"] as const satisfies readonly CheckoutEconomicsAudience[];
const sellerAudiences = ["guest-seller", "signed-in-seller"] as const satisfies readonly CheckoutEconomicsAudience[];
const allCustomerAudiences = [
  "guest-buyer",
  "signed-in-buyer",
  "guest-seller",
  "signed-in-seller",
] as const satisfies readonly CheckoutEconomicsAudience[];
const allAudiences = [
  "guest-buyer",
  "signed-in-buyer",
  "guest-seller",
  "signed-in-seller",
  "support-operator",
] as const satisfies readonly CheckoutEconomicsAudience[];

export const checkoutBuyPayableTotalOrder = [
  "item-subtotal",
  "shipping",
  "tax",
  "marketplace-checkout-fee",
  "discount",
  "promo",
  "gift-card",
  "wallet-credit",
  "payable-total",
] as const satisfies readonly CheckoutEconomicsAmountComponent[];

export const checkoutSellerPayoutEstimateOrder = [
  "item-subtotal",
  "shipping",
  "marketplace-sales-fee",
  "seller-fee-adjustment",
  "label-cost",
  "seller-payout",
] as const satisfies readonly CheckoutEconomicsAmountComponent[];

export const checkoutEconomicsForbiddenMechanisms = [
  "old checkout payload repair",
  "old session payload adapter",
  "stale cached totals",
  "hidden economics recalculation",
  "migration/backfill helper",
  "dual-write helper",
  "manual database edit",
  "provider-dashboard-only fix",
  "stale fixture bypass",
  "dense checkout fallback",
  "raw provider payload exposure",
  "card or bank data exposure",
] as const;

export const checkoutEconomicsRequiredControls = [
  "buy-payable-total-ordering",
  "seller-payout-estimate-ordering",
  "buyer-wallet-credit-application",
  "marketplace-checkout-fee-quote",
  "promo-code-capability-status",
  "gift-card-store-credit-capability-status",
  "supported-discount-revalidation",
  "seller-sales-fee-snapshot",
  "seller-fee-adjustment-payout-deduction",
  "optional-fulfillment-optimization-savings",
  "tax-shipping-address-dependent-refresh",
  "active-session-economics-revalidation",
  "changed-economics-no-side-effect-recovery",
  "reversal-economics-linkage",
  "support-safe-economics-failure",
  "fresh-state-economics-cleanup",
] as const satisfies readonly CheckoutEconomicsPolicyKey[];

export const checkoutEconomicsOwnerRuleOutcomeStates: readonly CheckoutEconomicsOutcome[] = [
  "changed",
  "expired",
  "invalid",
  "exhausted",
  "stale",
  "disabled",
  "deferred",
  "unsupported",
  "provider-unavailable",
  "risk-held",
] as const;

export const checkoutEconomicsPolicyEntries = [
  economicsPolicy({
    control: "buy-payable-total-ordering",
    docLabel: "Buy payable total ordering",
    ownerIssues: ["#1128", "#1119", "#1130"],
    ownerContext: "Checkout",
    checkpoints: ["cart-list-readiness", "checkout-render", "final-confirmation"],
    audiences: buyerAudiences,
    outcomes: ["valid", "changed", "stale", "no-side-effect"],
    surface: "checkout-summary",
    capabilityStatus: "enabled",
    amountComponents: checkoutBuyPayableTotalOrder,
    deterministicOrder: checkoutBuyPayableTotalOrder,
    snapshotRequired: true,
    finalConfirmationRevalidationRequired: true,
    ownerRuleRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    noSideEffectBeforeCommitRequired: true,
    readinessOnlyDecision: false,
    customerInputAllowed: false,
    freshnessKeyShape: "checkout:buy_payable_total:<readiness-snapshot>:<economics-fingerprint>",
    forbiddenMechanisms: checkoutEconomicsForbiddenMechanisms,
    customerSafeOutcome:
      "Buy totals apply item subtotal, shipping, tax, marketplace checkout fee, discounts, promo, gift card, wallet credit, and payable total in a deterministic order before payment starts.",
  }),
  economicsPolicy({
    control: "seller-payout-estimate-ordering",
    docLabel: "Seller payout estimate ordering",
    ownerIssues: ["#1128", "#1121", "#1135"],
    ownerContext: "Checkout",
    checkpoints: ["cart-list-readiness", "checkout-render", "final-confirmation"],
    audiences: sellerAudiences,
    outcomes: ["valid", "changed", "stale", "no-side-effect"],
    surface: "checkout-summary",
    capabilityStatus: "enabled",
    amountComponents: checkoutSellerPayoutEstimateOrder,
    deterministicOrder: checkoutSellerPayoutEstimateOrder,
    snapshotRequired: true,
    finalConfirmationRevalidationRequired: true,
    ownerRuleRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    noSideEffectBeforeCommitRequired: true,
    readinessOnlyDecision: false,
    customerInputAllowed: false,
    freshnessKeyShape: "checkout:seller_payout_estimate:<sell-list-readiness>:<economics-fingerprint>",
    forbiddenMechanisms: checkoutEconomicsForbiddenMechanisms,
    customerSafeOutcome:
      "Seller payout estimates apply item subtotal, shipping allowance, marketplace sales fee, seller adjustment, label cost, and estimated payout in a deterministic order before confirmation.",
  }),
  economicsPolicy({
    control: "buyer-wallet-credit-application",
    docLabel: "Buyer wallet credit application",
    ownerIssues: ["#1128", "#1113", "#1130", "#1165"],
    ownerContext: "Settlement",
    checkpoints: ["cart-list-readiness", "checkout-render", "provider-return", "final-confirmation"],
    audiences: buyerAudiences,
    outcomes: ["valid", "changed", "exhausted", "stale", "no-side-effect"],
    surface: "checkout-summary",
    capabilityStatus: "enabled",
    amountComponents: ["wallet-credit", "payable-total", "refund", "reversal"],
    deterministicOrder: [...checkoutBuyPayableTotalOrder, "refund", "reversal"],
    snapshotRequired: true,
    finalConfirmationRevalidationRequired: true,
    ownerRuleRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    noSideEffectBeforeCommitRequired: true,
    readinessOnlyDecision: false,
    customerInputAllowed: false,
    freshnessKeyShape: "settlement:wallet_credit:<account-ref>:<balance-version>",
    forbiddenMechanisms: checkoutEconomicsForbiddenMechanisms,
    customerSafeOutcome:
      "Buyer wallet credit uses Settlement-owned available balance facts and Payments-owned application rules; exhausted or changed credit requires review before payment.",
  }),
  economicsPolicy({
    control: "marketplace-checkout-fee-quote",
    docLabel: "Marketplace checkout fee quote",
    ownerIssues: ["#1128", "#1130", "#1134"],
    ownerContext: "Payments",
    checkpoints: ["checkout-render", "saved-instrument-edit", "provider-return", "final-confirmation"],
    audiences: buyerAudiences,
    outcomes: ["valid", "changed", "stale", "provider-unavailable", "no-side-effect"],
    surface: "checkout-summary",
    capabilityStatus: "enabled",
    amountComponents: ["marketplace-checkout-fee", "payable-total"],
    deterministicOrder: checkoutBuyPayableTotalOrder,
    snapshotRequired: true,
    finalConfirmationRevalidationRequired: true,
    ownerRuleRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    noSideEffectBeforeCommitRequired: true,
    readinessOnlyDecision: false,
    customerInputAllowed: false,
    freshnessKeyShape: "payments:marketplace_checkout_fee:<payment-method-ref>:<fee-quote-fingerprint>",
    forbiddenMechanisms: checkoutEconomicsForbiddenMechanisms,
    customerSafeOutcome:
      "Marketplace checkout fee is a Payments-owned quote shown before payment and rejected when the fee quote fingerprint is stale.",
  }),
  economicsPolicy({
    control: "promo-code-capability-status",
    docLabel: "Promo code capability status",
    ownerIssues: ["#1128", "#1102"],
    ownerContext: "Checkout",
    checkpoints: ["cart-list-readiness", "checkout-render", "final-confirmation"],
    audiences: buyerAudiences,
    outcomes: ["disabled", "deferred", "unsupported", "no-side-effect"],
    surface: "operations-status",
    capabilityStatus: "owner-rule-required",
    amountComponents: ["promo", "payable-total"],
    deterministicOrder: checkoutBuyPayableTotalOrder,
    snapshotRequired: false,
    finalConfirmationRevalidationRequired: true,
    ownerRuleRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    noSideEffectBeforeCommitRequired: true,
    readinessOnlyDecision: true,
    customerInputAllowed: false,
    freshnessKeyShape: "checkout:promo_code_capability:<capability-state>",
    forbiddenMechanisms: checkoutEconomicsForbiddenMechanisms,
    customerSafeOutcome:
      "Customer-entered promo codes stay out of checkout until Checkout owns the capability rule; unavailable promo entry is explicit before payment.",
  }),
  economicsPolicy({
    control: "gift-card-store-credit-capability-status",
    docLabel: "Gift card and store credit capability status",
    ownerIssues: ["#1128", "#1102", "#1124"],
    ownerContext: "Payments",
    checkpoints: ["cart-list-readiness", "checkout-render", "final-confirmation"],
    audiences: buyerAudiences,
    outcomes: ["disabled", "deferred", "unsupported", "no-side-effect"],
    surface: "operations-status",
    capabilityStatus: "owner-rule-required",
    amountComponents: ["gift-card", "payable-total", "refund", "reversal"],
    deterministicOrder: [...checkoutBuyPayableTotalOrder, "refund", "reversal"],
    snapshotRequired: false,
    finalConfirmationRevalidationRequired: true,
    ownerRuleRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    noSideEffectBeforeCommitRequired: true,
    readinessOnlyDecision: false,
    customerInputAllowed: false,
    freshnessKeyShape: "payments:gift_card_store_credit_capability:<capability-state>",
    forbiddenMechanisms: checkoutEconomicsForbiddenMechanisms,
    customerSafeOutcome:
      "Gift cards and store credit stay disabled until Payments owns issuance, redemption, refund, and reversal rules.",
  }),
  economicsPolicy({
    control: "supported-discount-revalidation",
    docLabel: "Supported discount revalidation",
    ownerIssues: ["#1128", "#1119", "#1130"],
    ownerContext: "Checkout",
    checkpoints: ["cart-list-readiness", "active-session-return", "duplicate-submit", "final-confirmation"],
    audiences: buyerAudiences,
    outcomes: ["valid", "changed", "expired", "invalid", "exhausted", "no-side-effect"],
    surface: "checkout-recovery",
    capabilityStatus: "enabled",
    amountComponents: ["discount", "promo", "payable-total"],
    deterministicOrder: checkoutBuyPayableTotalOrder,
    snapshotRequired: true,
    finalConfirmationRevalidationRequired: true,
    ownerRuleRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    noSideEffectBeforeCommitRequired: true,
    readinessOnlyDecision: true,
    customerInputAllowed: false,
    freshnessKeyShape: "checkout:discount:<source-revision>:<discount-fingerprint>",
    forbiddenMechanisms: checkoutEconomicsForbiddenMechanisms,
    customerSafeOutcome:
      "Supported discounts are represented in readiness or session snapshots and expire, change, or fail closed before payment or order side effects.",
  }),
  economicsPolicy({
    control: "seller-sales-fee-snapshot",
    docLabel: "Seller sales fee snapshot",
    ownerIssues: ["#1128", "#1119", "#1135"],
    ownerContext: "Commercial Terms",
    checkpoints: ["cart-list-readiness", "checkout-render", "final-confirmation"],
    audiences: sellerAudiences,
    outcomes: ["valid", "changed", "stale", "no-side-effect"],
    surface: "checkout-summary",
    capabilityStatus: "enabled",
    amountComponents: ["marketplace-sales-fee", "seller-payout"],
    deterministicOrder: checkoutSellerPayoutEstimateOrder,
    snapshotRequired: true,
    finalConfirmationRevalidationRequired: true,
    ownerRuleRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    noSideEffectBeforeCommitRequired: true,
    readinessOnlyDecision: true,
    customerInputAllowed: false,
    freshnessKeyShape: "commercial-terms:sales_fee:<fee-quote-fingerprint>",
    forbiddenMechanisms: checkoutEconomicsForbiddenMechanisms,
    customerSafeOutcome:
      "Seller marketplace sales fee snapshots come from confirmed Commercial Terms/Marketplace facts and are rejected when the fee fingerprint changes.",
  }),
  economicsPolicy({
    control: "seller-fee-adjustment-payout-deduction",
    docLabel: "Seller fee adjustment and payout deduction",
    ownerIssues: ["#1128", "#1130", "#1165"],
    ownerContext: "Settlement",
    checkpoints: ["cart-list-readiness", "checkout-render", "final-confirmation", "post-confirmation-reversal"],
    audiences: sellerAudiences,
    outcomes: ["valid", "changed", "risk-held", "stale", "no-side-effect"],
    surface: "checkout-summary",
    capabilityStatus: "enabled",
    amountComponents: ["seller-fee-adjustment", "label-cost", "seller-payout", "reversal", "adjustment"],
    deterministicOrder: [...checkoutSellerPayoutEstimateOrder, "reversal", "adjustment"],
    snapshotRequired: true,
    finalConfirmationRevalidationRequired: true,
    ownerRuleRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    noSideEffectBeforeCommitRequired: true,
    readinessOnlyDecision: true,
    customerInputAllowed: false,
    freshnessKeyShape: "settlement:seller_adjustment:<account-ref>:<adjustment-version>",
    forbiddenMechanisms: checkoutEconomicsForbiddenMechanisms,
    customerSafeOutcome:
      "Seller adjustments, label costs, payout deductions, holds, and reversal-linked changes are visible before seller confirmation or routed to support-safe recovery.",
  }),
  economicsPolicy({
    control: "optional-fulfillment-optimization-savings",
    docLabel: "Optional fulfillment optimization savings",
    ownerIssues: ["#1128", "#1117", "#1119", "#1164"],
    ownerContext: "Checkout",
    checkpoints: ["cart-list-readiness", "checkout-session-create", "final-confirmation"],
    audiences: buyerAudiences,
    outcomes: ["valid", "changed", "stale", "no-side-effect"],
    surface: "cart-list-readiness",
    capabilityStatus: "enabled",
    amountComponents: ["optional-fulfillment-savings", "shipping", "tax", "payable-total"],
    deterministicOrder: ["item-subtotal", "optional-fulfillment-savings", ...checkoutBuyPayableTotalOrder],
    snapshotRequired: true,
    finalConfirmationRevalidationRequired: true,
    ownerRuleRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    noSideEffectBeforeCommitRequired: true,
    readinessOnlyDecision: true,
    customerInputAllowed: false,
    freshnessKeyShape: "checkout:fulfillment_optimization:<readiness-snapshot>:<accepted-or-declined>",
    forbiddenMechanisms: checkoutEconomicsForbiddenMechanisms,
    customerSafeOutcome:
      "Optional savings are accepted or declined in readiness and checkout only displays the outcome without rerunning optimization or exposing allocation machinery.",
  }),
  economicsPolicy({
    control: "tax-shipping-address-dependent-refresh",
    docLabel: "Tax and shipping dependent refresh",
    ownerIssues: ["#1128", "#1127", "#1119", "#1134"],
    ownerContext: "Ordering",
    checkpoints: ["address-change", "wallet-or-express-return", "active-session-return", "final-confirmation"],
    audiences: buyerAudiences,
    outcomes: ["valid", "changed", "stale", "provider-unavailable", "no-side-effect"],
    surface: "checkout-recovery",
    capabilityStatus: "enabled",
    amountComponents: ["shipping", "tax", "marketplace-checkout-fee", "payable-total"],
    deterministicOrder: checkoutBuyPayableTotalOrder,
    snapshotRequired: true,
    finalConfirmationRevalidationRequired: true,
    ownerRuleRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    noSideEffectBeforeCommitRequired: true,
    readinessOnlyDecision: false,
    customerInputAllowed: false,
    freshnessKeyShape: "ordering:address_dependent_economics:<address-fingerprint>:<quote-fingerprint>",
    forbiddenMechanisms: checkoutEconomicsForbiddenMechanisms,
    customerSafeOutcome:
      "Address, shipping, tax, fee, and payment quotes refresh together or route to customer review before payment/order work starts.",
  }),
  economicsPolicy({
    control: "active-session-economics-revalidation",
    docLabel: "Active-session economics revalidation",
    ownerIssues: ["#1128", "#1118", "#1119", "#1123"],
    ownerContext: "Checkout",
    checkpoints: [
      "checkout-render",
      "active-session-return",
      "wallet-or-express-return",
      "saved-instrument-edit",
      "guest-merge",
      "duplicate-submit",
      "final-confirmation",
    ],
    audiences: allCustomerAudiences,
    outcomes: ["valid", "changed", "expired", "exhausted", "stale", "risk-held", "no-side-effect"],
    surface: "checkout-recovery",
    capabilityStatus: "enabled",
    amountComponents: [
      "item-subtotal",
      "shipping",
      "tax",
      "marketplace-checkout-fee",
      "discount",
      "wallet-credit",
      "seller-payout",
    ],
    deterministicOrder: [...checkoutBuyPayableTotalOrder, ...checkoutSellerPayoutEstimateOrder],
    snapshotRequired: true,
    finalConfirmationRevalidationRequired: true,
    ownerRuleRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    noSideEffectBeforeCommitRequired: true,
    readinessOnlyDecision: false,
    customerInputAllowed: false,
    freshnessKeyShape: "checkout:economics_active_session:<session-ref-redacted>:<economics-version>",
    forbiddenMechanisms: checkoutEconomicsForbiddenMechanisms,
    customerSafeOutcome:
      "Active sessions revalidate economics on render, return, wallet/provider return, saved-instrument edit, guest merge, duplicate submit, and final confirmation.",
  }),
  economicsPolicy({
    control: "changed-economics-no-side-effect-recovery",
    docLabel: "Changed economics no-side-effect recovery",
    ownerIssues: ["#1128", "#1130"],
    ownerContext: "Checkout",
    checkpoints: ["checkout-render", "active-session-return", "final-confirmation"],
    audiences: allCustomerAudiences,
    outcomes: ["changed", "expired", "invalid", "exhausted", "stale", "no-side-effect"],
    surface: "checkout-recovery",
    capabilityStatus: "enabled",
    amountComponents: [
      "discount",
      "promo",
      "gift-card",
      "wallet-credit",
      "marketplace-checkout-fee",
      "seller-payout",
      "payable-total",
    ],
    deterministicOrder: [...checkoutBuyPayableTotalOrder, ...checkoutSellerPayoutEstimateOrder],
    snapshotRequired: true,
    finalConfirmationRevalidationRequired: true,
    ownerRuleRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    noSideEffectBeforeCommitRequired: true,
    readinessOnlyDecision: false,
    customerInputAllowed: false,
    freshnessKeyShape: "checkout:economics_no_side_effect:<source-ref>:<failure-code>",
    forbiddenMechanisms: checkoutEconomicsForbiddenMechanisms,
    customerSafeOutcome:
      "Changed economics recovery proves no payment, order, sale, label, payout, settlement, notification, support, account-history, refund, void, or reversal side effect started.",
  }),
  economicsPolicy({
    control: "reversal-economics-linkage",
    docLabel: "Reversal economics linkage",
    ownerIssues: ["#1128", "#1165", "#1130"],
    ownerContext: "Payments",
    checkpoints: ["post-confirmation-reversal", "operator-support"],
    audiences: allCustomerAudiences,
    outcomes: ["valid", "changed", "deferred", "unsupported", "recovered"],
    surface: "confirmation",
    capabilityStatus: "owner-rule-required",
    amountComponents: [
      "refund",
      "void",
      "reversal",
      "adjustment",
      "tax",
      "marketplace-checkout-fee",
      "wallet-credit",
      "gift-card",
      "label-cost",
      "seller-payout",
    ],
    deterministicOrder: [
      "refund",
      "void",
      "reversal",
      "adjustment",
      "tax",
      "marketplace-checkout-fee",
      "wallet-credit",
      "gift-card",
      "label-cost",
      "seller-payout",
    ],
    snapshotRequired: true,
    finalConfirmationRevalidationRequired: false,
    ownerRuleRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    noSideEffectBeforeCommitRequired: true,
    readinessOnlyDecision: false,
    customerInputAllowed: false,
    freshnessKeyShape: "payments:reversal_economics:<order-or-sale-ref>:<effect-id>",
    forbiddenMechanisms: checkoutEconomicsForbiddenMechanisms,
    customerSafeOutcome:
      "Refund, void, reversal, adjustment, tax, fee, credit, gift-card, label, and payout economics link to #1165 recovery facts and remain deferred until owner rules are enabled.",
  }),
  economicsPolicy({
    control: "support-safe-economics-failure",
    docLabel: "Support-safe economics failure",
    ownerIssues: ["#1128", "#1122", "#1124"],
    ownerContext: "Support",
    checkpoints: ["operator-support"],
    audiences: ["support-operator"],
    outcomes: ["changed", "expired", "invalid", "exhausted", "provider-unavailable", "risk-held", "recovered"],
    surface: "support-runbook",
    capabilityStatus: "enabled",
    amountComponents: [
      "marketplace-checkout-fee",
      "marketplace-sales-fee",
      "discount",
      "promo",
      "gift-card",
      "wallet-credit",
      "seller-payout",
    ],
    deterministicOrder: [],
    snapshotRequired: true,
    finalConfirmationRevalidationRequired: true,
    ownerRuleRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    noSideEffectBeforeCommitRequired: true,
    readinessOnlyDecision: false,
    customerInputAllowed: false,
    freshnessKeyShape: "support:economics_failure:<support-safe-reference>:<failure-code>",
    forbiddenMechanisms: checkoutEconomicsForbiddenMechanisms,
    customerSafeOutcome:
      "Support sees masked economics category, owner, freshness status, and support-safe reference without raw provider payloads, cards, banks, or manual repair instructions.",
  }),
  economicsPolicy({
    control: "fresh-state-economics-cleanup",
    docLabel: "Fresh-state economics cleanup",
    ownerIssues: ["#1128", "#1124"],
    ownerContext: "Platform",
    checkpoints: ["checkout-session-create", "checkout-render", "final-confirmation", "operator-support"],
    audiences: allAudiences,
    outcomes: ["disabled", "deferred", "unsupported", "no-side-effect"],
    surface: "operations-status",
    capabilityStatus: "internal-only",
    amountComponents: ["discount", "promo", "gift-card", "wallet-credit", "payable-total", "seller-payout"],
    deterministicOrder: [],
    snapshotRequired: false,
    finalConfirmationRevalidationRequired: true,
    ownerRuleRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    noSideEffectBeforeCommitRequired: true,
    readinessOnlyDecision: false,
    customerInputAllowed: false,
    freshnessKeyShape: "checkout:economics_fresh_state:<scan-or-route-id>:<result>",
    forbiddenMechanisms: checkoutEconomicsForbiddenMechanisms,
    customerSafeOutcome:
      "Fresh-state scans show economics cannot succeed through old payload adapters, stale cached totals, hidden recalculation, migration/backfill helpers, stale fixtures, or dense checkout fallback.",
  }),
] as const satisfies readonly CheckoutEconomicsPolicyEntry[];

export function assertCheckoutEconomicsPolicyCoverage(): void {
  const byControl = new Map(checkoutEconomicsPolicyEntries.map((entry) => [entry.control, entry]));

  for (const control of checkoutEconomicsRequiredControls) {
    if (!byControl.has(control)) {
      throw new Error(`Missing checkout economics policy for '${control}'.`);
    }
  }

  if (byControl.size !== checkoutEconomicsPolicyEntries.length) {
    throw new Error("Checkout economics policy controls must be unique.");
  }

  for (const entry of checkoutEconomicsPolicyEntries) {
    if (!entry.ownerIssues.includes("#1128")) {
      throw new Error(`Checkout economics policy '${entry.control}' must include #1128.`);
    }
    if (entry.docLabel.trim().length === 0 || entry.customerSafeOutcome.trim().length === 0) {
      throw new Error(`Checkout economics policy '${entry.control}' needs documentation text.`);
    }
    if (entry.audiences.length === 0 || entry.checkpoints.length === 0 || entry.outcomes.length === 0) {
      throw new Error(`Checkout economics policy '${entry.control}' needs audience/checkpoint/outcome coverage.`);
    }
    if (!entry.observabilityRequired) {
      throw new Error(`Checkout economics policy '${entry.control}' must require observability.`);
    }
    if (
      entry.finalConfirmationRevalidationRequired &&
      !entry.noSideEffectBeforeCommitRequired &&
      entry.checkpoints.includes("final-confirmation")
    ) {
      throw new Error(`Checkout economics policy '${entry.control}' must guard final-confirmation side effects.`);
    }
    if (
      entry.outcomes.some((state) => checkoutEconomicsOwnerRuleOutcomeStates.includes(state)) &&
      (!entry.ownerRuleRequired || !entry.supportReferenceRequired)
    ) {
      throw new Error(
        `Checkout economics policy '${entry.control}' must define owner rules for customer-impacting states.`,
      );
    }
    if (
      entry.capabilityStatus !== "internal-only" &&
      entry.amountComponents.length === 0 &&
      entry.control !== "support-safe-economics-failure"
    ) {
      throw new Error(`Checkout economics policy '${entry.control}' needs component coverage.`);
    }
    if (entry.deterministicOrder.length > 0) {
      for (const component of entry.amountComponents) {
        if (!entry.deterministicOrder.includes(component)) {
          throw new Error(
            `Checkout economics policy '${entry.control}' missing deterministic order component '${component}'.`,
          );
        }
      }
    }
    for (const forbiddenMechanism of checkoutEconomicsForbiddenMechanisms) {
      if (!entry.forbiddenMechanisms.includes(forbiddenMechanism)) {
        throw new Error(`Checkout economics policy '${entry.control}' must forbid '${forbiddenMechanism}'.`);
      }
    }
  }

  for (const control of [
    "promo-code-capability-status",
    "optional-fulfillment-optimization-savings",
    "seller-sales-fee-snapshot",
    "seller-fee-adjustment-payout-deduction",
  ] as const satisfies readonly CheckoutEconomicsPolicyKey[]) {
    const entry = byControl.get(control);
    if (!entry?.readinessOnlyDecision) {
      throw new Error(`Checkout economics policy '${control}' must be decided before checkout repair.`);
    }
  }

  for (const control of [
    "promo-code-capability-status",
    "gift-card-store-credit-capability-status",
  ] as const satisfies readonly CheckoutEconomicsPolicyKey[]) {
    const entry = byControl.get(control);
    if (entry?.customerInputAllowed) {
      throw new Error(`Checkout economics policy '${control}' must not expose unsupported customer input.`);
    }
  }
}

function economicsPolicy(input: CheckoutEconomicsPolicyEntry): CheckoutEconomicsPolicyEntry {
  return input;
}
