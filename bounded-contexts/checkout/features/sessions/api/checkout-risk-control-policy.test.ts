import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertCheckoutRiskControlPolicyCoverage,
  checkoutRiskControlPolicyDocPath,
  checkoutRiskControlPolicyEntries,
  checkoutRiskControlRequiredControls,
  checkoutRiskForbiddenMechanisms,
} from "./checkout-risk-control-policy";

describe("Checkout risk control policy", () => {
  it("passes the executable coverage assertion", () => {
    expect(() => assertCheckoutRiskControlPolicyCoverage()).not.toThrow();
  });

  it("defines every required Milestone 17 risk control once", () => {
    const controls = checkoutRiskControlPolicyEntries.map((entry) => entry.control);

    expect(new Set(controls).size).toBe(controls.length);
    expect(controls).toEqual(expect.arrayContaining([...checkoutRiskControlRequiredControls]));
  });

  it("keeps inventory hoarding and seller readiness controls before checkout", () => {
    const preCheckoutControls = [
      "guest-velocity-and-bot-protection",
      "inventory-hoarding-and-reservation-limits",
      "payout-provider-risk-hold",
      "seller-readiness-and-listing-abuse",
    ];

    for (const control of preCheckoutControls) {
      const entry = checkoutRiskControlPolicyEntries.find((policy) => policy.control === control);

      expect(entry?.staysBeforeCheckout, control).toBe(true);
      expect(entry?.noSideEffectBeforeCommitRequired, control).toBe(true);
    }

    const inventory = checkoutRiskControlPolicyEntries.find(
      (entry) => entry.control === "inventory-hoarding-and-reservation-limits",
    );
    expect(inventory?.customerSafeOutcome).toMatch(/checkout never assigns fulfillment/i);
    expect(inventory?.customerSafeOutcome).toMatch(/unassigned fulfillment/i);
  });

  it("requires blocked, held, challenged, deferred, and provider states to be support-safe", () => {
    const customerImpactingStates = [
      "blocked",
      "held",
      "challenged",
      "disabled",
      "deferred",
      "unsupported",
      "provider-unavailable",
    ];

    const impactedEntries = checkoutRiskControlPolicyEntries.filter((entry) =>
      entry.outcomeStates.some((state) => customerImpactingStates.includes(state)),
    );

    expect(impactedEntries.length).toBeGreaterThan(0);
    for (const entry of impactedEntries) {
      expect(entry.supportReferenceRequired, entry.control).toBe(true);
      expect(entry.observabilityRequired, entry.control).toBe(true);
      expect(entry.redactsSensitiveSignals, entry.control).toBe(true);
      expect(entry.noSideEffectBeforeCommitRequired, entry.control).toBe(true);
    }
  });

  it("forbids every old compatibility and unsafe repair mechanism", () => {
    for (const entry of checkoutRiskControlPolicyEntries) {
      expect(entry.forbiddenMechanisms, entry.control).toEqual(
        expect.arrayContaining([...checkoutRiskForbiddenMechanisms]),
      );
    }
  });

  it("protects final confirmation from risk side effects", () => {
    const finalConfirmationEntries = checkoutRiskControlPolicyEntries.filter((entry) =>
      entry.checkpoints.includes("final-confirmation"),
    );

    expect(finalConfirmationEntries.length).toBeGreaterThan(0);
    for (const entry of finalConfirmationEntries) {
      expect(entry.noSideEffectBeforeCommitRequired, entry.control).toBe(true);
      expect(entry.customerSafeOutcome, entry.control).toMatch(
        /no |cannot|before|block|hold|idempotent|revalidate|stop|never/i,
      );
    }
  });

  it("documents owner rule, observability, and fresh-state requirements", () => {
    const capabilityStatus = checkoutRiskControlPolicyEntries.find(
      (entry) => entry.control === "owner-rule-risk-states",
    );
    const observability = checkoutRiskControlPolicyEntries.find((entry) => entry.control === "observability-redaction");
    const cleanup = checkoutRiskControlPolicyEntries.find((entry) => entry.control === "fresh-state-risk-cleanup");

    expect(capabilityStatus?.ownerRuleRequired).toBe(true);
    expect(capabilityStatus?.customerSafeOutcome).toMatch(/owner, copy, support path, observability/i);
    expect(observability?.customerSafeOutcome).toMatch(/sensitive risk signals/i);
    expect(cleanup?.customerSafeOutcome).toMatch(/old routes, payload adapters/i);
  });

  it("documents the executable risk control policy", () => {
    const doc = readFileSync(new URL("../../../docs/checkout-risk-control-policy.md", import.meta.url), "utf8");
    const checkoutReadme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const docsIndex = readFileSync(new URL("../../../../../docs/README.md", import.meta.url), "utf8");

    expect(checkoutRiskControlPolicyDocPath).toBe("bounded-contexts/checkout/docs/checkout-risk-control-policy.md");
    expect(doc).toContain("Checkout Risk Control Policy");
    expect(doc).toMatch(/Risk, fraud, abuse, inventory-hoarding, and provider-risk states stay simple/i);
    expect(doc).toMatch(
      /The executable contract lives in\s+`bounded-contexts\/checkout\/features\/sessions\/api\/checkout-risk-control-policy\.ts`\./,
    );
    expect(checkoutReadme).toContain("./docs/checkout-risk-control-policy.md");
    expect(docsIndex).toContain("../bounded-contexts/checkout/docs/checkout-risk-control-policy.md");

    for (const entry of checkoutRiskControlPolicyEntries) {
      expect(doc, entry.control).toContain(`| ${entry.docLabel} |`);
    }
  });
});
