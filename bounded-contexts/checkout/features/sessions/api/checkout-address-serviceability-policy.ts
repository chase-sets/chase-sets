export const checkoutAddressServiceabilityPolicyDocPath =
  "bounded-contexts/checkout/docs/checkout-address-serviceability-policy.md" as const;

export type CheckoutAddressAudience =
  | "guest-buyer"
  | "signed-in-buyer"
  | "guest-seller"
  | "signed-in-seller"
  | "support-operator";

export type CheckoutAddressOwnerContext =
  | "Checkout"
  | "Identity"
  | "Fulfillment"
  | "Ordering"
  | "Payments"
  | "Settlement"
  | "Tax"
  | "Support"
  | "Platform";

export type CheckoutAddressCheckpoint =
  | "cart-list-readiness"
  | "checkout-session-create"
  | "manual-address-edit"
  | "saved-row-edit"
  | "wallet-or-express-return"
  | "account-update"
  | "guest-merge"
  | "active-session-return"
  | "duplicate-submit"
  | "final-confirmation"
  | "operator-support";

export type CheckoutAddressOutcome =
  | "valid"
  | "invalid"
  | "restricted"
  | "unserviceable"
  | "quote-unavailable"
  | "provider-outage"
  | "stale"
  | "disabled"
  | "deferred"
  | "unsupported"
  | "recovered"
  | "no-side-effect";

export type CheckoutAddressSurface =
  | "cart-list-readiness"
  | "checkout-form"
  | "checkout-recovery"
  | "provider-return-recovery"
  | "support-runbook"
  | "operations-status";

export type CheckoutAddressCapabilityStatus = "enabled" | "owner-rule-required" | "internal-only";

export type CheckoutAddressQuoteDependency =
  | "shipping-quote"
  | "tax-quote"
  | "payout-quote"
  | "label-service"
  | "split-group-promise"
  | "risk-check"
  | "none";

export type CheckoutAddressOwnerIssue =
  | "#1102"
  | "#1112"
  | "#1113"
  | "#1114"
  | "#1115"
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
  | "#1164";

export type CheckoutAddressPolicyKey =
  | "buyer-delivery-address-validation"
  | "seller-ship-from-address-validation"
  | "saved-address-invalidation"
  | "address-normalization-provider-record"
  | "unsupported-country-region-postal"
  | "po-box-or-restricted-address"
  | "military-remote-or-special-destination"
  | "serviceability-before-provider-quotes"
  | "quote-refresh-after-address-change"
  | "wallet-or-express-address-return"
  | "active-session-address-revalidation"
  | "split-group-shipping-promise"
  | "quote-unavailable-or-provider-outage"
  | "support-safe-address-failure"
  | "no-side-effect-address-blocks"
  | "fresh-state-address-cleanup";

export type CheckoutAddressServiceabilityPolicyEntry = Readonly<{
  control: CheckoutAddressPolicyKey;
  docLabel: string;
  ownerIssues: readonly CheckoutAddressOwnerIssue[];
  ownerContext: CheckoutAddressOwnerContext;
  checkpoints: readonly CheckoutAddressCheckpoint[];
  audiences: readonly CheckoutAddressAudience[];
  outcomes: readonly CheckoutAddressOutcome[];
  surface: CheckoutAddressSurface;
  capabilityStatus: CheckoutAddressCapabilityStatus;
  quoteDependencies: readonly CheckoutAddressQuoteDependency[];
  normalizationRecordRequired: boolean;
  serviceabilityDecisionRequired: boolean;
  supportReferenceRequired: boolean;
  observabilityRequired: boolean;
  ownerRuleRequired: boolean;
  noSideEffectBeforeCommitRequired: boolean;
  redactsSensitiveAddressData: boolean;
  staysBeforeCheckout: boolean;
  freshnessKeyShape: string;
  forbiddenMechanisms: readonly string[];
  customerSafeOutcome: string;
}>;

