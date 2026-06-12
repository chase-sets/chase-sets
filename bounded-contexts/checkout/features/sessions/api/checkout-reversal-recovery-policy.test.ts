import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertCheckoutReversalRecoveryPolicyCoverage,
  checkoutReversalForbiddenSources,
  checkoutReversalRecoveryPolicyDocPath,
  checkoutReversalPolicyEntries,
  checkoutReversalRequiredControls,
} from "./checkout-reversal-recovery-policy";
import type { CheckoutReversalEffect } from "./checkout-reversal-recovery-policy";

describe("Checkout reversal recovery policy", () => {
  it("passes the executable coverage assertion", () => {
    expect(() => assertCheckoutReversalRecoveryPolicyCoverage()).not.toThrow();
  });

  it("defines every required Milestone 17 reversal control once", () => {
    const controls = checkoutReversalPolicyEntries.map((entry) => entry.control);

    expect(new Set(controls).size).toBe(controls.length);
    expect(controls).toEqual(expect.arrayContaining([...checkoutReversalRequiredControls]));
  });

  it("classifies launch reversal effects across buy, sell, support, and provider paths", () => {
    const requiredEffects = [
      "payment-void",
      "payment-refund",
      "order-cancel",
      "inventory-release",
      "label-cancel",
      "label-refund",
      "payout-hold",
      "payout-reversal",
      "settlement-adjustment",
      "tax-fee-credit-adjustment",
      "notification-correction",
      "account-history-correction",
      "dispute-hold",
    ] as const satisfies readonly CheckoutReversalEffect[];

    for (const effect of requiredEffects) {
      expect(
        checkoutReversalPolicyEntries.some((entry) => entry.effects.includes(effect)),
        effect,
      ).toBe(true);
    }

    const exceptionPosture = checkoutReversalPolicyEntries.find(
      (entry) => entry.control === "return-dispute-chargeback-launch-posture",
    );
    expect(exceptionPosture?.states).toEqual(expect.arrayContaining(["support-only", "disabled", "deferred"]));
    expect(exceptionPosture?.launchRegisterRequired).toBe(true);
    expect(exceptionPosture?.evidenceExpectation).toMatch(/supported, disabled, or deferred/i);
  });

  it("separates no-side-effect pre-confirmation cancellation from owner reversals", () => {
    const preConfirmation = checkoutReversalPolicyEntries.find(
      (entry) => entry.control === "pre-confirmation-cancel-no-side-effect",
    );
    const voidAfterFailure = checkoutReversalPolicyEntries.find(
      (entry) => entry.control === "payment-authorization-void-after-order-failure",
    );
    const refundAfterFailure = checkoutReversalPolicyEntries.find(
      (entry) => entry.control === "captured-payment-refund-after-commit-failure",
    );

    expect(preConfirmation?.effects).toEqual(["no-side-effect"]);
    expect(preConfirmation?.owningFactRequiredBeforeAction).toBe(false);
    expect(preConfirmation?.evidenceExpectation).toMatch(/no payment, order, label, payout/i);

    expect(voidAfterFailure?.sourceFacts).toEqual(expect.arrayContaining(["payments-authorization", "payments-void"]));
    expect(voidAfterFailure?.owningFactRequiredBeforeAction).toBe(true);
    expect(refundAfterFailure?.sourceFacts).toEqual(expect.arrayContaining(["payments-capture", "payments-refund"]));
    expect(refundAfterFailure?.states).toEqual(expect.arrayContaining(["partial", "webhook-delayed"]));
  });

  it("honors the buyer cancellation cutoff and support fallback", () => {
    const selfService = checkoutReversalPolicyEntries.find(
      (entry) => entry.control === "self-service-buy-cancellation-window",
    );
    const supportFallback = checkoutReversalPolicyEntries.find(
      (entry) => entry.control === "post-cutoff-support-cancel-request",
    );
    const inventoryRelease = checkoutReversalPolicyEntries.find(
      (entry) => entry.control === "inventory-reservation-release",
    );

    expect(selfService?.ownerContext).toBe("Ordering");
    expect(selfService?.sourceFacts).toEqual(
      expect.arrayContaining(["ordering-order", "ordering-cancellation", "fulfillment-shipment"]),
    );
    expect(supportFallback?.ownerContext).toBe("Support");
    expect(supportFallback?.states).toEqual(expect.arrayContaining(["support-only", "held"]));
    expect(inventoryRelease?.effects).toContain("inventory-release");
    expect(inventoryRelease?.idempotencyKeyShape).toContain("order-or-group-id");
  });

  it("prevents seller pending handoff from creating fake reversals", () => {
    const pendingSeller = checkoutReversalPolicyEntries.find(
      (entry) => entry.control === "seller-pending-handoff-no-fake-reversal",
    );

    expect(pendingSeller?.ownerContext).toBe("Checkout");
    expect(pendingSeller?.effects).toEqual(expect.arrayContaining(["support-review", "no-side-effect"]));
    expect(pendingSeller?.owningFactRequiredBeforeAction).toBe(false);
    expect(pendingSeller?.sourceFacts).not.toEqual(
      expect.arrayContaining(["fulfillment-label", "settlement-payout", "payments-refund"]),
    );
    expect(pendingSeller?.evidenceExpectation).toMatch(/must not create fake label, payout, settlement/i);
  });

  it("requires label, payout, settlement, and notification correction to start from owner facts", () => {
    const controls = [
      "label-cancellation-and-refund",
      "payout-hold-and-reversal",
      "settlement-reversal-and-wallet-adjustment",
      "notification-and-account-history-correction",
    ];

    for (const control of controls) {
      const entry = checkoutReversalPolicyEntries.find((policy) => policy.control === control);

      expect(entry?.owningFactRequiredBeforeAction, control).toBe(true);
      expect(entry?.duplicatePreventionRequired, control).toBe(true);
      expect(entry?.supportReferenceRequired, control).toBe(true);
    }

    expect(
      checkoutReversalPolicyEntries.find((entry) => entry.control === "label-cancellation-and-refund")?.sourceFacts,
    ).toEqual(expect.arrayContaining(["fulfillment-label", "fulfillment-label-refund"]));
    expect(
      checkoutReversalPolicyEntries.find((entry) => entry.control === "payout-hold-and-reversal")?.sourceFacts,
    ).toEqual(expect.arrayContaining(["settlement-hold", "settlement-payout", "settlement-reversal"]));
  });

  it("makes duplicate reversal, provider replay, and operator recovery idempotent and audited", () => {
    const controls = [
      "duplicate-reversal-prevention",
      "provider-replay-and-webhook-reconciliation",
      "support-approved-operator-recovery",
    ];

    for (const control of controls) {
      const entry = checkoutReversalPolicyEntries.find((policy) => policy.control === control);

      expect(entry?.idempotencyKeyShape, control).toContain(":");
      expect(entry?.duplicatePreventionRequired, control).toBe(true);
      expect(entry?.auditRequired, control).toBe(true);
      expect(entry?.observabilityRequired, control).toBe(true);
      expect(entry?.redactsSensitiveData, control).toBe(true);
    }

    const providerReplay = checkoutReversalPolicyEntries.find(
      (entry) => entry.control === "provider-replay-and-webhook-reconciliation",
    );
    expect(providerReplay?.sourceFacts).toContain("provider-callback");
    expect(providerReplay?.evidenceExpectation).toMatch(/signature-checked/i);
  });

  it("launch-registers customer-impacting reversal states", () => {
    const customerImpactingStates = [
      "support-only",
      "disabled",
      "deferred",
      "unsupported",
      "provider-outage",
      "webhook-delayed",
      "failed",
      "held",
      "partial",
    ];
    const impactedEntries = checkoutReversalPolicyEntries.filter((entry) =>
      entry.states.some((state) => customerImpactingStates.includes(state)),
    );

    expect(impactedEntries.length).toBeGreaterThan(0);
    for (const entry of impactedEntries) {
      expect(entry.launchRegisterRequired, entry.control).toBe(true);
      expect(entry.supportReferenceRequired, entry.control).toBe(true);
    }

    const launchRegister = checkoutReversalPolicyEntries.find(
      (entry) => entry.control === "launch-register-reversal-states",
    );
    expect(launchRegister?.ownerIssues).toEqual(expect.arrayContaining(["#1102", "#1112", "#1114", "#1115"]));
    expect(launchRegister?.evidenceExpectation).toMatch(/#1116 launch-register coverage/i);
  });

  it("forbids legacy repair, stale data, dashboard-only recovery, and dense checkout fallback", () => {
    for (const entry of checkoutReversalPolicyEntries) {
      expect(entry.ownerIssues, entry.control).toContain("#1165");
      expect(entry.noLegacyCompatibility, entry.control).toBe(true);
      expect(entry.forbiddenSources, entry.control).toEqual(
        expect.arrayContaining([...checkoutReversalForbiddenSources]),
      );
    }

    const cleanup = checkoutReversalPolicyEntries.find((entry) => entry.control === "fresh-state-reversal-cleanup");
    expect(cleanup?.evidenceExpectation).toMatch(/old sell execution ids/i);
    expect(cleanup?.evidenceExpectation).toMatch(/dense checkout fallback/i);
  });

  it("documents the executable reversal recovery policy", () => {
    const doc = readFileSync(new URL("../../../docs/checkout-reversal-recovery-policy.md", import.meta.url), "utf8");
    const checkoutReadme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const docsIndex = readFileSync(new URL("../../../../../docs/README.md", import.meta.url), "utf8");

    expect(checkoutReversalRecoveryPolicyDocPath).toBe(
      "bounded-contexts/checkout/docs/checkout-reversal-recovery-policy.md",
    );
    expect(doc).toContain("Checkout Reversal Recovery Policy");
    expect(doc).toMatch(
      /The executable contract lives in\s+`bounded-contexts\/checkout\/features\/sessions\/api\/checkout-reversal-recovery-policy\.ts`\./,
    );
    expect(doc).toMatch(/must\s+not void, refund, cancel, reverse, adjust, hold, notify, or correct/i);
    expect(checkoutReadme).toContain("./docs/checkout-reversal-recovery-policy.md");
    expect(docsIndex).toContain("../bounded-contexts/checkout/docs/checkout-reversal-recovery-policy.md");

    for (const entry of checkoutReversalPolicyEntries) {
      expect(doc, entry.control).toContain(`| ${entry.docLabel} |`);
    }
  });
});
