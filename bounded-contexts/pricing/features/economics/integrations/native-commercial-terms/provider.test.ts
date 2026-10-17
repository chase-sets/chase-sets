import { describe, expect, it, vi } from "vitest";
import type { MoneyAmount } from "@chase-sets/primitives/money";
import { ECONOMICS_LAUNCH_POLICY_VALUE, toResolvedEconomicsPolicy } from "../../domain/policy";
import type { ResolveEconomicsRequest } from "../../domain/contracts";
import { createNativeMarketplaceEconomicsProvider } from "./provider";

const request: ResolveEconomicsRequest = {
  accountId: "synthetic-owner-account",
  scope: { kind: "native-marketplace" },
  catalogItemId: "synthetic-catalog-item",
  inventoryItemId: "synthetic-inventory-item",
  marketUnitPrice: { amount: "100.00" as MoneyAmount, currency: "usd" },
  quantity: 1,
  effectiveAt: "2026-09-07T06:00:00Z",
};
const resolvedPolicy = toResolvedEconomicsPolicy({
  policyKey: "pricing.economics",
  value: ECONOMICS_LAUNCH_POLICY_VALUE,
  source: "fallback",
  documentId: null,
  effectiveFrom: null,
  effectiveUntil: null,
  resolvedAt: request.effectiveAt,
});

function terms(overrides: Record<string, unknown> = {}) {
  return {
    accountId: request.accountId,
    accountType: "business" as const,
    basisAmount: request.marketUnitPrice.amount,
    marketplaceSalesFeeUnitAmount: "5.00",
    sellerNetUnitAmount: "95.00",
    marketplaceSalesFeePercentageBps: 500,
    marketplaceSalesFeeFixedAmount: "0.00",
    marketplaceSalesFeeCapAmount: "25.00",
    shippingAllowancePercentageBps: 1_000,
    scheduleId: "synthetic-schedule",
    agreementId: "synthetic-agreement",
    resolvedAt: request.effectiveAt,
    ...overrides,
  };
}

describe("native Commercial Terms Economics provider", () => {
  it("binds exactly four facts to Commercial Terms and three handling facts to Pricing policy", async () => {
    const resolveListingTerms = vi.fn(async () => terms());
    const resolvePolicy = vi.fn(async () => resolvedPolicy);
    const provider = createNativeMarketplaceEconomicsProvider({
      commercialTermsResolver: { resolveListingTerms },
      resolvePolicy,
    });
    const result = await provider.resolve(request);
    expect(resolveListingTerms).toHaveBeenCalledWith({
      accountId: request.accountId,
      amount: "100.00",
      effectiveAt: request.effectiveAt,
    });
    expect(resolvePolicy).toHaveBeenCalledWith(request.effectiveAt);
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("Expected resolved source Economics.");

    const commercial = Object.entries(result.facts).filter(([, fact]) => fact.source.kind === "commercial-terms");
    const policyOwned = Object.entries(result.facts).filter(([, fact]) => fact.source.kind === "policy-owned");
    expect(commercial.map(([name]) => name).sort()).toEqual([
      "platformFeeCapPerUnitAmount",
      "platformFeeFixedPerUnitAmount",
      "platformFeeRelativeBps",
      "shippingAllowanceBps",
    ]);
    expect(policyOwned.map(([name]) => name).sort()).toEqual([
      "sellerHandlingCapPerUnitAmount",
      "sellerHandlingFixedPerUnitAmount",
      "sellerHandlingRelativeBps",
    ]);
    expect(result.facts.sellerHandlingFixedPerUnitAmount).toMatchObject({
      sourceValue: { amount: "0.30", currency: "usd" },
      source: { kind: "policy-owned", policyRevision: resolvedPolicy.policyRevision },
      observedAt: resolvedPolicy.observedAt,
    });
  });

  it("changes the Commercial Terms revision when a published value changes but not when resolvedAt changes", async () => {
    const run = async (overrides: Record<string, unknown>, effectiveAt = request.effectiveAt) => {
      const provider = createNativeMarketplaceEconomicsProvider({
        commercialTermsResolver: { resolveListingTerms: async () => terms({ ...overrides, resolvedAt: effectiveAt }) },
        resolvePolicy: async () => resolvedPolicy,
      });
      const result = await provider.resolve({ ...request, effectiveAt });
      if (result.kind !== "resolved") throw new Error("Expected resolved source Economics.");
      return result.facts.platformFeeRelativeBps.source;
    };
    const baseline = await run({});
    expect(await run({}, "2026-09-08T06:00:00Z")).toEqual(baseline);
    expect(await run({ marketplaceSalesFeePercentageBps: 501 })).not.toEqual(baseline);
  });

  it("collapses every Commercial Terms domain failure without exposing its text", async () => {
    const provider = createNativeMarketplaceEconomicsProvider({
      commercialTermsResolver: {
        resolveListingTerms: async () => {
          throw new Error("sensitive database detail");
        },
      },
      resolvePolicy: async () => resolvedPolicy,
    });
    await expect(provider.resolve(request)).resolves.toEqual({
      kind: "unavailable",
      reason: "terms-unavailable",
      policy: resolvedPolicy,
    });
  });

  it.each([
    ["malformed fixed amount", { marketplaceSalesFeeFixedAmount: "0.0" }],
    ["missing cap field", { marketplaceSalesFeeCapAmount: undefined }],
    ["out-of-range allowance", { shippingAllowancePercentageBps: 10_001 }],
    ["non-finite relative fee", { marketplaceSalesFeePercentageBps: Number.NaN }],
    ["foreign account", { accountId: "synthetic-foreign-account" }],
    ["different basis amount", { basisAmount: "99.00" }],
    ["different evaluation instant", { resolvedAt: "2026-09-07T06:00:01Z" }],
  ])("collapses %s from a mixed dynamic Terms result to numeric unavailable", async (_name, overrides) => {
    const provider = createNativeMarketplaceEconomicsProvider({
      commercialTermsResolver: { resolveListingTerms: async () => terms(overrides) as never },
      resolvePolicy: async () => resolvedPolicy,
    });

    await expect(provider.resolve(request)).resolves.toEqual({
      kind: "unavailable",
      reason: "terms-unavailable",
      policy: resolvedPolicy,
    });
  });

  it("rejects malformed dynamic policy before reading or formatting Commercial Terms", async () => {
    const resolveListingTerms = vi.fn(async () => terms());
    const provider = createNativeMarketplaceEconomicsProvider({
      commercialTermsResolver: { resolveListingTerms },
      resolvePolicy: async () =>
        ({
          ...resolvedPolicy,
          value: { ...resolvedPolicy.value, sellerHandlingFixedPerUnitAmount: "0.3" },
        }) as never,
    });

    await expect(provider.resolve(request)).rejects.toThrow(/canonical/);
    expect(resolveListingTerms).not.toHaveBeenCalled();
  });
});
