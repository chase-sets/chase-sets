import { describe, expect, it, vi } from "vitest";
import type { MoneyAmount } from "@chase-sets/primitives/money";
import { createEconomicsProviderRegistry } from "../domain/provider-registry";
import { initialEconomicsOverridesState } from "../domain/overrides";
import { ECONOMICS_LAUNCH_POLICY_VALUE, toResolvedEconomicsPolicy } from "../domain/policy";
import type { EconomicsFact, FactSource, ResolveEconomicsRequest } from "../domain/contracts";
import { createEconomicsRuntime } from "./runtime";
import { toEconomicsForPricingGoal } from "../domain/resolution";
import { createNativeCommercialTermsEconomicsProvider } from "../integrations/native-commercial-terms/provider";

const request: ResolveEconomicsRequest = {
  accountId: "synthetic-owner-account",
  connectionId: "synthetic-connection-1",
  catalogItemId: "synthetic-catalog-item",
  inventoryItemId: "synthetic-inventory-item",
  marketUnitPrice: { amount: "100.00" as MoneyAmount, currency: "usd" },
  quantity: 1,
  effectiveAt: "2026-09-07T06:00:00Z",
};

const policy = toResolvedEconomicsPolicy({
  policyKey: "pricing.economics",
  value: ECONOMICS_LAUNCH_POLICY_VALUE,
  source: "fallback",
  documentId: null,
  effectiveFrom: null,
  effectiveUntil: null,
  resolvedAt: request.effectiveAt,
});

const identity = { providerKey: "synthetic-provider-a", environment: "sandbox" } as const;
const channel = { connectionId: request.connectionId, ...identity };
const money = (amount: string) => ({ amount: amount as MoneyAmount, currency: "usd" });
const fact = <Value>(value: Value, source: FactSource, observedAt = "2026-09-01T00:00:00Z"): EconomicsFact<Value> => ({
  sourceValue: value,
  source,
  effectiveValue: value,
  override: null,
  observedAt,
});

function evidence() {
  return {
    acquisitions: [
      {
        accountId: request.accountId,
        inventoryItemId: request.inventoryItemId,
        lotId: "synthetic-acquisition-1",
        quantity: 5,
        occurrence: {
          kind: "occurred" as const,
          occurredAt: "2026-08-10T00:00:00Z",
          source: "seller-supplied" as const,
        },
      },
      {
        accountId: request.accountId,
        inventoryItemId: "synthetic-next-item",
        lotId: "synthetic-acquisition-2",
        quantity: 5,
        occurrence: {
          kind: "occurred" as const,
          occurredAt: "2026-09-01T00:00:00Z",
          source: "import-supplied" as const,
        },
      },
    ],
    sales: [
      {
        accountId: request.accountId,
        inventoryItemId: "synthetic-old-item",
        saleId: "synthetic-sale-1",
        quantity: 5,
        soldAt: "2026-08-04T00:00:00Z",
        currency: "usd",
        excluded: false,
      },
      {
        accountId: request.accountId,
        inventoryItemId: request.inventoryItemId,
        saleId: "synthetic-sale-2",
        quantity: 5,
        soldAt: "2026-08-20T00:00:00Z",
        currency: "usd",
        excluded: false,
      },
    ],
    costLots: [
      {
        accountId: request.accountId,
        inventoryItemId: request.inventoryItemId,
        lotId: "synthetic-cost-1",
        quantity: 1,
        acquisitionCostPerUnit: money("72.00"),
        observedAt: "2026-08-10T00:00:00Z",
        revision: "synthetic-cost-revision-1",
      },
    ],
    inventoryWatermark: "inventory:42",
    pricingWatermark: "pricing:73",
    inventoryObservedAt: "2026-09-07T05:58:00Z",
    pricingObservedAt: "2026-09-07T05:59:00Z",
  };
}

function baseDependencies(registry = createEconomicsProviderRegistry()) {
  return {
    channelConnectionIdentityReader: { resolve: vi.fn(async () => channel) },
    providerRegistry: registry,
    evidenceReader: { resolve: vi.fn(async () => evidence()) },
    overrides: {
      loadAt: vi.fn(async () =>
        initialEconomicsOverridesState({
          accountId: request.accountId,
          connectionId: request.connectionId,
          currency: "usd",
        }),
      ),
    },
    resolvePolicy: vi.fn(async () => policy),
  };
}