const buyerAudiences = ["guest-buyer", "signed-in-buyer"] as const satisfies readonly CheckoutAddressAudience[];
const sellerAudiences = ["guest-seller", "signed-in-seller"] as const satisfies readonly CheckoutAddressAudience[];
const allCustomerAudiences = [
  "guest-buyer",
  "signed-in-buyer",
  "guest-seller",
  "signed-in-seller",
] as const satisfies readonly CheckoutAddressAudience[];
const allAudiences = [
  "guest-buyer",
  "signed-in-buyer",
  "guest-seller",
  "signed-in-seller",
  "support-operator",
] as const satisfies readonly CheckoutAddressAudience[];

export const checkoutAddressForbiddenMechanisms = [
  "old checkout payload repair",
  "old address payload translation",
  "hidden address normalization",
  "migration/backfill helper",
  "dual-write helper",
  "stale read-model acceptance",
  "provider-dashboard-only fix",
  "manual database edit",
  "stale fixture bypass",
  "dense checkout fallback",
  "raw provider payload exposure",
  "full address exposure in telemetry",
] as const;

export const checkoutAddressRequiredControls = [
  "buyer-delivery-address-validation",
  "seller-ship-from-address-validation",
  "saved-address-invalidation",
  "address-normalization-provider-record",
  "unsupported-country-region-postal",
  "po-box-or-restricted-address",
  "military-remote-or-special-destination",
  "serviceability-before-provider-quotes",
  "quote-refresh-after-address-change",
  "wallet-or-express-address-return",
  "active-session-address-revalidation",
  "split-group-shipping-promise",
  "quote-unavailable-or-provider-outage",
  "support-safe-address-failure",
  "no-side-effect-address-blocks",
  "fresh-state-address-cleanup",
] as const satisfies readonly CheckoutAddressPolicyKey[];

export const checkoutAddressOwnerRuleOutcomeStates: readonly CheckoutAddressOutcome[] = [
  "restricted",
  "unserviceable",
  "quote-unavailable",
  "provider-outage",
  "stale",
  "disabled",
  "deferred",
  "unsupported",
] as const;

