import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertCheckoutCopyPolicyCoverage,
  checkoutCopyAllowedCustomerTerms,
  checkoutCopyForbiddenCustomerTerms,
  checkoutCopyPolicyDocPath,
  checkoutCopyPolicyEntries,
  checkoutCopyRequiredSurfaces,
  type CheckoutCopySurfaceKey,
} from "./checkout-copy-policy";

describe("Checkout copy policy", () => {
  it("passes the executable coverage assertion", () => {
    expect(() => assertCheckoutCopyPolicyCoverage()).not.toThrow();
  });

  it("defines every required Milestone 17 copy surface once", () => {
    const surfaces = checkoutCopyPolicyEntries.map((entry) => entry.surface);

    expect(new Set(surfaces).size).toBe(surfaces.length);
    expect(surfaces).toEqual(expect.arrayContaining([...checkoutCopyRequiredSurfaces]));
  });

  it("keeps Smart Match customer-facing while banning internal implementation terms", () => {
    expect(checkoutCopyAllowedCustomerTerms).toContain("Smart Match");
    expect(checkoutCopyForbiddenCustomerTerms).not.toContain("Smart Match");

    for (const entry of checkoutCopyPolicyEntries.filter((policyEntry) => policyEntry.customerVisible)) {
      const customerText = [entry.primaryAction, entry.nextAction, ...entry.examples]
        .join(" ")
        .toLocaleLowerCase("en-US");

      for (const forbiddenTerm of entry.forbiddenCustomerTerms) {
        expect(customerText, `${entry.surface} should not expose ${forbiddenTerm}`).not.toContain(
          forbiddenTerm.toLocaleLowerCase("en-US"),
        );
      }
    }
  });

  it("keeps unresolved fulfillment and savings optimization before checkout", () => {
    const readinessSurfaces = new Set<CheckoutCopySurfaceKey>([
      "readiness-unassigned-fulfillment",
      "readiness-optimization-offer",
      "readiness-blocked-or-unavailable",
    ]);

    for (const entry of checkoutCopyPolicyEntries.filter((policyEntry) => readinessSurfaces.has(policyEntry.surface))) {
      expect(entry.kind, entry.surface).toBe("cart-list-readiness");
      expect(entry.primaryAction.length, entry.surface).toBeGreaterThan(0);
      expect(entry.noSideEffectStatementRequired, entry.surface).toBe(true);
    }

    expect(
      checkoutCopyPolicyEntries.find((entry) => entry.surface === "readiness-optimization-offer")?.examples,
    ).toEqual(expect.arrayContaining(["Save $X with a different shipping plan.", "Keep current plan."]));
  });

  it("requires no-side-effect copy for recovery and disabled-capability states", () => {
    const noSideEffectSurfaces = [
      "checkout-temporary-recovery",
      "checkout-permanent-recovery",
      "active-session-stale-recovery",
      "accelerated-saved-instrument-fallback",
      "provider-return-recovery",
      "risk-hold-or-block",
      "kill-switch-disabled-checkout",
    ] as const satisfies readonly CheckoutCopySurfaceKey[];

    for (const surface of noSideEffectSurfaces) {
      const entry = checkoutCopyPolicyEntries.find((policyEntry) => policyEntry.surface === surface);

      expect(entry?.noSideEffectStatementRequired, surface).toBe(true);
      expect(entry?.capabilityStates, surface).toContain("no-side-effect");
      expect(entry?.examples.join(" "), surface).toMatch(/No .* (started|has started)\./);
    }
  });

  it("protects pending seller activity from implying committed downstream facts", () => {
    const sellerPending = checkoutCopyPolicyEntries.find((entry) => entry.surface === "seller-pending-activity");

    expect(sellerPending?.pendingDownstreamBoundaryRequired).toBe(true);
    expect(sellerPending?.examples.join(" ")).toContain("Sale details are pending.");
    expect(sellerPending?.forbiddenCustomerTerms).toEqual(
      expect.arrayContaining([
        "sale complete",
        "label ready",
        "payout ready",
        "settlement complete",
        "notification sent",
        "fulfillment complete",
      ]),
    );
  });

  it("requires support-safe references without sensitive fields where support can see the state", () => {
    const supportSurfaces = checkoutCopyPolicyEntries.filter((entry) => entry.supportReference.required);

    expect(supportSurfaces.length).toBeGreaterThan(12);

    for (const entry of supportSurfaces) {
      expect(entry.supportReference.safeFields, entry.surface).toContain("support-safe reference");
      expect(entry.supportReference.forbiddenFields, entry.surface).toEqual(
        expect.arrayContaining(["provider payloads", "email addresses", "full URLs", "risk signals"]),
      );
    }
  });

  it("documents the executable copy policy contract", () => {
    const doc = readFileSync(new URL("../../../docs/checkout-copy-policy.md", import.meta.url), "utf8");
    const checkoutReadme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const docsIndex = readFileSync(new URL("../../../../../docs/README.md", import.meta.url), "utf8");

    expect(checkoutCopyPolicyDocPath).toBe("bounded-contexts/checkout/docs/checkout-copy-policy.md");
    expect(doc).toContain("Checkout Copy Policy");
    expect(doc).toContain("Smart Match remains approved customer-facing language");
    expect(doc).toContain("Items that are not ready stay in Buy Cart or Sell List readiness");
    expect(doc).toContain(
      "No payment, order, label, payout, settlement, notification, account-history, or support side effect",
    );
    expect(doc).toContain(
      "The executable contract lives in `bounded-contexts/checkout/features/sessions/api/checkout-copy-policy.ts`.",
    );
    expect(checkoutReadme).toContain("./docs/checkout-copy-policy.md");
    expect(docsIndex).toContain("../bounded-contexts/checkout/docs/checkout-copy-policy.md");

    for (const entry of checkoutCopyPolicyEntries) {
      expect(doc, entry.surface).toContain(`| ${entry.docLabel} |`);
    }
  });
});
