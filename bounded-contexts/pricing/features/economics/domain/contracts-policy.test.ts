import { describe, expect, it } from "vitest";
import {
  ECONOMICS_LAUNCH_POLICY_VALUE,
  assertEconomicsPolicyEffectiveAt,
  decodeEconomicsPolicyValue,
  economicsPolicy,
  parseResolvedEconomicsPolicy,
  toResolvedEconomicsPolicy,
} from "./policy";
import { parseResolveEconomicsRequest } from "./contracts";

const request = {
  accountId: "synthetic-owner-account",
  connectionId: "synthetic-connection-1",
  catalogItemId: "synthetic-catalog-item",
  inventoryItemId: "synthetic-inventory-item",
  marketUnitPrice: { amount: "100.00", currency: "usd" },
  quantity: 1,
  effectiveAt: "2026-09-07T01:00:00-05:00",
};

describe("Economics closed contracts", () => {
  it("accepts the canonical authenticated internal request", () => {
    expect(parseResolveEconomicsRequest(request)).toEqual(request);
  });

  it.each([
    { ...request, accountId: undefined },
    { ...request, providerKey: "synthetic-forged-provider" },
    { ...request, environment: "production" },
    { ...request, channel: { accountId: "synthetic-forged-account" } },
    { ...request, effectiveAt: "2026-09-07T01:00:00" },
    { ...request, quantity: 0 },
    { ...request, marketUnitPrice: { amount: "100", currency: "usd" } },
    { ...request, marketUnitPrice: { amount: "10000000000.00", currency: "usd" } },
    { ...request, marketUnitPrice: { amount: "100.00", currency: "USD" } },
  ])("rejects omitted, forged, aliased, or malformed input %#", (candidate) => {
    expect(() => parseResolveEconomicsRequest(candidate)).toThrow();
  });
});

describe("pricing.economics policy", () => {
  it("declares and decodes the exact launch policy", () => {
    expect(economicsPolicy.policyKey).toBe("pricing.economics");
    expect(economicsPolicy.contextName).toBe("pricing");
    expect(decodeEconomicsPolicyValue(ECONOMICS_LAUNCH_POLICY_VALUE)).toEqual(ECONOMICS_LAUNCH_POLICY_VALUE);
  });

  it.each([
    { ...ECONOMICS_LAUNCH_POLICY_VALUE, surprise: true },
    { ...ECONOMICS_LAUNCH_POLICY_VALUE, sellerHandlingRelativeBps: 10_001 },
    { ...ECONOMICS_LAUNCH_POLICY_VALUE, sellerHandlingFixedPerUnitAmount: "0.3" },
    { ...ECONOMICS_LAUNCH_POLICY_VALUE, costBasisDiscountPerUnitAmount: "wat" },
    { ...ECONOMICS_LAUNCH_POLICY_VALUE, observationStatistic: "average" },
    { ...ECONOMICS_LAUNCH_POLICY_VALUE, minimumHoldSamples: 0 },
    { ...ECONOMICS_LAUNCH_POLICY_VALUE, maximumObservationDurationDays: 181 },
    { ...ECONOMICS_LAUNCH_POLICY_VALUE, defaultDailyReturnHurdle: Number.NaN },
  ])("rejects a recursively closed policy mutant %#", (candidate) => {
    expect(() => decodeEconomicsPolicyValue(candidate as never)).toThrow();
  });

  it("fingerprints effective policy identity and never uses resolvedAt as freshness", () => {
    const first = toResolvedEconomicsPolicy({
      policyKey: "pricing.economics",
      value: ECONOMICS_LAUNCH_POLICY_VALUE,
      source: "fallback",
      documentId: null,
      effectiveFrom: null,
      effectiveUntil: null,
      resolvedAt: "2099-01-01T00:00:00Z",
    });
    const laterRead = toResolvedEconomicsPolicy({
      policyKey: "pricing.economics",
      value: ECONOMICS_LAUNCH_POLICY_VALUE,
      source: "fallback",
      documentId: null,
      effectiveFrom: null,
      effectiveUntil: null,
      resolvedAt: "2199-01-01T00:00:00Z",
    });
    expect(laterRead.policyRevision).toBe(first.policyRevision);
    expect(first.observedAt).toBe("2026-09-06T20:28:41Z");
    expect(parseResolvedEconomicsPolicy(first)).toEqual(first);
    expect(() => parseResolvedEconomicsPolicy({ ...first, policyRevision: "sha256:forged" })).toThrow(/does not match/);
    expect(() => parseResolvedEconomicsPolicy({ ...first, value: { ...first.value, surprise: true } })).toThrow(
      /exactly/,
    );
  });

  it("rejects foreign policy identity and invalid document validity metadata", () => {
    const base = {
      policyKey: "pricing.economics",
      value: ECONOMICS_LAUNCH_POLICY_VALUE,
      source: "policy" as const,
      documentId: "synthetic-policy-document",
      effectiveFrom: "2026-09-01T00:00:00Z",
      effectiveUntil: "2026-10-01T00:00:00Z",
      resolvedAt: "2026-09-07T06:00:00Z",
    };
    expect(() => toResolvedEconomicsPolicy({ ...base, policyKey: "pricing.other" })).toThrow(/Expected/);
    expect(() => toResolvedEconomicsPolicy({ ...base, effectiveUntil: "2026-08-01T00:00:00Z" })).toThrow(/after/);
    expect(() =>
      toResolvedEconomicsPolicy({
        ...base,
        source: "fallback",
        documentId: "synthetic-forged-document",
        effectiveFrom: null,
        effectiveUntil: null,
      }),
    ).toThrow(/fallback/);
  });

  it("requires the resolved document or fallback to apply at the evaluation instant", () => {
    const fallback = toResolvedEconomicsPolicy({
      policyKey: "pricing.economics",
      value: ECONOMICS_LAUNCH_POLICY_VALUE,
      source: "fallback",
      documentId: null,
      effectiveFrom: null,
      effectiveUntil: null,
      resolvedAt: "2026-09-07T06:00:00Z",
    });
    expect(() => assertEconomicsPolicyEffectiveAt(fallback, "2026-09-06T20:28:40Z")).toThrow(/postdate/);

    const active = toResolvedEconomicsPolicy({
      policyKey: "pricing.economics",
      value: ECONOMICS_LAUNCH_POLICY_VALUE,
      source: "policy",
      documentId: "synthetic-policy-document",
      effectiveFrom: "2026-09-01T00:00:00Z",
      effectiveUntil: "2026-10-01T00:00:00Z",
      resolvedAt: "2026-09-07T06:00:00Z",
    });
    expect(() => assertEconomicsPolicyEffectiveAt(active, "2026-08-31T23:59:59Z")).toThrow(/postdate|not yet/);
    expect(() => assertEconomicsPolicyEffectiveAt(active, "2026-10-01T00:00:00Z")).toThrow(/no longer/);
    expect(() => assertEconomicsPolicyEffectiveAt(active, "2026-09-07T06:00:00Z")).not.toThrow();
  });
});
