import type { CheckoutCopySurfaceKey } from "./checkout-copy-policy";
import type { CheckoutScenarioState } from "./checkout-observability-contract";
import type { CheckoutVisualOwnerIssue, CheckoutVisualTargetKey } from "./checkout-visual-targets";

export const checkoutPaymentPayoutAffordancePolicyDocPath =
  "bounded-contexts/checkout/docs/checkout-payment-payout-affordance-policy.md" as const;

export type CheckoutPaymentPayoutAffordanceKey =
  | "guest-card-payment-form"
  | "signed-in-saved-payment-row"
  | "accelerated-saved-payment-confirmation"
  | "guest-saved-payment-block"
  | "provider-return-review"
  | "seller-payout-setup-handoff"
  | "signed-in-saved-payout-row"
  | "seller-payout-setup-recovery";

export type CheckoutPaymentPayoutMode = "buy" | "sell";
export type CheckoutPaymentPayoutActorMode = "guest" | "signed-in";

export type CheckoutPaymentPayoutSourceOwner = "Checkout" | "Identity" | "Payments" | "Settlement";

export type CheckoutPaymentPayoutCapabilityStatus =
  | "enabled"
  | "disabled"
  | "deferred"
  | "setup-required"
  | "provider-unavailable";

export type CheckoutPaymentPayoutCheckpoint =
  | "checkout-render"
  | "saved-row-edit"
  | "provider-return"
  | "final-confirmation"
  | "seller-readiness";

export type CheckoutPaymentPayoutRequiredFact =
  | "readiness-snapshot-current"
  | "contact-current"
  | "address-current"
  | "shipping-current"
  | "economics-current"
  | "risk-clear"
  | "provider-ready"
  | "saved-instrument-current"
  | "payout-readiness-current"
  | "seller-readiness-current";

export type CheckoutPaymentPayoutSideEffectBoundary =
  | "none-before-final-confirmation"
  | "final-confirmation-only"
  | "owner-managed-handoff-only";

export type CheckoutPaymentPayoutSensitiveField =
  | "raw-card"
  | "cvc"
  | "bank-account"
  | "provider-secret"
  | "provider-payload"
  | "full-url"
  | "email"
  | "address"
  | "session-token";

export type CheckoutPaymentPayoutAffordancePolicyEntry = Readonly<{
  affordance: CheckoutPaymentPayoutAffordanceKey;
  docLabel: string;
  ownerIssues: readonly CheckoutVisualOwnerIssue[];
  mode: CheckoutPaymentPayoutMode;
  actorModes: readonly CheckoutPaymentPayoutActorMode[];
  sourceOwner: CheckoutPaymentPayoutSourceOwner;
  capabilityStatus: CheckoutPaymentPayoutCapabilityStatus;
  checkpoints: readonly CheckoutPaymentPayoutCheckpoint[];
  requiredFacts: readonly CheckoutPaymentPayoutRequiredFact[];
  fallbackAction: string;
  sideEffectBoundary: CheckoutPaymentPayoutSideEffectBoundary;
  explicitFinalConfirmationRequired: boolean;
  redactedSensitiveFields: readonly CheckoutPaymentPayoutSensitiveField[];
  supportReferenceRequired: boolean;
  copySurface: CheckoutCopySurfaceKey;
  visualTarget: CheckoutVisualTargetKey;
  scenarioStates: readonly CheckoutScenarioState[];
  customerSafeOutcome: string;
}>;

export const checkoutPaymentPayoutSensitiveFields = [
  "raw-card",
  "cvc",
  "bank-account",
  "provider-secret",
  "provider-payload",
  "full-url",
  "email",
  "address",
  "session-token",
] as const satisfies readonly CheckoutPaymentPayoutSensitiveField[];

const buyCheckoutFacts = [
  "readiness-snapshot-current",
  "contact-current",
  "address-current",
  "shipping-current",
  "economics-current",
  "risk-clear",
  "provider-ready",
] as const satisfies readonly CheckoutPaymentPayoutRequiredFact[];

