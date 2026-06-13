import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertCheckoutAddressServiceabilityPolicyCoverage,
  checkoutAddressForbiddenMechanisms,
  checkoutAddressRequiredControls,
  checkoutAddressServiceabilityPolicyDocPath,
  checkoutAddressServiceabilityPolicyEntries,
} from "./checkout-address-serviceability-policy";

describe("Checkout address serviceability policy", () => {
  it("passes the executable coverage assertion", () => {
    expect(() => assertCheckoutAddressServiceabilityPolicyCoverage()).not.toThrow();
  });

  it("defines every required Milestone 17 address and serviceability control once", () => {
    const controls = checkoutAddressServiceabilityPolicyEntries.map((entry) => entry.control);

    expect(new Set(controls).size).toBe(controls.length);
    expect(controls).toEqual(expect.arrayContaining([...checkoutAddressRequiredControls]));
  });

  it("keeps seller ship-from and split-group promise failures before checkout", () => {
    const preCheckoutControls = ["seller-ship-from-address-validation", "split-group-shipping-promise"];

    for (const control of preCheckoutControls) {
      const entry = checkoutAddressServiceabilityPolicyEntries.find((policy) => policy.control === control);

      expect(entry?.staysBeforeCheckout, control).toBe(true);
      expect(entry?.surface, control).toBe("cart-list-readiness");
      expect(entry?.noSideEffectBeforeCommitRequired, control).toBe(true);
    }

    const sellerShipFrom = checkoutAddressServiceabilityPolicyEntries.find(
      (entry) => entry.control === "seller-ship-from-address-validation",
    );
    expect(sellerShipFrom?.customerSafeOutcome).toMatch(/cannot confirm label, payout/i);
  });

  it("requires address normalization records before shipping, tax, payout, label, split-group, or risk quote work", () => {
    const quoteGatedEntries = checkoutAddressServiceabilityPolicyEntries.filter((entry) =>
      entry.quoteDependencies.some((dependency) => dependency !== "none"),
    );

    expect(quoteGatedEntries.length).toBeGreaterThan(0);
    for (const entry of quoteGatedEntries) {
      expect(entry.normalizationRecordRequired, entry.control).toBe(true);
      expect(entry.serviceabilityDecisionRequired, entry.control).toBe(true);
      expect(entry.freshnessKeyShape, entry.control).toContain(":");
    }
  });

  it("requires customer-impacting address failures to have owner rules and support-safe recovery", () => {
    const customerImpactingStates = [
      "restricted",
      "unserviceable",
      "quote-unavailable",
      "provider-outage",
      "stale",
      "disabled",
      "deferred",
      "unsupported",
    ];
    const impactedEntries = checkoutAddressServiceabilityPolicyEntries.filter((entry) =>
      entry.outcomes.some((state) => customerImpactingStates.includes(state)),
    );

    expect(impactedEntries.length).toBeGreaterThan(0);
    for (const entry of impactedEntries) {
      expect(entry.ownerRuleRequired, entry.control).toBe(true);
      expect(entry.supportReferenceRequired, entry.control).toBe(true);
      expect(entry.noSideEffectBeforeCommitRequired, entry.control).toBe(true);
      expect(entry.redactsSensitiveAddressData, entry.control).toBe(true);
    }
  });

  it("documents saved address invalidation and active session revalidation", () => {
    const savedAddress = checkoutAddressServiceabilityPolicyEntries.find(
      (entry) => entry.control === "saved-address-invalidation",
    );
    const activeSession = checkoutAddressServiceabilityPolicyEntries.find(
      (entry) => entry.control === "active-session-address-revalidation",
    );

    expect(savedAddress?.checkpoints).toEqual(expect.arrayContaining(["saved-row-edit", "account-update"]));
    expect(savedAddress?.customerSafeOutcome).toMatch(/editable rows and invalidate dependent quotes/i);
    expect(activeSession?.checkpoints).toEqual(
      expect.arrayContaining(["active-session-return", "duplicate-submit", "final-confirmation"]),
    );
    expect(activeSession?.customerSafeOutcome).toMatch(/before any customer-committing side effect starts/i);
  });

  it("forbids hidden repair, old payload, stale model, and dense checkout fallback mechanisms", () => {
    for (const entry of checkoutAddressServiceabilityPolicyEntries) {
      expect(entry.forbiddenMechanisms, entry.control).toEqual(
        expect.arrayContaining([...checkoutAddressForbiddenMechanisms]),
      );
    }
  });

  it("protects final confirmation from address side effects", () => {
    const finalConfirmationEntries = checkoutAddressServiceabilityPolicyEntries.filter((entry) =>
      entry.checkpoints.includes("final-confirmation"),
    );

    expect(finalConfirmationEntries.length).toBeGreaterThan(0);
    for (const entry of finalConfirmationEntries) {
      expect(entry.noSideEffectBeforeCommitRequired, entry.control).toBe(true);
      expect(entry.customerSafeOutcome.trim().length, entry.control).toBeGreaterThan(0);
    }

    const noSideEffect = checkoutAddressServiceabilityPolicyEntries.find(
      (entry) => entry.control === "no-side-effect-address-blocks",
    );
    expect(noSideEffect?.customerSafeOutcome).toMatch(/no payment, order, sale, label, payout/i);
    expect(noSideEffect?.customerSafeOutcome).toMatch(/refund, void, or reversal/i);
  });

  it("keeps support enabled and fresh-state address cleanup internal-only", () => {
    const support = checkoutAddressServiceabilityPolicyEntries.find(
      (entry) => entry.control === "support-safe-address-failure",
    );
    const cleanup = checkoutAddressServiceabilityPolicyEntries.find(
      (entry) => entry.control === "fresh-state-address-cleanup",
    );

    expect(support?.surface).toBe("support-runbook");
    expect(support?.capabilityStatus).toBe("enabled");
    expect(cleanup?.surface).toBe("operations-status");
    expect(cleanup?.capabilityStatus).toBe("internal-only");
    expect(cleanup?.normalizationRecordRequired).toBe(false);
  });

  it("documents the executable address serviceability policy", () => {
    const doc = readFileSync(
      new URL("../../../docs/checkout-address-serviceability-policy.md", import.meta.url),
      "utf8",
    );
    const checkoutReadme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const docsIndex = readFileSync(new URL("../../../../../docs/README.md", import.meta.url), "utf8");

    expect(checkoutAddressServiceabilityPolicyDocPath).toBe(
      "bounded-contexts/checkout/docs/checkout-address-serviceability-policy.md",
    );
    expect(doc).toContain("Checkout Address And Serviceability Policy");
    expect(doc).toMatch(
      /The executable contract lives in\s+`bounded-contexts\/checkout\/features\/sessions\/api\/checkout-address-serviceability-policy\.ts`\./,
    );
    expect(doc).toMatch(/Shipping, tax, payout, label, split-group, and risk provider calls run only after/i);
    expect(checkoutReadme).toContain("./docs/checkout-address-serviceability-policy.md");
    expect(docsIndex).toContain("../bounded-contexts/checkout/docs/checkout-address-serviceability-policy.md");

    for (const entry of checkoutAddressServiceabilityPolicyEntries) {
      expect(doc, entry.control).toContain(`| ${entry.docLabel} |`);
    }
  });
});