describe("Economics runtime", () => {
  it("assembles twelve replayable facts and uses the provider's one policy resolution", async () => {
    const registry = createEconomicsProviderRegistry();
    const commercialSource = {
      kind: "commercial-terms",
      agreementId: "synthetic-agreement",
      revision: "terms:7",
    } as const;
    const policySource = { kind: "policy-owned", policyRevision: policy.policyRevision } as const;
    registry.registerExact({
      identity,
      resolve: async () => ({
        kind: "resolved",
        providerIdentity: identity,
        policy,
        facts: {
          platformFeeRelativeBps: fact(500, commercialSource),
          platformFeeFixedPerUnitAmount: fact(money("0.00"), commercialSource),
          platformFeeCapPerUnitAmount: fact(money("25.00"), commercialSource),
          sellerHandlingRelativeBps: fact(0, policySource),
          sellerHandlingFixedPerUnitAmount: fact(money("0.30"), policySource),
          sellerHandlingCapPerUnitAmount: fact(null, policySource),
          shippingAllowanceBps: fact(1_000, commercialSource),
        },
      }),
    });
    const deps = baseDependencies(registry);
    const result = await createEconomicsRuntime(deps).resolve(request);
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("Expected resolved Economics.");
    expect(Object.keys(result.economics.facts)).toHaveLength(12);
    expect(result.economics.diagnostics).toMatchObject({
      inventoryWatermark: "inventory:42",
      pricingWatermark: "pricing:73",
      generatedAt: request.effectiveAt,
      hurdleStatus: "derived",
    });
    expect(deps.resolvePolicy).not.toHaveBeenCalled();
  });

  it("returns a numeric hold input on provider absence without inventing a platform fee", async () => {
    const deps = baseDependencies();
    const result = await createEconomicsRuntime(deps).resolve(request);
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") throw new Error("Expected unavailable Economics.");
    expect(result.reason).toBe("provider-unavailable");
    expect(result.facts.dailyReturnHurdle).toMatchObject({
      sourceValue: 0.005,
      effectiveValue: 0.005,
      source: { kind: "policy-default", reason: "provider-unavailable" },
    });
    expect(result.facts).not.toHaveProperty("platformFeeRelativeBps");
    expect(toEconomicsForPricingGoal(result)).toEqual({
      availability: "unavailable",
      reason: "provider-unavailable",
      currency: "usd",
      effectiveAt: request.effectiveAt,
      dailyReturnHurdle: result.facts.dailyReturnHurdle,
    });
    expect(deps.resolvePolicy).toHaveBeenCalledOnce();
    expect(deps.resolvePolicy).toHaveBeenCalledWith(request.effectiveAt);
  });

  it("keeps the registered native Terms-unavailable path numeric without inventing a fee", async () => {
    const registry = createEconomicsProviderRegistry();
    const nativeResolvePolicy = vi.fn(async () => policy);
    registry.registerExact(
      createNativeCommercialTermsEconomicsProvider({
        identity,
        commercialTermsResolver: {
          resolveListingTerms: async () => {
            throw new Error("synthetic unavailable Terms authority");
          },
        },
        resolvePolicy: nativeResolvePolicy,
      }),
    );
    const deps = baseDependencies(registry);

    const result = await createEconomicsRuntime(deps).resolve(request);
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") throw new Error("Expected unavailable Economics.");
    expect(result.reason).toBe("terms-unavailable");
    expect(result.facts.dailyReturnHurdle).toMatchObject({
      sourceValue: 0.005,
      effectiveValue: 0.005,
      source: { kind: "policy-default", reason: "terms-unavailable" },
    });
    expect(result.facts).not.toHaveProperty("platformFeeRelativeBps");
    expect(nativeResolvePolicy).toHaveBeenCalledWith(request.effectiveAt);
    expect(deps.resolvePolicy).not.toHaveBeenCalled();
  });

  it("rejects malformed provider policy material before using its values", async () => {
    const registry = createEconomicsProviderRegistry();
    registry.registerExact({
      identity,
      resolve: async () => ({
        kind: "unavailable",
        providerIdentity: identity,
        reason: "terms-unavailable",
        policy: { ...policy, policyRevision: "sha256:forged" },
      }),
    });
    await expect(createEconomicsRuntime(baseDependencies(registry)).resolve(request)).rejects.toThrow(
      /revision does not match/,
    );
  });
});