export const checkoutAddressServiceabilityPolicyEntries = [
  addressPolicy({
    control: "buyer-delivery-address-validation",
    docLabel: "Buyer delivery address validation",
    ownerIssues: ["#1127", "#1102", "#1112", "#1114", "#1115", "#1119"],
    ownerContext: "Checkout",
    checkpoints: ["manual-address-edit", "checkout-session-create", "final-confirmation"],
    audiences: buyerAudiences,
    outcomes: ["valid", "invalid", "recovered", "no-side-effect"],
    surface: "checkout-form",
    capabilityStatus: "enabled",
    quoteDependencies: ["shipping-quote", "tax-quote", "risk-check"],
    normalizationRecordRequired: true,
    serviceabilityDecisionRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: false,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveAddressData: true,
    staysBeforeCheckout: false,
    freshnessKeyShape: "checkout:buyer_delivery_address:<source-revision>:<address-fingerprint>",
    forbiddenMechanisms: checkoutAddressForbiddenMechanisms,
    customerSafeOutcome:
      "Guest and signed-in buyers cannot proceed to payment or order creation until required delivery fields, the normalization record, serviceability, quote readiness, and risk dependencies are current.",
  }),
  addressPolicy({
    control: "seller-ship-from-address-validation",
    docLabel: "Seller ship-from address validation",
    ownerIssues: ["#1127", "#1121", "#1135", "#1115"],
    ownerContext: "Fulfillment",
    checkpoints: ["cart-list-readiness", "manual-address-edit", "final-confirmation"],
    audiences: sellerAudiences,
    outcomes: ["valid", "invalid", "restricted", "unserviceable", "no-side-effect"],
    surface: "cart-list-readiness",
    capabilityStatus: "enabled",
    quoteDependencies: ["label-service", "payout-quote", "risk-check"],
    normalizationRecordRequired: true,
    serviceabilityDecisionRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveAddressData: true,
    staysBeforeCheckout: true,
    freshnessKeyShape: "checkout:seller_ship_from:<sell-list-revision>:<address-fingerprint>",
    forbiddenMechanisms: checkoutAddressForbiddenMechanisms,
    customerSafeOutcome:
      "Guest and signed-in sellers cannot confirm label, payout, settlement, notification, or account-history work when ship-from facts are missing, stale, restricted, or unserviceable.",
  }),
  addressPolicy({
    control: "saved-address-invalidation",
    docLabel: "Saved address invalidation",
    ownerIssues: ["#1127", "#1121", "#1118", "#1119"],
    ownerContext: "Identity",
    checkpoints: ["saved-row-edit", "account-update", "active-session-return", "final-confirmation"],
    audiences: ["signed-in-buyer", "signed-in-seller"],
    outcomes: ["valid", "invalid", "stale", "recovered", "no-side-effect"],
    surface: "checkout-recovery",
    capabilityStatus: "enabled",
    quoteDependencies: ["shipping-quote", "tax-quote", "payout-quote", "label-service", "risk-check"],
    normalizationRecordRequired: true,
    serviceabilityDecisionRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveAddressData: true,
    staysBeforeCheckout: false,
    freshnessKeyShape: "identity:saved_address:<address-id>:<address-version>",
    forbiddenMechanisms: checkoutAddressForbiddenMechanisms,
    customerSafeOutcome:
      "Saved addresses that are edited, revoked, normalized differently, or made unsupported fall back to editable rows and invalidate dependent quotes before confirmation.",
  }),
  addressPolicy({
    control: "address-normalization-provider-record",
    docLabel: "Address normalization provider record",
    ownerIssues: ["#1127", "#1124", "#1134"],
    ownerContext: "Fulfillment",
    checkpoints: ["manual-address-edit", "wallet-or-express-return", "final-confirmation"],
    audiences: allCustomerAudiences,
    outcomes: ["valid", "invalid", "provider-outage", "unsupported", "no-side-effect"],
    surface: "provider-return-recovery",
    capabilityStatus: "owner-rule-required",
    quoteDependencies: ["shipping-quote", "tax-quote", "label-service"],
    normalizationRecordRequired: true,
    serviceabilityDecisionRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveAddressData: true,
    staysBeforeCheckout: false,
    freshnessKeyShape: "fulfillment:address_normalization:<provider-version>:<address-fingerprint>",
    forbiddenMechanisms: checkoutAddressForbiddenMechanisms,
    customerSafeOutcome:
      "Provider normalization records the provider version and support-safe failure codes without hidden normalization or provider payload exposure.",
  }),
  addressPolicy({
    control: "unsupported-country-region-postal",
    docLabel: "Unsupported country, region, or postal code",
    ownerIssues: ["#1127", "#1102", "#1112"],
    ownerContext: "Fulfillment",
    checkpoints: ["cart-list-readiness", "manual-address-edit", "final-confirmation"],
    audiences: allCustomerAudiences,
    outcomes: ["restricted", "unserviceable", "unsupported", "no-side-effect"],
    surface: "checkout-recovery",
    capabilityStatus: "owner-rule-required",
    quoteDependencies: ["shipping-quote", "tax-quote", "payout-quote", "label-service"],
    normalizationRecordRequired: true,
    serviceabilityDecisionRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveAddressData: true,
    staysBeforeCheckout: false,
    freshnessKeyShape: "fulfillment:destination_support:<country-region-postal-prefix>:<policy-version>",
    forbiddenMechanisms: checkoutAddressForbiddenMechanisms,
    customerSafeOutcome:
      "Unsupported country, region, and postal outcomes show simple recovery or return-to-list/cart guidance before any payment, order, label, payout, or fulfillment side effect starts.",
  }),
  addressPolicy({
    control: "po-box-or-restricted-address",
    docLabel: "PO box or restricted address",
    ownerIssues: ["#1127", "#1102", "#1112"],
    ownerContext: "Fulfillment",
    checkpoints: ["manual-address-edit", "final-confirmation"],
    audiences: buyerAudiences,
    outcomes: ["restricted", "unserviceable", "no-side-effect"],
    surface: "checkout-form",
    capabilityStatus: "owner-rule-required",
    quoteDependencies: ["shipping-quote", "tax-quote", "risk-check"],
    normalizationRecordRequired: true,
    serviceabilityDecisionRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveAddressData: true,
    staysBeforeCheckout: false,
    freshnessKeyShape: "fulfillment:restricted_address:<restriction-code>:<address-fingerprint>",
    forbiddenMechanisms: checkoutAddressForbiddenMechanisms,
    customerSafeOutcome:
      "PO box and restricted-address outcomes block unavailable shipping services with customer-safe copy and no raw carrier/provider diagnostics.",
  }),
  addressPolicy({
    control: "military-remote-or-special-destination",
    docLabel: "Military, remote, or special destination",
    ownerIssues: ["#1127", "#1164"],
    ownerContext: "Fulfillment",
    checkpoints: ["cart-list-readiness", "manual-address-edit", "final-confirmation"],
    audiences: buyerAudiences,
    outcomes: ["valid", "restricted", "unserviceable", "quote-unavailable", "unsupported"],
    surface: "checkout-recovery",
    capabilityStatus: "owner-rule-required",
    quoteDependencies: ["shipping-quote", "tax-quote", "split-group-promise", "risk-check"],
    normalizationRecordRequired: true,
    serviceabilityDecisionRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveAddressData: true,
    staysBeforeCheckout: false,
    freshnessKeyShape: "fulfillment:special_destination:<destination-class>:<policy-version>",
    forbiddenMechanisms: checkoutAddressForbiddenMechanisms,
    customerSafeOutcome:
      "Military, remote, and special destination rules are explicit owner-rule states, not implicit carrier failures discovered after payment or label work starts.",
  }),
  addressPolicy({
    control: "serviceability-before-provider-quotes",
    docLabel: "Serviceability before provider quotes",
    ownerIssues: ["#1127", "#1128", "#1130", "#1134"],
    ownerContext: "Checkout",
    checkpoints: ["manual-address-edit", "checkout-session-create", "final-confirmation"],
    audiences: allCustomerAudiences,
    outcomes: ["valid", "invalid", "unserviceable", "quote-unavailable", "provider-outage", "no-side-effect"],
    surface: "checkout-form",
    capabilityStatus: "enabled",
    quoteDependencies: ["shipping-quote", "tax-quote", "payout-quote", "label-service", "risk-check"],
    normalizationRecordRequired: true,
    serviceabilityDecisionRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveAddressData: true,
    staysBeforeCheckout: false,
    freshnessKeyShape: "checkout:address_quote_gate:<address-fingerprint>:<quote-purpose>",
    forbiddenMechanisms: checkoutAddressForbiddenMechanisms,
    customerSafeOutcome:
      "Shipping, tax, payout, label, split-group, and risk provider calls run only after the address is sufficient for that provider and are rejected when the serviceability decision is stale.",
  }),
  addressPolicy({
    control: "quote-refresh-after-address-change",
    docLabel: "Quote refresh after address change",
    ownerIssues: ["#1127", "#1119", "#1128", "#1130"],
    ownerContext: "Checkout",
    checkpoints: ["manual-address-edit", "saved-row-edit", "wallet-or-express-return", "final-confirmation"],
    audiences: allCustomerAudiences,
    outcomes: ["valid", "stale", "quote-unavailable", "no-side-effect"],
    surface: "checkout-recovery",
    capabilityStatus: "enabled",
    quoteDependencies: ["shipping-quote", "tax-quote", "payout-quote", "label-service", "split-group-promise"],
    normalizationRecordRequired: true,
    serviceabilityDecisionRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveAddressData: true,
    staysBeforeCheckout: false,
    freshnessKeyShape: "checkout:address_dependent_quote:<address-fingerprint>:<quote-fingerprint>",
    forbiddenMechanisms: checkoutAddressForbiddenMechanisms,
    customerSafeOutcome:
      "Manual edits, saved-row edits, wallet returns, and provider normalization changes invalidate address-dependent quote fingerprints before final confirmation.",
  }),
  addressPolicy({
    control: "wallet-or-express-address-return",
    docLabel: "Wallet or express address return",
    ownerIssues: ["#1127", "#1113", "#1121", "#1134"],
    ownerContext: "Payments",
    checkpoints: ["wallet-or-express-return", "active-session-return", "final-confirmation"],
    audiences: buyerAudiences,
    outcomes: ["valid", "invalid", "restricted", "provider-outage", "stale", "no-side-effect"],
    surface: "provider-return-recovery",
    capabilityStatus: "owner-rule-required",
    quoteDependencies: ["shipping-quote", "tax-quote", "risk-check"],
    normalizationRecordRequired: true,
    serviceabilityDecisionRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveAddressData: true,
    staysBeforeCheckout: false,
    freshnessKeyShape: "payments:wallet_address_return:<provider-ref>:<address-fingerprint>",
    forbiddenMechanisms: checkoutAddressForbiddenMechanisms,
    customerSafeOutcome:
      "Wallet or express-return addresses re-enter the same serviceability and quote gates; unsupported changes return to simple correction instead of continuing with stale totals.",
  }),
  addressPolicy({
    control: "active-session-address-revalidation",
    docLabel: "Active-session address revalidation",
    ownerIssues: ["#1127", "#1118", "#1119", "#1123"],
    ownerContext: "Checkout",
    checkpoints: ["active-session-return", "duplicate-submit", "final-confirmation"],
    audiences: allCustomerAudiences,
    outcomes: ["valid", "invalid", "stale", "restricted", "unserviceable", "no-side-effect"],
    surface: "checkout-recovery",
    capabilityStatus: "enabled",
    quoteDependencies: ["shipping-quote", "tax-quote", "payout-quote", "label-service", "risk-check"],
    normalizationRecordRequired: true,
    serviceabilityDecisionRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveAddressData: true,
    staysBeforeCheckout: false,
    freshnessKeyShape: "checkout:active_session_address:<session-ref-redacted>:<address-version>",
    forbiddenMechanisms: checkoutAddressForbiddenMechanisms,
    customerSafeOutcome:
      "Active sessions revalidate address and dependent provider facts on return, reload, duplicate submit, and final confirmation before any customer-committing side effect starts.",
  }),
  addressPolicy({
    control: "split-group-shipping-promise",
    docLabel: "Split-group shipping promise",
    ownerIssues: ["#1127", "#1164", "#1114", "#1115"],
    ownerContext: "Fulfillment",
    checkpoints: ["cart-list-readiness", "manual-address-edit", "final-confirmation"],
    audiences: buyerAudiences,
    outcomes: ["valid", "stale", "quote-unavailable", "unserviceable", "no-side-effect"],
    surface: "cart-list-readiness",
    capabilityStatus: "owner-rule-required",
    quoteDependencies: ["shipping-quote", "split-group-promise", "risk-check"],
    normalizationRecordRequired: true,
    serviceabilityDecisionRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveAddressData: true,
    staysBeforeCheckout: true,
    freshnessKeyShape: "fulfillment:split_group_shipping:<readiness-snapshot>:<address-fingerprint>",
    forbiddenMechanisms: checkoutAddressForbiddenMechanisms,
    customerSafeOutcome:
      "Split-group shipping promises are produced by readiness and consumed by checkout; address changes route back to readiness instead of regrouping shipments in checkout.",
  }),
  addressPolicy({
    control: "quote-unavailable-or-provider-outage",
    docLabel: "Quote unavailable or provider outage",
    ownerIssues: ["#1127", "#1134", "#1122"],
    ownerContext: "Platform",
    checkpoints: ["manual-address-edit", "wallet-or-express-return", "final-confirmation", "operator-support"],
    audiences: allAudiences,
    outcomes: ["quote-unavailable", "provider-outage", "disabled", "deferred", "unsupported", "no-side-effect"],
    surface: "operations-status",
    capabilityStatus: "owner-rule-required",
    quoteDependencies: ["shipping-quote", "tax-quote", "payout-quote", "label-service", "risk-check"],
    normalizationRecordRequired: true,
    serviceabilityDecisionRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveAddressData: true,
    staysBeforeCheckout: false,
    freshnessKeyShape: "platform:address_quote_capability:<provider-or-capability>:<state>",
    forbiddenMechanisms: checkoutAddressForbiddenMechanisms,
    customerSafeOutcome:
      "Quote-unavailable, provider-outage, disabled, deferred, and unsupported address states have owner rules, copy, visual target, observability, and support-safe recovery.",
  }),
  addressPolicy({
    control: "support-safe-address-failure",
    docLabel: "Support-safe address failure",
    ownerIssues: ["#1127", "#1122", "#1124"],
    ownerContext: "Support",
    checkpoints: ["operator-support"],
    audiences: ["support-operator"],
    outcomes: ["invalid", "restricted", "unserviceable", "quote-unavailable", "provider-outage", "recovered"],
    surface: "support-runbook",
    capabilityStatus: "enabled",
    quoteDependencies: ["shipping-quote", "tax-quote", "payout-quote", "label-service", "risk-check"],
    normalizationRecordRequired: true,
    serviceabilityDecisionRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveAddressData: true,
    staysBeforeCheckout: false,
    freshnessKeyShape: "support:address_failure:<support-safe-reference>:<failure-code>",
    forbiddenMechanisms: checkoutAddressForbiddenMechanisms,
    customerSafeOutcome:
      "Support can see masked address failure category, owner, freshness status, and support-safe reference without full address, raw provider payload, or manual repair instructions.",
  }),
  addressPolicy({
    control: "no-side-effect-address-blocks",
    docLabel: "No-side-effect address blocks",
    ownerIssues: ["#1127", "#1130", "#1135"],
    ownerContext: "Checkout",
    checkpoints: ["checkout-session-create", "active-session-return", "final-confirmation"],
    audiences: allCustomerAudiences,
    outcomes: ["invalid", "restricted", "unserviceable", "stale", "quote-unavailable", "no-side-effect"],
    surface: "checkout-recovery",
    capabilityStatus: "enabled",
    quoteDependencies: [
      "shipping-quote",
      "tax-quote",
      "payout-quote",
      "label-service",
      "split-group-promise",
      "risk-check",
    ],
    normalizationRecordRequired: true,
    serviceabilityDecisionRequired: true,
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveAddressData: true,
    staysBeforeCheckout: false,
    freshnessKeyShape: "checkout:address_no_side_effect:<source-ref>:<failure-code>",
    forbiddenMechanisms: checkoutAddressForbiddenMechanisms,
    customerSafeOutcome:
      "Address blocks prove no payment, order, sale, label, payout, fulfillment, settlement, notification, support, account-history, refund, void, or reversal side effect started.",
  }),
  addressPolicy({
    control: "fresh-state-address-cleanup",
    docLabel: "Fresh-state address cleanup",
    ownerIssues: ["#1127", "#1124"],
    ownerContext: "Platform",
    checkpoints: ["checkout-session-create", "active-session-return", "final-confirmation", "operator-support"],
    audiences: allAudiences,
    outcomes: ["disabled", "unsupported", "no-side-effect"],
    surface: "operations-status",
    capabilityStatus: "internal-only",
    quoteDependencies: ["none"],
    normalizationRecordRequired: false,
    serviceabilityDecisionRequired: false,
    supportReferenceRequired: true,
    observabilityRequired: true,
    ownerRuleRequired: true,
    noSideEffectBeforeCommitRequired: true,
    redactsSensitiveAddressData: true,
    staysBeforeCheckout: false,
    freshnessKeyShape: "checkout:address_fresh_state:<scan-or-route-id>:<result>",
    forbiddenMechanisms: checkoutAddressForbiddenMechanisms,
    customerSafeOutcome:
      "Fresh-state scans show address handling cannot succeed through old payloads, hidden normalization, migration/backfill helpers, stale read models, stale fixtures, or dense checkout fallback.",
  }),
] as const satisfies readonly CheckoutAddressServiceabilityPolicyEntry[];

