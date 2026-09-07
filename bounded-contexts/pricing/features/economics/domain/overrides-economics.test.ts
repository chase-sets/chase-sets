import { describe, expect, it } from "vitest";
import type { MoneyAmount, SignedMoneyAmount } from "@chase-sets/primitives/money";
import {
  assertEconomicsFacts,
  economicsFactNames,
  type EconomicsFact,
  type EconomicsFacts,
  type FactSource,
  type ResolveEconomicsRequest,
} from "./contracts";
import { buildEconomics } from "./economics";
import type { CapitalCycleObservations, CycleStatistic } from "./observations";
import {
  applyEconomicsOverrides,
  decideEconomicsOverride,
  evolveEconomicsOverrides,
  initialEconomicsOverridesState,
} from "./overrides";

const policyRevision = "sha256:synthetic-policy-revision";
const commercialSource = {
  kind: "commercial-terms",
  agreementId: "synthetic-agreement",
  revision: "sha256:synthetic-terms-revision",
} as const;
const policySource = { kind: "policy-owned", policyRevision } as const;
const inventorySource = { kind: "inventory-observation", revision: "sha256:synthetic-inventory-revision" } as const;
const pricingSource = { kind: "pricing-observation", policyRevision, sampleCount: 5 } as const;
const observedAt = "2026-01-01T00:00:00Z";
const money = (amount: string) => ({ amount: amount as MoneyAmount, currency: "usd" });
const signedMoney = (amount: string) => ({ amount: amount as SignedMoneyAmount, currency: "usd" });

function fact<Value>(value: Value, source: FactSource): EconomicsFact<Value> {
  return { sourceValue: value, source, effectiveValue: value, override: null, observedAt };
}

function healthyFacts(): EconomicsFacts {
  return {
    platformFeeRelativeBps: fact(500, commercialSource),
    platformFeeFixedPerUnitAmount: fact(money("0.00"), commercialSource),
    platformFeeCapPerUnitAmount: fact(money("25.00"), commercialSource),
    sellerHandlingRelativeBps: fact(0, policySource),
    sellerHandlingFixedPerUnitAmount: fact(money("0.30"), policySource),
    sellerHandlingCapPerUnitAmount: fact(null, policySource),
    shippingAllowanceBps: fact(1_000, commercialSource),
    costBasisShareOfMarketBps: fact(7_200, inventorySource),
    costBasisCoverageBps: fact(10_000, inventorySource),
    costBasisDiscountPerUnitAmount: fact(signedMoney("0.30"), policySource),
    turnaroundDays: fact(28, pricingSource),
    dailyReturnHurdle: fact(0.007321664541748893, pricingSource),
  };
}

function request(overrides: Partial<ResolveEconomicsRequest> = {}): ResolveEconomicsRequest {
  return {
    accountId: "synthetic-owner-account",
    connectionId: "synthetic-connection-1",
    catalogItemId: "synthetic-catalog-item",
    inventoryItemId: "synthetic-inventory-item",
    marketUnitPrice: money("100.00"),
    quantity: 1,
    effectiveAt: "2026-09-07T06:00:00Z",
    ...overrides,
  };
}

function cycleObservation(kind: string, days: number): CycleStatistic {
  return {
    value: days,
    sampleCount: 5,
    samples: [{ sampleId: kind, days, quantity: 5, oldestObservationAt: observedAt }],
    excludedDurationCount: 0,
    observedAt,
    policyRevision,
  };
}

const observations: CapitalCycleObservations = {
  observedHold: cycleObservation("synthetic-hold", 10),
  observedTurnaround: cycleObservation("synthetic-turnaround", 28),
  diagnostics: {
    holdCandidateCount: 5,
    holdExcludedDurationCount: 0,
    turnaroundCandidateCount: 5,
    turnaroundExcludedDurationCount: 0,
  },
};

