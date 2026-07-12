import { describe, expect, it } from "vitest";
import { createPublicPolicyValuesRuntime, type PublicPolicySource } from "./public-policy-values";

const currentValues: Record<string, unknown> = {
  "commercial-terms.marketplace-sales-fee-schedule": {
    marketplaceSalesFeePercentageBps: 500,
    marketplaceSalesFeeFixedAmount: "0.00",
    marketplaceSalesFeeCapAmount: "25.00",
    shippingAllowancePercentageBps: 500,
    internalMarginTargetBps: 9000,
  },
  "commercial-terms.checkout-processing-fee": {
    enabledJurisdictions: ["US"],
    base: { percentageBps: 290, fixedAmount: "0.30" },
    methodAdjustments: [
      { paymentMethodCategory: "card", percentageBpsDelta: 0, fixedAmountDelta: "0.00" },
      { paymentMethodCategory: "bank-account", percentageBpsDelta: -240, fixedAmountDelta: "-0.30" },
      { paymentMethodCategory: "platform-credit", percentageBpsDelta: -290, fixedAmountDelta: "-0.30" },
    ],
  },
  "settlement.clearance-window": { baseClearanceDays: 2, extendedClearanceDays: 7, highValueThresholdAmount: "250.00" },
  "settlement.payout-bounds": { currencyCode: "usd", minimumAmount: "5.00", maximumAmount: "10000.00" },
  "platform-operations.rate-limits": { incidentMultiplier: 1, surfaces: { "internal.admin": { disabled: true } } },
};

function sources(upcoming: Readonly<Record<string, unknown>> = {}): PublicPolicySource[] {
  return Object.entries(currentValues).map(([policyKey, value]) => ({
    policyKey,
    read: async () => ({
      current: { value, effectiveFrom: "2026-07-01T00:00:00.000Z" },
      upcoming:
        policyKey in upcoming
          ? [{ value: upcoming[policyKey], effectiveFrom: "2026-07-20T00:00:00.000Z", effectiveUntil: null }]
          : [],
    }),
  }));
}

describe("public policy values", () => {
  it("publishes only reviewed field-level permissions and derives processing fees", async () => {
    const result = await createPublicPolicyValuesRuntime(sources()).read("2026-07-12T00:00:00.000Z");

    expect(result.values["marketplace-sales-fee.standard.bps"].value).toBe(500);
    expect(result.values["checkout-processing-fee.bank-account.bps"].value).toBe(50);
    expect(result.values["checkout-processing-fee.bank-account.fixed"].value).toBe("0.00");
    expect(result.values["settlement.clearance.base.days"].value).toBe(2);
    expect(result.values["settlement.payout.maximum"].value).toBe("10000.00");
    expect(result.values["rate-limits.waitlist.maximum-requests"].value).toBe(20);
    expect(result.values["rate-limits.waitlist.window"].value).toBe(600000);
  });

  it("never exposes non-whitelisted policy fields or policy documents", async () => {
    const result = await createPublicPolicyValuesRuntime(sources()).read("2026-07-12T00:00:00.000Z");
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("internalMarginTargetBps");
    expect(serialized).not.toContain("internal.admin");
    expect(serialized).not.toContain("commercial-terms.authenticity-fee");
    expect(Object.keys(result.values).every((key) => !key.includes("document"))).toBe(true);
  });

  it("includes future-effective values without making them current", async () => {
    const futureSchedule = {
      ...(currentValues["commercial-terms.marketplace-sales-fee-schedule"] as object),
      marketplaceSalesFeePercentageBps: 600,
    };
    const result = await createPublicPolicyValuesRuntime(
      sources({ "commercial-terms.marketplace-sales-fee-schedule": futureSchedule }),
    ).read("2026-07-12T00:00:00.000Z");

    expect(result.values["marketplace-sales-fee.standard.bps"]).toMatchObject({
      value: 500,
      upcoming: [{ value: 600, effectiveFrom: "2026-07-20T00:00:00.000Z" }],
    });
  });
});