export function assertCheckoutAddressServiceabilityPolicyCoverage(): void {
  const byControl = new Map(checkoutAddressServiceabilityPolicyEntries.map((entry) => [entry.control, entry]));

  for (const control of checkoutAddressRequiredControls) {
    if (!byControl.has(control)) {
      throw new Error(`Missing checkout address/serviceability policy for '${control}'.`);
    }
  }

  if (byControl.size !== checkoutAddressServiceabilityPolicyEntries.length) {
    throw new Error("Checkout address/serviceability policy controls must be unique.");
  }

  for (const entry of checkoutAddressServiceabilityPolicyEntries) {
    if (!entry.ownerIssues.includes("#1127")) {
      throw new Error(`Checkout address/serviceability policy '${entry.control}' must include #1127.`);
    }
    if (entry.docLabel.trim().length === 0 || entry.customerSafeOutcome.trim().length === 0) {
      throw new Error(`Checkout address/serviceability policy '${entry.control}' needs documentation text.`);
    }
    if (entry.audiences.length === 0 || entry.checkpoints.length === 0 || entry.outcomes.length === 0) {
      throw new Error(`Checkout address/serviceability policy '${entry.control}' needs audience/checkpoint/outcome.`);
    }
    if (!entry.observabilityRequired || !entry.redactsSensitiveAddressData) {
      throw new Error(`Checkout address/serviceability policy '${entry.control}' must require redacted telemetry.`);
    }
    if (entry.quoteDependencies.some((dependency) => dependency !== "none")) {
      if (!entry.normalizationRecordRequired || !entry.serviceabilityDecisionRequired) {
        throw new Error(
          `Checkout address/serviceability policy '${entry.control}' must gate provider quotes on address normalization records.`,
        );
      }
    }
    if (
      entry.outcomes.some((state) => checkoutAddressOwnerRuleOutcomeStates.includes(state)) &&
      (!entry.ownerRuleRequired || !entry.supportReferenceRequired || !entry.noSideEffectBeforeCommitRequired)
    ) {
      throw new Error(
        `Checkout address/serviceability policy '${entry.control}' must define owner rules for customer-impacting failures.`,
      );
    }
    for (const forbiddenMechanism of checkoutAddressForbiddenMechanisms) {
      if (!entry.forbiddenMechanisms.includes(forbiddenMechanism)) {
        throw new Error(
          `Checkout address/serviceability policy '${entry.control}' must forbid '${forbiddenMechanism}'.`,
        );
      }
    }
  }

  for (const control of [
    "seller-ship-from-address-validation",
    "split-group-shipping-promise",
  ] as const satisfies readonly CheckoutAddressPolicyKey[]) {
    const entry = byControl.get(control);
    if (!entry?.staysBeforeCheckout) {
      throw new Error(`Checkout address/serviceability policy '${control}' must stay before checkout.`);
    }
  }

  for (const entry of checkoutAddressServiceabilityPolicyEntries.filter((policy) =>
    policy.checkpoints.includes("final-confirmation"),
  )) {
    if (!entry.noSideEffectBeforeCommitRequired) {
      throw new Error(
        `Checkout address/serviceability policy '${entry.control}' must guard final-confirmation side effects.`,
      );
    }
  }
}

function addressPolicy(input: CheckoutAddressServiceabilityPolicyEntry): CheckoutAddressServiceabilityPolicyEntry {
  return input;
}
