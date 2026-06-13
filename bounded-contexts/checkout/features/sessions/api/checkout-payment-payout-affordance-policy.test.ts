import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checkoutCopyPolicyEntries } from "./checkout-copy-policy";
import { checkoutObservabilityProfiles } from "./checkout-observability-contract";
import {
  assertCheckoutPaymentPayoutAffordancePolicyCoverage,
  checkoutPaymentPayoutAffordancePolicyDocPath,
  checkoutPaymentPayoutAffordancePolicyEntries,
  checkoutPaymentPayoutRequiredAffordances,
  checkoutPaymentPayoutSensitiveFields,
} from "./checkout-payment-payout-affordance-policy";
import { checkoutVisualTargets } from "./checkout-visual-targets";

describe("Checkout payment and payout affordance policy", () => {
  it("passes the executable coverage assertion", () => {
    expect(() => assertCheckoutPaymentPayoutAffordancePolicyCoverage()).not.toThrow();
  });

  it("defines every required Milestone 17 payment and payout affordance once", () => {
    const affordances = checkoutPaymentPayoutAffordancePolicyEntries.map((entry) => entry.affordance);

    expect(new Set(affordances).size).toBe(affordances.length);
    expect(affordances).toEqual(expect.arrayContaining([...checkoutPaymentPayoutRequiredAffordances]));
  });

  it("requires readiness, explicit final confirmation, and sensitive-field redaction for every shortcut", () => {
    for (const entry of checkoutPaymentPayoutAffordancePolicyEntries) {
      expect(entry.ownerIssues, entry.affordance).toContain("#1113");
      expect(entry.requiredFacts, entry.affordance).toContain("readiness-snapshot-current");
      expect(entry.explicitFinalConfirmationRequired, entry.affordance).toBe(true);
      expect(entry.redactedSensitiveFields, entry.affordance).toEqual([...checkoutPaymentPayoutSensitiveFields]);
    }
  });

  it("keeps disabled, setup-required, and provider-unavailable affordances support-safe", () => {
    const constrained = checkoutPaymentPayoutAffordancePolicyEntries.filter((entry) =>
      ["disabled", "deferred", "setup-required", "provider-unavailable"].includes(entry.capabilityStatus),
    );

    expect(constrained.length).toBeGreaterThan(0);
    for (const entry of constrained) {
      expect(entry.supportReferenceRequired, entry.affordance).toBe(true);
      expect(entry.sideEffectBoundary, entry.affordance).not.toBe("final-confirmation-only");
      expect(entry.customerSafeOutcome, entry.affordance).toMatch(/fail|block|return|cannot|without|never/i);
    }
  });

  it("maps every affordance to existing copy, visual, and observability surfaces", () => {
    const copySurfaces = new Set(checkoutCopyPolicyEntries.map((entry) => entry.surface));
    const visualTargets = new Set(checkoutVisualTargets.map((target) => target.surface));
    const observabilityStates = new Set(checkoutObservabilityProfiles.map((profile) => profile.state));

    for (const entry of checkoutPaymentPayoutAffordancePolicyEntries) {
      expect(copySurfaces.has(entry.copySurface), entry.affordance).toBe(true);
      expect(visualTargets.has(entry.visualTarget), entry.affordance).toBe(true);
      expect(observabilityStates.has(entry.visualTarget), entry.affordance).toBe(true);
    }
  });

  it("keeps guest saved-payment attempts blocked before checkout side effects", () => {
    const guestSavedPaymentBlock = checkoutPaymentPayoutAffordancePolicyEntries.find(
      (entry) => entry.affordance === "guest-saved-payment-block",
    );

    expect(guestSavedPaymentBlock).toMatchObject({
      actorModes: ["guest"],
      capabilityStatus: "disabled",
      sideEffectBoundary: "none-before-final-confirmation",
      copySurface: "accelerated-saved-instrument-fallback",
      visualTarget: "disabled-accelerated-saved-instrument",
    });
    expect(guestSavedPaymentBlock?.customerSafeOutcome).toMatch(/fail before checkout mutations/i);
  });

  it("keeps seller payout setup owned by Settlement and outside Checkout-only commitment", () => {
    const payoutSetup = checkoutPaymentPayoutAffordancePolicyEntries.find(
      (entry) => entry.affordance === "seller-payout-setup-handoff",
    );
    const savedPayout = checkoutPaymentPayoutAffordancePolicyEntries.find(
      (entry) => entry.affordance === "signed-in-saved-payout-row",
    );

    expect(payoutSetup?.sourceOwner).toBe("Settlement");
    expect(payoutSetup?.sideEffectBoundary).toBe("owner-managed-handoff-only");
    expect(payoutSetup?.requiredFacts).toEqual(
      expect.arrayContaining(["readiness-snapshot-current", "seller-readiness-current"]),
    );
    expect(savedPayout?.requiredFacts).toEqual(
      expect.arrayContaining(["payout-readiness-current", "seller-readiness-current", "provider-ready"]),
    );
  });

  it("documents the executable payment and payout affordance policy", () => {
    const doc = readFileSync(
      new URL("../../../docs/checkout-payment-payout-affordance-policy.md", import.meta.url),
      "utf8",
    );
    const checkoutReadme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const docsIndex = readFileSync(new URL("../../../../../docs/README.md", import.meta.url), "utf8");

    expect(checkoutPaymentPayoutAffordancePolicyDocPath).toBe(
      "bounded-contexts/checkout/docs/checkout-payment-payout-affordance-policy.md",
    );
    expect(doc).toContain("Checkout Payment And Payout Affordance Policy");
    expect(doc).toContain("Convenience affordances never skip readiness or final confirmation.");
    expect(doc).toMatch(
      /The executable contract\s+lives in\s+`bounded-contexts\/checkout\/features\/sessions\/api\/checkout-payment-payout-affordance-policy\.ts`\./,
    );
    expect(checkoutReadme).toContain("./docs/checkout-payment-payout-affordance-policy.md");
    expect(docsIndex).toContain("../bounded-contexts/checkout/docs/checkout-payment-payout-affordance-policy.md");

    for (const entry of checkoutPaymentPayoutAffordancePolicyEntries) {
      expect(doc, entry.affordance).toContain(`| ${entry.docLabel} |`);
    }
  });
});
