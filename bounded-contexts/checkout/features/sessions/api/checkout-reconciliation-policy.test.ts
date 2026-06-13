import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertCheckoutReconciliationPolicyCoverage,
  checkoutReconciliationForbiddenSources,
  checkoutReconciliationPolicyDocPath,
  checkoutReconciliationPolicyEntries,
  checkoutReconciliationRequiredControls,
} from "./checkout-reconciliation-policy";
import type { CheckoutReconciliationEffect } from "./checkout-reconciliation-policy";

describe("Checkout reconciliation policy", () => {
  it("passes the executable coverage assertion", () => {
    expect(() => assertCheckoutReconciliationPolicyCoverage()).not.toThrow();
  });

  it("defines every required Milestone 17 reconciliation control once", () => {
    const controls = checkoutReconciliationPolicyEntries.map((entry) => entry.control);

    expect(new Set(controls).size).toBe(controls.length);
    expect(controls).toEqual(expect.arrayContaining([...checkoutReconciliationRequiredControls]));
  });

  it("keeps unassigned fulfillment and optional optimization outside checkout", () => {
    const unassigned = checkoutReconciliationPolicyEntries.find(
      (entry) => entry.control === "unassigned-fulfillment-readiness-reconciliation",
    );
    const optimization = checkoutReconciliationPolicyEntries.find(
      (entry) => entry.control === "optional-fulfillment-optimization-reconciliation",
    );

    for (const entry of [unassigned, optimization]) {
      expect(entry?.boundary, entry?.control).toBe("before-checkout");
      expect(entry?.checkpoints, entry?.control).toEqual(
        expect.arrayContaining(["cart-list-readiness", "conditional-pre-checkout"]),
      );
      expect(entry?.noSideEffectBeforeCommitRequired, entry?.control).toBe(true);
      expect(entry?.rejectsSyntheticCompletion, entry?.control).toBe(true);
    }

    expect(unassigned?.evidenceExpectation).toMatch(/stay in cart\/list readiness/i);
    expect(unassigned?.evidenceExpectation).toMatch(/must not assign fulfillment/i);
    expect(optimization?.evidenceExpectation).toMatch(/accepted\/declined readiness decision/i);
    expect(optimization?.evidenceExpectation).toMatch(/checkout-time re-optimization/i);
  });

  it("covers payment, order, label, payout, notification, settlement, and account-history facts", () => {
    const requiredEffects = [
      "payment",
      "order",
      "label",
      "payout",
      "notification",
      "settlement",
      "account-history",
    ] as const satisfies readonly CheckoutReconciliationEffect[];

    for (const effect of requiredEffects) {
      expect(
        checkoutReconciliationPolicyEntries.some((entry) => entry.effects.includes(effect)),
        effect,
      ).toBe(true);
    }

    const payment = checkoutReconciliationPolicyEntries.find(
      (entry) => entry.control === "payment-capture-and-fee-reconciliation",
    );
    const order = checkoutReconciliationPolicyEntries.find(
      (entry) => entry.control === "order-creation-and-split-group-reconciliation",
    );
    const label = checkoutReconciliationPolicyEntries.find(
      (entry) => entry.control === "label-and-fulfillment-reconciliation",
    );
    const payout = checkoutReconciliationPolicyEntries.find(
      (entry) => entry.control === "payout-and-settlement-reconciliation",
    );
    const notification = checkoutReconciliationPolicyEntries.find(
      (entry) => entry.control === "notification-delivery-reconciliation",
    );

    expect(payment?.sourceFacts).toEqual(expect.arrayContaining(["payments-payment", "provider-callback"]));
    expect(order?.sourceFacts).toContain("ordering-order");
    expect(label?.sourceFacts).toContain("fulfillment-label");
    expect(payout?.sourceFacts).toContain("settlement-payout-or-hold");
    expect(notification?.sourceFacts).toContain("notification-message");
  });

  it("requires pending downstream states to stay support-safe without synthetic completion", () => {
    const pendingEntries = checkoutReconciliationPolicyEntries.filter((entry) =>
      entry.states.some((state) =>
        ["downstream-not-created-yet", "downstream-pending", "downstream-failed"].includes(state),
      ),
    );

    expect(pendingEntries.length).toBeGreaterThan(0);
    for (const entry of pendingEntries) {
      expect(entry.supportReferenceRequired, entry.control).toBe(true);
      expect(entry.observabilityRequired, entry.control).toBe(true);
      expect(entry.rejectsSyntheticCompletion, entry.control).toBe(true);
      expect(entry.redactsProviderAndPaymentData, entry.control).toBe(true);
    }

    const boundary = checkoutReconciliationPolicyEntries.find(
      (entry) => entry.control === "pending-downstream-boundary",
    );
    expect(boundary?.sourceFacts).not.toEqual(expect.arrayContaining(["ordering-order", "fulfillment-label"]));
    expect(boundary?.evidenceExpectation).toMatch(/cannot synthesize completed downstream facts/i);
  });

  it("makes duplicate submit, retry, provider replay, and operator recovery idempotent", () => {
    const controls = [
      "duplicate-submit-and-retry-idempotency",
      "provider-webhook-replay-reconciliation",
      "operator-recovery-reconciliation",
    ];

    for (const control of controls) {
      const entry = checkoutReconciliationPolicyEntries.find((policy) => policy.control === control);

      expect(entry?.duplicatePreventionRequired, control).toBe(true);
      expect(entry?.idempotencyKeyShape, control).toContain(":");
      expect(entry?.supportReferenceRequired, control).toBe(true);
      expect(entry?.states, control).toEqual(expect.arrayContaining(["recovered"]));
    }

    const replay = checkoutReconciliationPolicyEntries.find(
      (entry) => entry.control === "provider-webhook-replay-reconciliation",
    );
    expect(replay?.states).toContain("duplicate-suppressed");
    expect(replay?.evidenceExpectation).toMatch(/signature-checked/i);
  });

  it("launch-decisions customer-impacting reconciliation states", () => {
    const customerImpactingStates = [
      "downstream-failed",
      "held",
      "deferred",
      "disabled",
      "unsupported",
      "provider-outage",
      "stale-active-session",
    ];
    const impactedEntries = checkoutReconciliationPolicyEntries.filter((entry) =>
      entry.states.some((state) => customerImpactingStates.includes(state)),
    );

    expect(impactedEntries.length).toBeGreaterThan(0);
    for (const entry of impactedEntries) {
      expect(entry.launchDecisionRequired, entry.control).toBe(true);
      expect(entry.supportReferenceRequired, entry.control).toBe(true);
      expect(entry.noSideEffectBeforeCommitRequired, entry.control).toBe(true);
    }

    const launchDecision = checkoutReconciliationPolicyEntries.find(
      (entry) => entry.control === "launch-decision-reconciliation-states",
    );
    expect(launchDecision?.ownerIssues).toEqual(expect.arrayContaining(["#1102", "#1112", "#1114", "#1115"]));
    expect(launchDecision?.evidenceExpectation).toMatch(/disabled, deferred, unsupported, provider-outage/i);
  });

  it("forbids legacy repair, stale data, provider-dashboard fixes, and synthetic completion", () => {
    for (const entry of checkoutReconciliationPolicyEntries) {
      expect(entry.ownerIssues, entry.control).toContain("#1130");
      expect(entry.forbiddenSources, entry.control).toEqual(
        expect.arrayContaining([...checkoutReconciliationForbiddenSources]),
      );
    }

    const cleanup = checkoutReconciliationPolicyEntries.find(
      (entry) => entry.control === "fresh-state-reconciliation-cleanup",
    );
    expect(cleanup?.evidenceExpectation).toMatch(/old receipt fallback reads/i);
    expect(cleanup?.evidenceExpectation).toMatch(/dense checkout fallback/i);
  });

  it("documents the executable reconciliation policy", () => {
    const doc = readFileSync(new URL("../../../docs/checkout-reconciliation-policy.md", import.meta.url), "utf8");
    const checkoutReadme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const docsIndex = readFileSync(new URL("../../../../../docs/README.md", import.meta.url), "utf8");

    expect(checkoutReconciliationPolicyDocPath).toBe(
      "bounded-contexts/checkout/docs/checkout-reconciliation-policy.md",
    );
    expect(doc).toContain("Checkout Reconciliation Policy");
    expect(doc).toMatch(
      /The executable contract lives in\s+`bounded-contexts\/checkout\/features\/sessions\/api\/checkout-reconciliation-policy\.ts`\./,
    );
    expect(doc).toMatch(/Items without fulfillment assignment stay in cart\/list readiness/i);
    expect(checkoutReadme).toContain("./docs/checkout-reconciliation-policy.md");
    expect(docsIndex).toContain("../bounded-contexts/checkout/docs/checkout-reconciliation-policy.md");

    for (const entry of checkoutReconciliationPolicyEntries) {
      expect(doc, entry.control).toContain(`| ${entry.docLabel} |`);
    }
  });
});
