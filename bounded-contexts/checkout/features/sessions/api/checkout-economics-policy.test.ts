import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertCheckoutEconomicsPolicyCoverage,
  checkoutBuyPayableTotalOrder,
  checkoutEconomicsForbiddenMechanisms,
  checkoutEconomicsPolicyDocPath,
  checkoutEconomicsPolicyEntries,
  checkoutEconomicsRequiredControls,
  checkoutSellerPayoutEstimateOrder,
} from "./checkout-economics-policy";

describe("Checkout economics policy", () => {
  it("passes the executable coverage assertion", () => {
    expect(() => assertCheckoutEconomicsPolicyCoverage()).not.toThrow();
  });

  it("defines every required Milestone 17 economics control once", () => {
    const controls = checkoutEconomicsPolicyEntries.map((entry) => entry.control);

    expect(new Set(controls).size).toBe(controls.length);
    expect(controls).toEqual(expect.arrayContaining([...checkoutEconomicsRequiredControls]));
  });

  it("pins deterministic buy payable and seller payout ordering", () => {
    const buyTotal = checkoutEconomicsPolicyEntries.find((entry) => entry.control === "buy-payable-total-ordering");
    const sellerPayout = checkoutEconomicsPolicyEntries.find(
      (entry) => entry.control === "seller-payout-estimate-ordering",
    );

    expect(checkoutBuyPayableTotalOrder).toEqual([
      "item-subtotal",
      "shipping",
      "tax",
      "marketplace-checkout-fee",
      "discount",
      "promo",
      "gift-card",
      "wallet-credit",
      "payable-total",
    ]);
    expect(checkoutSellerPayoutEstimateOrder).toEqual([
      "item-subtotal",
      "shipping",
      "marketplace-sales-fee",
      "seller-fee-adjustment",
      "label-cost",
      "seller-payout",
    ]);
    expect(buyTotal?.deterministicOrder).toEqual(checkoutBuyPayableTotalOrder);
    expect(sellerPayout?.deterministicOrder).toEqual(checkoutSellerPayoutEstimateOrder);
  });

  it("keeps promo and gift-card customer input outside checkout until owner rules exist", () => {
    const promo = checkoutEconomicsPolicyEntries.find((entry) => entry.control === "promo-code-capability-status");
    const giftCard = checkoutEconomicsPolicyEntries.find(
      (entry) => entry.control === "gift-card-store-credit-capability-status",
    );

    for (const entry of [promo, giftCard]) {
      expect(entry?.capabilityStatus, entry?.control).toBe("owner-rule-required");
      expect(entry?.customerInputAllowed, entry?.control).toBe(false);
      expect(entry?.ownerRuleRequired, entry?.control).toBe(true);
      expect(entry?.noSideEffectBeforeCommitRequired, entry?.control).toBe(true);
    }
    expect(promo?.customerSafeOutcome).toMatch(/stay out of checkout/i);
    expect(giftCard?.customerSafeOutcome).toMatch(/stay disabled until Payments owns/i);
  });

  it("requires wallet credit and marketplace checkout fee freshness before payment", () => {
    const walletCredit = checkoutEconomicsPolicyEntries.find(
      (entry) => entry.control === "buyer-wallet-credit-application",
    );
    const checkoutFee = checkoutEconomicsPolicyEntries.find(
      (entry) => entry.control === "marketplace-checkout-fee-quote",
    );

    expect(walletCredit?.ownerContext).toBe("Settlement");
    expect(walletCredit?.amountComponents).toEqual(expect.arrayContaining(["wallet-credit", "payable-total"]));
    expect(walletCredit?.finalConfirmationRevalidationRequired).toBe(true);
    expect(checkoutFee?.ownerContext).toBe("Payments");
    expect(checkoutFee?.freshnessKeyShape).toContain("fee-quote-fingerprint");
    expect(checkoutFee?.customerSafeOutcome).toMatch(/rejected when the fee quote fingerprint is stale/i);
  });

  it("keeps optional fulfillment savings and seller fee choices before checkout repair", () => {
    const readinessOnlyControls = [
      "optional-fulfillment-optimization-savings",
      "seller-sales-fee-snapshot",
      "seller-fee-adjustment-payout-deduction",
    ];

    for (const control of readinessOnlyControls) {
      const entry = checkoutEconomicsPolicyEntries.find((policy) => policy.control === control);

      expect(entry?.readinessOnlyDecision, control).toBe(true);
      expect(entry?.snapshotRequired, control).toBe(true);
      expect(entry?.finalConfirmationRevalidationRequired, control).toBe(true);
    }

    const optimization = checkoutEconomicsPolicyEntries.find(
      (entry) => entry.control === "optional-fulfillment-optimization-savings",
    );
    expect(optimization?.customerSafeOutcome).toMatch(/without rerunning optimization/i);
    expect(optimization?.customerSafeOutcome).toMatch(/allocation machinery/i);
  });

  it("requires changed economics to recover with no side effects", () => {
    const changed = checkoutEconomicsPolicyEntries.find(
      (entry) => entry.control === "changed-economics-no-side-effect-recovery",
    );

    expect(changed?.noSideEffectBeforeCommitRequired).toBe(true);
    expect(changed?.ownerRuleRequired).toBe(true);
    expect(changed?.supportReferenceRequired).toBe(true);
    expect(changed?.customerSafeOutcome).toMatch(/no payment, order, sale, label, payout/i);
    expect(changed?.customerSafeOutcome).toMatch(/refund, void, or reversal/i);
  });

  it("forbids old helpers and hidden economics repair mechanisms", () => {
    for (const entry of checkoutEconomicsPolicyEntries) {
      expect(entry.forbiddenMechanisms, entry.control).toEqual(
        expect.arrayContaining([...checkoutEconomicsForbiddenMechanisms]),
      );
    }
  });

  it("documents capability status, support, and reversal economics coverage", () => {
    const reversal = checkoutEconomicsPolicyEntries.find((entry) => entry.control === "reversal-economics-linkage");
    const support = checkoutEconomicsPolicyEntries.find((entry) => entry.control === "support-safe-economics-failure");
    const cleanup = checkoutEconomicsPolicyEntries.find((entry) => entry.control === "fresh-state-economics-cleanup");

    expect(reversal?.capabilityStatus).toBe("owner-rule-required");
    expect(reversal?.amountComponents).toEqual(expect.arrayContaining(["refund", "void", "reversal", "adjustment"]));
    expect(support?.customerSafeOutcome).toMatch(/masked economics category/i);
    expect(cleanup?.capabilityStatus).toBe("internal-only");
    expect(cleanup?.customerSafeOutcome).toMatch(/stale cached totals/i);
  });

  it("documents the executable economics policy", () => {
    const doc = readFileSync(new URL("../../../docs/checkout-economics-policy.md", import.meta.url), "utf8");
    const checkoutReadme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const docsIndex = readFileSync(new URL("../../../../../docs/README.md", import.meta.url), "utf8");

    expect(checkoutEconomicsPolicyDocPath).toBe("bounded-contexts/checkout/docs/checkout-economics-policy.md");
    expect(doc).toContain("Checkout Economics Policy");
    expect(doc).toMatch(
      /The executable contract lives in\s+`bounded-contexts\/checkout\/features\/sessions\/api\/checkout-economics-policy\.ts`\./,
    );
    expect(doc).toMatch(/Customer-entered promo codes stay out of checkout/i);
    expect(doc).toMatch(/reject customer-entered\s+promo, coupon, discount, gift-card, and store-credit fields/i);
    expect(checkoutReadme).toContain("./docs/checkout-economics-policy.md");
    expect(docsIndex).toContain("../bounded-contexts/checkout/docs/checkout-economics-policy.md");

    for (const entry of checkoutEconomicsPolicyEntries) {
      expect(doc, entry.control).toContain(`| ${entry.docLabel} |`);
    }
  });
});