const sellCheckoutFacts = [
  "readiness-snapshot-current",
  "seller-readiness-current",
  "address-current",
  "economics-current",
  "risk-clear",
  "provider-ready",
  "payout-readiness-current",
] as const satisfies readonly CheckoutPaymentPayoutRequiredFact[];

export const checkoutPaymentPayoutAffordancePolicyEntries = [
  affordancePolicy({
    affordance: "guest-card-payment-form",
    docLabel: "Guest card payment form",
    ownerIssues: ["#1113", "#1124", "#1134"],
    mode: "buy",
    actorModes: ["guest"],
    sourceOwner: "Payments",
    capabilityStatus: "enabled",
    checkpoints: ["checkout-render", "final-confirmation"],
    requiredFacts: buyCheckoutFacts,
    fallbackAction: "Keep the card form available when wallet or saved methods are unavailable.",
    sideEffectBoundary: "final-confirmation-only",
    explicitFinalConfirmationRequired: true,
    redactedSensitiveFields: checkoutPaymentPayoutSensitiveFields,
    supportReferenceRequired: false,
    copySurface: "checkout-review",
    visualTarget: "guest-buy-checkout",
    scenarioStates: ["normal"],
    customerSafeOutcome:
      "Guests can pay through the normal checkout form without account creation or Chase Sets handling raw card data.",
  }),
  affordancePolicy({
    affordance: "signed-in-saved-payment-row",
    docLabel: "Signed-in saved payment row",
    ownerIssues: ["#1113", "#1121", "#1124"],
    mode: "buy",
    actorModes: ["signed-in"],
    sourceOwner: "Identity",
    capabilityStatus: "enabled",
    checkpoints: ["checkout-render", "saved-row-edit", "final-confirmation"],
    requiredFacts: [...buyCheckoutFacts, "saved-instrument-current"],
    fallbackAction: "Show the card form when the saved payment row is stale, missing, disabled, or provider-blocked.",
    sideEffectBoundary: "final-confirmation-only",
    explicitFinalConfirmationRequired: true,
    redactedSensitiveFields: checkoutPaymentPayoutSensitiveFields,
    supportReferenceRequired: false,
    copySurface: "checkout-saved-info-rows",
    visualTarget: "signed-in-buy-checkout",
    scenarioStates: ["normal"],
    customerSafeOutcome:
      "Signed-in buyers can reuse a masked saved payment row only when current account and provider facts are available.",
  }),
  affordancePolicy({
    affordance: "accelerated-saved-payment-confirmation",
    docLabel: "Accelerated saved payment confirmation",
    ownerIssues: ["#1113", "#1115", "#1124", "#1134"],
    mode: "buy",
    actorModes: ["signed-in"],
    sourceOwner: "Payments",
    capabilityStatus: "enabled",
    checkpoints: ["checkout-render", "final-confirmation"],
    requiredFacts: [...buyCheckoutFacts, "saved-instrument-current"],
    fallbackAction: "Fall back to full checkout review when any reviewed fact changes.",
    sideEffectBoundary: "final-confirmation-only",
    explicitFinalConfirmationRequired: true,
    redactedSensitiveFields: checkoutPaymentPayoutSensitiveFields,
    supportReferenceRequired: false,
    copySurface: "checkout-saved-info-rows",
    visualTarget: "signed-in-buy-checkout",
    scenarioStates: ["normal"],
    customerSafeOutcome:
      "Accelerated saved payment is a shorter confirmation path, not a bypass around readiness, totals, risk, or provider checks.",
  }),
  affordancePolicy({
    affordance: "guest-saved-payment-block",
    docLabel: "Guest saved payment block",
    ownerIssues: ["#1113", "#1115", "#1124"],
    mode: "buy",
    actorModes: ["guest"],
    sourceOwner: "Checkout",
    capabilityStatus: "disabled",
    checkpoints: ["final-confirmation"],
    requiredFacts: ["readiness-snapshot-current"],
    fallbackAction: "Tell guests to continue with card payment or sign in before using saved methods.",
    sideEffectBoundary: "none-before-final-confirmation",
    explicitFinalConfirmationRequired: true,
    redactedSensitiveFields: checkoutPaymentPayoutSensitiveFields,
    supportReferenceRequired: true,
    copySurface: "accelerated-saved-instrument-fallback",
    visualTarget: "disabled-accelerated-saved-instrument",
    scenarioStates: ["disabled-capability"],
    customerSafeOutcome:
      "Guest saved-payment attempts fail before checkout mutations and emit support-safe disabled-capability telemetry.",
  }),
  affordancePolicy({
    affordance: "provider-return-review",
    docLabel: "Provider return review",
    ownerIssues: ["#1113", "#1119", "#1122", "#1134"],
    mode: "buy",
    actorModes: ["guest", "signed-in"],
    sourceOwner: "Payments",
    capabilityStatus: "provider-unavailable",
    checkpoints: ["provider-return", "checkout-render", "final-confirmation"],
    requiredFacts: ["readiness-snapshot-current", "economics-current", "risk-clear", "provider-ready"],
    fallbackAction: "Return to checkout review when provider or wallet return facts are stale or unavailable.",
    sideEffectBoundary: "none-before-final-confirmation",
    explicitFinalConfirmationRequired: true,
    redactedSensitiveFields: checkoutPaymentPayoutSensitiveFields,
    supportReferenceRequired: true,
    copySurface: "provider-return-recovery",
    visualTarget: "risk-hold-provider-return-failure",
    scenarioStates: ["provider-outage", "blocked"],
    customerSafeOutcome:
      "Provider returns require a fresh review before retry and never expose provider payloads or raw payment details.",
  }),
  affordancePolicy({
    affordance: "seller-payout-setup-handoff",
    docLabel: "Seller payout setup handoff",
    ownerIssues: ["#1113", "#1121", "#1124", "#1134"],
    mode: "sell",
    actorModes: ["guest", "signed-in"],
    sourceOwner: "Settlement",
    capabilityStatus: "setup-required",
    checkpoints: ["seller-readiness", "checkout-render"],
    requiredFacts: ["readiness-snapshot-current", "seller-readiness-current"],
    fallbackAction: "Route to owner-managed payout setup before seller confirmation can complete.",
    sideEffectBoundary: "owner-managed-handoff-only",
    explicitFinalConfirmationRequired: true,
    redactedSensitiveFields: checkoutPaymentPayoutSensitiveFields,
    supportReferenceRequired: true,
    copySurface: "accelerated-saved-instrument-fallback",
    visualTarget: "disabled-accelerated-saved-instrument",
    scenarioStates: ["deferred-capability"],
    customerSafeOutcome:
      "Payout setup stays Settlement-owned and cannot create sale, label, payout, settlement, or notification work from Checkout alone.",
  }),
  affordancePolicy({
    affordance: "signed-in-saved-payout-row",
    docLabel: "Signed-in saved payout row",
    ownerIssues: ["#1113", "#1121", "#1124"],
    mode: "sell",
    actorModes: ["signed-in"],
    sourceOwner: "Settlement",
    capabilityStatus: "enabled",
    checkpoints: ["checkout-render", "saved-row-edit", "final-confirmation"],
    requiredFacts: sellCheckoutFacts,
    fallbackAction: "Block seller confirmation when payout readiness is missing, stale, failed, or provider-held.",
    sideEffectBoundary: "final-confirmation-only",
    explicitFinalConfirmationRequired: true,
    redactedSensitiveFields: checkoutPaymentPayoutSensitiveFields,
    supportReferenceRequired: true,
    copySurface: "checkout-saved-info-rows",
    visualTarget: "signed-in-sell-checkout",
    scenarioStates: ["normal"],
    customerSafeOutcome:
      "Signed-in sellers see a masked payout row only from current Settlement readiness and must still explicitly confirm.",
  }),
  affordancePolicy({
    affordance: "seller-payout-setup-recovery",
    docLabel: "Seller payout setup recovery",
    ownerIssues: ["#1113", "#1121", "#1122", "#1134"],
    mode: "sell",
    actorModes: ["guest", "signed-in"],
    sourceOwner: "Settlement",
    capabilityStatus: "provider-unavailable",
    checkpoints: ["seller-readiness", "checkout-render", "final-confirmation"],
    requiredFacts: ["readiness-snapshot-current", "seller-readiness-current", "payout-readiness-current"],
    fallbackAction: "Return to Sell List readiness or support-safe recovery when payout setup is unavailable.",
    sideEffectBoundary: "none-before-final-confirmation",
    explicitFinalConfirmationRequired: true,
    redactedSensitiveFields: checkoutPaymentPayoutSensitiveFields,
    supportReferenceRequired: true,
    copySurface: "provider-return-recovery",
    visualTarget: "risk-hold-provider-return-failure",
    scenarioStates: ["provider-outage", "blocked"],
    customerSafeOutcome:
      "Payout setup failures block seller confirmation without exposing bank data or pretending sale/payout work completed.",
  }),
] as const satisfies readonly CheckoutPaymentPayoutAffordancePolicyEntry[];