function build(
  facts: EconomicsFacts,
  overrides = initialEconomicsOverridesState({
    accountId: "synthetic-owner-account",
    connectionId: "synthetic-connection-1",
    currency: "usd",
  }),
  requestValue = request(),
) {
  return buildEconomics({
    request: requestValue,
    channel: {
      connectionId: requestValue.connectionId,
      providerKey: "synthetic-provider-a",
      environment: "sandbox",
    },
    sourceEconomics: {
      kind: "resolved",
      providerIdentity: { providerKey: "synthetic-provider-a", environment: "sandbox" },
      facts: {
        platformFeeRelativeBps: facts.platformFeeRelativeBps,
        platformFeeFixedPerUnitAmount: facts.platformFeeFixedPerUnitAmount,
        platformFeeCapPerUnitAmount: facts.platformFeeCapPerUnitAmount,
        sellerHandlingRelativeBps: facts.sellerHandlingRelativeBps,
        sellerHandlingFixedPerUnitAmount: facts.sellerHandlingFixedPerUnitAmount,
        sellerHandlingCapPerUnitAmount: facts.sellerHandlingCapPerUnitAmount,
        shippingAllowanceBps: facts.shippingAllowanceBps,
      },
    },
    costBasis: {
      share: facts.costBasisShareOfMarketBps,
      coverage: facts.costBasisCoverageBps,
      discount: facts.costBasisDiscountPerUnitAmount,
      coveredQuantity: requestValue.quantity,
      selectedQuantity: requestValue.quantity,
      coveredCostMinor: 7_170n * BigInt(requestValue.quantity),
      inventoryWatermark: "synthetic-inventory-watermark",
    },
    cycle: {
      turnaround: facts.turnaroundDays,
      dailyReturnHurdle: facts.dailyReturnHurdle,
      diagnostics: {
        observedHoldDays: 10,
        capitalCycleDays: 38,
        hurdleStatus: "derived",
        hurdleReason: null,
      },
    },
    observations,
    overrides,
  });
}

describe("Economics source ownership", () => {
  it("constructs all twelve healthy facts with the exact 4/4/2/2 source partition", () => {
    const result = build(healthyFacts());
    const counts = Object.values(result.facts).reduce<Record<string, number>>((total, current) => {
      total[current.source.kind] = (total[current.source.kind] ?? 0) + 1;
      return total;
    }, {});
    expect(counts).toEqual({
      "commercial-terms": 4,
      "policy-owned": 4,
      "inventory-observation": 2,
      "pricing-observation": 2,
    });
    expect(Object.keys(result.facts).sort()).toEqual([...economicsFactNames].sort());
  });

  it.each([
    [
      "Commercial-Terms-bound handling",
      () => ({
        ...healthyFacts(),
        sellerHandlingRelativeBps: fact(0, commercialSource),
      }),
    ],
    [
      "policy agreementId",
      () => ({
        ...healthyFacts(),
        sellerHandlingRelativeBps: fact(0, { ...policySource, agreementId: "synthetic-agreement" } as never),
      }),
    ],
    [
      "failure reason on policy-owned handling",
      () => ({
        ...healthyFacts(),
        sellerHandlingRelativeBps: fact(0, {
          kind: "policy-default",
          policyRevision,
          reason: "terms-unavailable",
        }),
      }),
    ],
    [
      "missing source",
      () => ({
        ...healthyFacts(),
        sellerHandlingRelativeBps: { ...healthyFacts().sellerHandlingRelativeBps, source: undefined } as never,
      }),
    ],
    [
      "cross-policy revision",
      () => ({
        ...healthyFacts(),
        costBasisDiscountPerUnitAmount: fact(signedMoney("0.30"), {
          kind: "policy-owned",
          policyRevision: "sha256:synthetic-other-policy-revision",
        }),
      }),
    ],
    [
      "cross-terms revision",
      () => ({
        ...healthyFacts(),
        shippingAllowanceBps: fact(1_000, { ...commercialSource, revision: "sha256:synthetic-other-terms" }),
      }),
    ],
    [
      "effective value without override",
      () => ({
        ...healthyFacts(),
        shippingAllowanceBps: { ...healthyFacts().shippingAllowanceBps, effectiveValue: 999 },
      }),
    ],
  ] as const)("rejects the %s mutant", (_name, mutate) => {
    expect(() => assertEconomicsFacts(mutate() as EconomicsFacts, "usd")).toThrow();
  });
});