export const checkoutPaymentPayoutRequiredAffordances = [
  "guest-card-payment-form",
  "signed-in-saved-payment-row",
  "accelerated-saved-payment-confirmation",
  "guest-saved-payment-block",
  "provider-return-review",
  "seller-payout-setup-handoff",
  "signed-in-saved-payout-row",
  "seller-payout-setup-recovery",
] as const satisfies readonly CheckoutPaymentPayoutAffordanceKey[];

export function assertCheckoutPaymentPayoutAffordancePolicyCoverage(): void {
  const byAffordance = new Map(checkoutPaymentPayoutAffordancePolicyEntries.map((entry) => [entry.affordance, entry]));

  for (const affordance of checkoutPaymentPayoutRequiredAffordances) {
    if (!byAffordance.has(affordance)) {
      throw new Error(`Missing checkout payment/payout affordance policy for '${affordance}'.`);
    }
  }

  if (byAffordance.size !== checkoutPaymentPayoutAffordancePolicyEntries.length) {
    throw new Error("Checkout payment/payout affordance policy entries must be unique.");
  }

  for (const entry of checkoutPaymentPayoutAffordancePolicyEntries) {
    if (!entry.ownerIssues.includes("#1113")) {
      throw new Error(`Checkout payment/payout affordance '${entry.affordance}' must include #1113.`);
    }
    if (!entry.requiredFacts.includes("readiness-snapshot-current")) {
      throw new Error(`Checkout payment/payout affordance '${entry.affordance}' must require readiness.`);
    }
    if (!entry.explicitFinalConfirmationRequired) {
      throw new Error(`Checkout payment/payout affordance '${entry.affordance}' must require final confirmation.`);
    }
    if (entry.redactedSensitiveFields.length !== checkoutPaymentPayoutSensitiveFields.length) {
      throw new Error(
        `Checkout payment/payout affordance '${entry.affordance}' must redact the standard sensitive field set.`,
      );
    }
    for (const sensitiveField of checkoutPaymentPayoutSensitiveFields) {
      if (!entry.redactedSensitiveFields.includes(sensitiveField)) {
        throw new Error(
          `Checkout payment/payout affordance '${entry.affordance}' does not redact '${sensitiveField}'.`,
        );
      }
    }
    if (entry.fallbackAction.trim().length === 0 || entry.customerSafeOutcome.trim().length === 0) {
      throw new Error(`Checkout payment/payout affordance '${entry.affordance}' needs customer-safe text.`);
    }
    if (
      (entry.capabilityStatus === "disabled" ||
        entry.capabilityStatus === "deferred" ||
        entry.capabilityStatus === "setup-required" ||
        entry.capabilityStatus === "provider-unavailable") &&
      !entry.supportReferenceRequired
    ) {
      throw new Error(
        `Checkout payment/payout affordance '${entry.affordance}' needs support reference coverage when constrained.`,
      );
    }
    if (
      entry.sideEffectBoundary === "none-before-final-confirmation" &&
      !entry.customerSafeOutcome.match(/\b(fail|block|return|review|without|never)\b/i)
    ) {
      throw new Error(`Checkout payment/payout affordance '${entry.affordance}' needs no-side-effect outcome copy.`);
    }
  }
}

function affordancePolicy(
  input: CheckoutPaymentPayoutAffordancePolicyEntry,
): CheckoutPaymentPayoutAffordancePolicyEntry {
  return input;
}