describe("Economics overrides and revision", () => {
  it("keeps an active null cap distinct from a clear tombstone", () => {
    const initial = initialEconomicsOverridesState({
      accountId: "synthetic-owner-account",
      connectionId: "synthetic-connection-1",
      currency: "usd",
    });
    const [set] = decideEconomicsOverride(initial, {
      type: "SetEconomicsFactOverride",
      expectedVersion: 0,
      factName: "platformFeeCapPerUnitAmount",
      value: null,
      setAt: "2026-09-07T06:01:00Z",
    });
    const active = evolveEconomicsOverrides(initial, set!);
    expect(active.entries.platformFeeCapPerUnitAmount).toMatchObject({ kind: "active", value: null });
    expect(applyEconomicsOverrides(healthyFacts(), active).platformFeeCapPerUnitAmount).toMatchObject({
      sourceValue: money("25.00"),
      effectiveValue: null,
      override: { value: null, revision: 1 },
    });

    const [clear] = decideEconomicsOverride(active, {
      type: "ClearEconomicsFactOverride",
      expectedVersion: 1,
      factName: "platformFeeCapPerUnitAmount",
      clearedAt: "2026-09-07T06:02:00Z",
    });
    const cleared = evolveEconomicsOverrides(active, clear!);
    expect(cleared.entries.platformFeeCapPerUnitAmount).toMatchObject({ kind: "cleared", value: null });
    expect(applyEconomicsOverrides(healthyFacts(), cleared).platformFeeCapPerUnitAmount).toEqual(
      healthyFacts().platformFeeCapPerUnitAmount,
    );
  });

  it("reveals refreshed source truth after clear and fingerprints every override/tombstone", () => {
    const initial = initialEconomicsOverridesState({
      accountId: "synthetic-owner-account",
      connectionId: "synthetic-connection-1",
      currency: "usd",
    });
    const [set] = decideEconomicsOverride(initial, {
      type: "SetEconomicsFactOverride",
      expectedVersion: 0,
      factName: "platformFeeRelativeBps",
      value: 1_000,
      setAt: "2026-09-07T06:01:00Z",
    });
    const active = evolveEconomicsOverrides(initial, set!);
    const refreshed = {
      ...healthyFacts(),
      platformFeeRelativeBps: fact(600, { ...commercialSource, revision: "sha256:synthetic-new-terms" }),
      platformFeeFixedPerUnitAmount: fact(money("0.00"), {
        ...commercialSource,
        revision: "sha256:synthetic-new-terms",
      }),
      platformFeeCapPerUnitAmount: fact(money("25.00"), {
        ...commercialSource,
        revision: "sha256:synthetic-new-terms",
      }),
      shippingAllowanceBps: fact(1_000, { ...commercialSource, revision: "sha256:synthetic-new-terms" }),
    };
    const shadowed = build(refreshed, active);
    expect(shadowed.facts.platformFeeRelativeBps).toMatchObject({ sourceValue: 600, effectiveValue: 1_000 });

    const [clear] = decideEconomicsOverride(active, {
      type: "ClearEconomicsFactOverride",
      expectedVersion: 1,
      factName: "platformFeeRelativeBps",
      clearedAt: "2026-09-07T06:02:00Z",
    });
    const cleared = evolveEconomicsOverrides(active, clear!);
    const revealed = build(refreshed, cleared);
    expect(revealed.facts.platformFeeRelativeBps).toMatchObject({
      sourceValue: 600,
      effectiveValue: 600,
      override: null,
    });
    expect(shadowed.revision).not.toBe(revealed.revision);
    expect(revealed.revision).not.toBe(build(refreshed, initial).revision);
  });

  it("clear-all emits and retains one ordered tombstone per canonical fact", () => {
    let state = initialEconomicsOverridesState({
      accountId: "synthetic-owner-account",
      connectionId: "synthetic-connection-1",
      currency: "usd",
    });
    const values: Readonly<Record<(typeof economicsFactNames)[number], unknown>> = {
      platformFeeRelativeBps: 1,
      platformFeeFixedPerUnitAmount: money("0.01"),
      platformFeeCapPerUnitAmount: null,
      sellerHandlingRelativeBps: 1,
      sellerHandlingFixedPerUnitAmount: money("0.01"),
      sellerHandlingCapPerUnitAmount: null,
      shippingAllowanceBps: 1,
      costBasisShareOfMarketBps: 1,
      costBasisCoverageBps: 1,
      costBasisDiscountPerUnitAmount: signedMoney("-0.01"),
      turnaroundDays: 1,
      dailyReturnHurdle: 0.001,
    };
    for (const factName of economicsFactNames) {
      const [event] = decideEconomicsOverride(state, {
        type: "SetEconomicsFactOverride",
        expectedVersion: state.version,
        factName,
        value: values[factName],
        setAt: "2026-09-07T06:01:00Z",
      });
      state = evolveEconomicsOverrides(state, event!);
    }
    const clears = decideEconomicsOverride(state, {
      type: "ClearAllEconomicsFactOverrides",
      expectedVersion: state.version,
      clearedAt: "2026-09-07T06:02:00Z",
    });
    expect(clears).toHaveLength(12);
    for (const event of clears) state = evolveEconomicsOverrides(state, event);
    expect(state.version).toBe(24);
    expect(Object.values(state.entries).every((entry) => entry?.kind === "cleared")).toBe(true);
  });

  it("rejects optimistic conflicts and cannot resurrect a tombstone from stale delivery", () => {
    const initial = initialEconomicsOverridesState({
      accountId: "synthetic-owner-account",
      connectionId: "synthetic-connection-1",
      currency: "usd",
    });
    const [set] = decideEconomicsOverride(initial, {
      type: "SetEconomicsFactOverride",
      expectedVersion: 0,
      factName: "turnaroundDays",
      value: 21,
      setAt: "2026-09-07T06:01:00Z",
    });
    const active = evolveEconomicsOverrides(initial, set!);
    expect(() =>
      decideEconomicsOverride(active, {
        type: "ClearEconomicsFactOverride",
        expectedVersion: 0,
        factName: "turnaroundDays",
        clearedAt: "2026-09-07T06:02:00Z",
      }),
    ).toThrow(/version conflict/);
    const [clear] = decideEconomicsOverride(active, {
      type: "ClearEconomicsFactOverride",
      expectedVersion: 1,
      factName: "turnaroundDays",
      clearedAt: "2026-09-07T06:02:00Z",
    });
    const cleared = evolveEconomicsOverrides(active, clear!);
    expect(evolveEconomicsOverrides(cleared, set!)).toBe(cleared);
    expect(cleared.entries.turnaroundDays?.kind).toBe("cleared");
  });

  it("rejects an unknown event type instead of treating it as a clear", () => {
    const initial = initialEconomicsOverridesState({
      accountId: "synthetic-owner-account",
      connectionId: "synthetic-connection-1",
      currency: "usd",
    });
    expect(() =>
      evolveEconomicsOverrides(initial, {
        type: "pricing.economics-fact-override-near-miss",
        streamVersion: 1,
        data: {
          accountId: "synthetic-owner-account",
          connectionId: "synthetic-connection-1",
          currency: "usd",
          factName: "turnaroundDays",
          value: null,
          occurredAt: "2026-09-07T06:02:00Z",
        },
      } as never),
    ).toThrow(/Unknown Economics override event/);
  });

  it("changes revision for price, quantity, connection, active override, and tombstone material", () => {
    const facts = healthyFacts();
    const baseline = build(facts);
    expect(build(facts, undefined, request({ marketUnitPrice: money("101.00") })).revision).not.toBe(baseline.revision);
    expect(build(facts, undefined, request({ quantity: 2 })).revision).not.toBe(baseline.revision);
    expect(
      build(
        facts,
        initialEconomicsOverridesState({
          accountId: "synthetic-owner-account",
          connectionId: "synthetic-connection-2",
          currency: "usd",
        }),
        request({ connectionId: "synthetic-connection-2" }),
      ).revision,
    ).not.toBe(baseline.revision);
  });
});
