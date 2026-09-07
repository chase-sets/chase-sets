import { describe, expect, it } from "vitest";
import type { MoneyAmount, SignedMoneyAmount } from "@chase-sets/primitives/money";
import { deriveCostBasisFacts, deriveCycleFacts } from "./derivation";
import { observeCapitalCycle, type CapitalCycleObservations, type CycleStatistic } from "./observations";
import { ECONOMICS_LAUNCH_POLICY_VALUE, type EconomicsPolicyValue, type ResolvedEconomicsPolicy } from "./policy";
import { quoteSellerOverhead } from "./overhead";

const money = (amount: string, currency = "usd") => ({ amount: amount as MoneyAmount, currency });
const signedMoney = (amount: string, currency = "usd") => ({ amount: amount as SignedMoneyAmount, currency });

function policy(value: Partial<EconomicsPolicyValue> = {}): ResolvedEconomicsPolicy {
  return {
    value: { ...ECONOMICS_LAUNCH_POLICY_VALUE, ...value },
    policyRevision: "sha256:synthetic-policy-revision",
    observedAt: "2026-09-06T20:28:41Z",
    source: "fallback",
    documentId: null,
    effectiveFrom: null,
    effectiveUntil: null,
  };
}

function observed(value: number, kind: string): CycleStatistic {
  return {
    value,
    sampleCount: 5,
    samples: [{ sampleId: kind, days: value, quantity: 5, oldestObservationAt: "2026-01-01T00:00:00Z" }],
    excludedDurationCount: 0,
    observedAt: "2026-01-01T00:00:00Z",
    policyRevision: "sha256:synthetic-policy-revision",
  };
}

function observations(hold: number | null, turnaround: number | null): CapitalCycleObservations {
  return {
    observedHold: hold === null ? null : observed(hold, "hold"),
    observedTurnaround: turnaround === null ? null : observed(turnaround, "turnaround"),
    diagnostics: {
      holdCandidateCount: hold === null ? 0 : 5,
      holdExcludedDurationCount: 0,
      turnaroundCandidateCount: turnaround === null ? 0 : 5,
      turnaroundExcludedDurationCount: 0,
    },
  };
}

describe("one-to-one capital-cycle observations", () => {
  it("splits quantity without reusing acquisition units and ignores unknown/cancelled/wrong-currency evidence", () => {
    const result = observeCapitalCycle({
      accountId: "synthetic-owner-account",
      currency: "usd",
      effectiveAt: "2026-01-20T00:00:00Z",
      policy: policy({ minimumHoldSamples: 1, minimumTurnaroundSamples: 1 }),
      acquisitions: [
        {
          accountId: "synthetic-owner-account",
          inventoryItemId: "item-1",
          lotId: "lot-a",
          quantity: 2,
          occurrence: { kind: "occurred", occurredAt: "2026-01-01T00:00:00Z", source: "seller-supplied" },
        },
        {
          accountId: "synthetic-owner-account",
          inventoryItemId: "item-1",
          lotId: "lot-b",
          quantity: 2,
          occurrence: { kind: "occurred", occurredAt: "2026-01-02T00:00:00Z", source: "import-supplied" },
        },
        {
          accountId: "synthetic-owner-account",
          inventoryItemId: "item-1",
          lotId: "lot-unknown",
          quantity: 99,
          occurrence: { kind: "unknown" },
        },
      ],
      sales: [
        {
          accountId: "synthetic-owner-account",
          inventoryItemId: "item-1",
          saleId: "sale-a",
          quantity: 3,
          soldAt: "2026-01-11T00:00:00Z",
          currency: "usd",
          excluded: false,
        },
        {
          accountId: "synthetic-owner-account",
          inventoryItemId: "item-1",
          saleId: "sale-b",
          quantity: 2,
          soldAt: "2026-01-12T00:00:00Z",
          currency: "usd",
          excluded: false,
        },
        {
          accountId: "synthetic-owner-account",
          inventoryItemId: "item-1",
          saleId: "cancelled",
          quantity: 10,
          soldAt: "2026-01-13T00:00:00Z",
          currency: "usd",
          excluded: true,
        },
        {
          accountId: "synthetic-owner-account",
          inventoryItemId: "item-1",
          saleId: "wrong-currency",
          quantity: 10,
          soldAt: "2026-01-13T00:00:00Z",
          currency: "eur",
          excluded: false,
        },
      ],
    });

    expect(result.observedHold?.sampleCount).toBe(4);
    expect(result.observedHold?.samples.map(({ sampleId, quantity }) => [sampleId, quantity])).toEqual([
      ["hold:lot-b:sale-a", 1],
      ["hold:lot-a:sale-a", 2],
      ["hold:lot-b:sale-b", 1],
    ]);
    expect(result.observedHold?.value).toBe(10);
  });

  it("matches turnaround across the account one-to-one with stable time/identity ordering", () => {
    const result = observeCapitalCycle({
      accountId: "synthetic-owner-account",
      currency: "usd",
      effectiveAt: "2026-01-20T00:00:00Z",
      policy: policy({ minimumHoldSamples: 99, minimumTurnaroundSamples: 1 }),
      acquisitions: [
        {
          accountId: "synthetic-owner-account",
          inventoryItemId: "item-2",
          lotId: "lot-b",
          quantity: 2,
          occurrence: { kind: "occurred", occurredAt: "2026-01-06T00:00:00Z", source: "seller-supplied" },
        },
        {
          accountId: "synthetic-owner-account",
          inventoryItemId: "item-1",
          lotId: "lot-a",
          quantity: 2,
          occurrence: { kind: "occurred", occurredAt: "2026-01-05T00:00:00Z", source: "seller-supplied" },
        },
      ],
      sales: [
        {
          accountId: "synthetic-owner-account",
          inventoryItemId: "old-2",
          saleId: "sale-b",
          quantity: 1,
          soldAt: "2026-01-02T00:00:00Z",
          currency: "usd",
          excluded: false,
        },
        {
          accountId: "synthetic-owner-account",
          inventoryItemId: "old-1",
          saleId: "sale-a",
          quantity: 2,
          soldAt: "2026-01-01T00:00:00Z",
          currency: "usd",
          excluded: false,
        },
      ],
    });
    expect(result.observedTurnaround?.sampleCount).toBe(3);
    expect(result.observedTurnaround?.samples.map(({ sampleId, quantity }) => [sampleId, quantity])).toEqual([
      ["turnaround:sale-a:lot-a", 2],
      ["turnaround:sale-b:lot-b", 1],
    ]);
    expect(result.observedTurnaround?.value).toBe(4);
  });

  it("uses an inclusive effective boundary and reports duration exclusions even below the threshold", () => {
    const result = observeCapitalCycle({
      accountId: "synthetic-owner-account",
      currency: "usd",
      effectiveAt: "2026-01-10T00:00:00Z",
      policy: policy({ minimumHoldSamples: 2, maximumObservationDurationDays: 5 }),
      acquisitions: [
        {
          accountId: "synthetic-owner-account",
          inventoryItemId: "item-1",
          lotId: "lot-a",
          quantity: 1,
          occurrence: { kind: "occurred", occurredAt: "2026-01-01T00:00:00Z", source: "seller-supplied" },
        },
      ],
      sales: [
        {
          accountId: "synthetic-owner-account",
          inventoryItemId: "item-1",
          saleId: "sale-at-boundary",
          quantity: 1,
          soldAt: "2026-01-10T00:00:00Z",
          currency: "usd",
          excluded: false,
        },
        {
          accountId: "synthetic-owner-account",
          inventoryItemId: "item-1",
          saleId: "sale-after-boundary",
          quantity: 1,
          soldAt: "2026-01-10T00:00:00.001Z",
          currency: "usd",
          excluded: false,
        },
      ],
    });
    expect(result.observedHold).toBeNull();
    expect(result.diagnostics.holdCandidateCount).toBe(1);
    expect(result.diagnostics.holdExcludedDurationCount).toBe(1);
  });

  it("rejects malformed matching-account observations, including unknown lots with invalid quantity", () => {
    const base = {
      accountId: "synthetic-owner-account",
      currency: "usd",
      effectiveAt: "2026-01-20T00:00:00Z",
      policy: policy(),
      sales: [],
    };
    expect(() =>
      observeCapitalCycle({
        ...base,
        acquisitions: [
          {
            accountId: "synthetic-owner-account",
            inventoryItemId: "item-1",
            lotId: "lot-unknown",
            quantity: -1,
            occurrence: { kind: "unknown" },
          },
        ],
      }),
    ).toThrow(/quantity/);
    expect(() =>
      observeCapitalCycle({
        ...base,
        acquisitions: [
          {
            accountId: "synthetic-owner-account",
            inventoryItemId: "item-1",
            lotId: "lot-forged",
            quantity: 1,
            occurrence: { kind: "unknown", occurredAt: "2026-01-01T00:00:00Z" } as never,
          },
        ],
      }),
    ).toThrow(/not closed/);
  });

  it("moves observed to default and back to observed as evidence crosses the threshold", () => {
    const acquisition = (quantity: number) => ({
      accountId: "synthetic-owner-account",
      inventoryItemId: "item-1",
      lotId: "lot-a",
      quantity,
      occurrence: {
        kind: "occurred" as const,
        occurredAt: "2026-01-01T00:00:00Z",
        source: "seller-supplied" as const,
      },
    });
    const sale = (quantity: number) => ({
      accountId: "synthetic-owner-account",
      inventoryItemId: "item-1",
      saleId: "sale-a",
      quantity,
      soldAt: "2026-01-11T00:00:00Z",
      currency: "usd",
      excluded: false,
    });
    const run = (quantity: number) =>
      observeCapitalCycle({
        accountId: "synthetic-owner-account",
        currency: "usd",
        effectiveAt: "2026-01-20T00:00:00Z",
        policy: policy({ minimumHoldSamples: 5 }),
        acquisitions: [acquisition(quantity)],
        sales: [sale(quantity)],
      });

    expect(run(5).observedHold?.value).toBe(10);
    expect(run(4).observedHold).toBeNull();
    expect(run(5).observedHold?.value).toBe(10);
  });
});

describe("cost basis", () => {
  it("derives share over the same covered units and keeps partial coverage visible", () => {
    const result = deriveCostBasisFacts({
      accountId: "synthetic-owner-account",
      inventoryItemId: "item-1",
      marketUnitPrice: money("100.00"),
      quantity: 4,
      effectiveAt: "2026-01-10T00:00:00Z",
      inventoryWatermark: "inventory:42",
      inventoryObservedAt: "2026-01-09T00:00:00Z",
      policy: policy({ minimumCostBasisCoverageBps: 5_000 }),
      lots: [
        {
          accountId: "synthetic-owner-account",
          inventoryItemId: "item-1",
          lotId: "lot-a",
          quantity: 2,
          acquisitionCostPerUnit: money("72.00"),
          observedAt: "2026-01-01T00:00:00Z",
          revision: "1",
        },
        {
          accountId: "synthetic-owner-account",
          inventoryItemId: "item-1",
          lotId: "lot-b",
          quantity: 2,
          acquisitionCostPerUnit: null,
          observedAt: "2026-01-02T00:00:00Z",
          revision: "2",
        },
      ],
    });
    expect(result.coverage.sourceValue).toBe(5_000);
    expect(result.share.sourceValue).toBe(7_200);
    expect(result.share.source.kind).toBe("inventory-observation");
  });

  it("defaults unavailable/foreign-currency cost instead of coercing it to zero", () => {
    const result = deriveCostBasisFacts({
      accountId: "synthetic-owner-account",
      inventoryItemId: "item-1",
      marketUnitPrice: money("100.00"),
      quantity: 1,
      effectiveAt: "2026-01-10T00:00:00Z",
      inventoryWatermark: "inventory:43",
      inventoryObservedAt: "2026-01-09T00:00:00Z",
      policy: policy(),
      lots: [
        {
          accountId: "synthetic-owner-account",
          inventoryItemId: "item-1",
          lotId: "lot-a",
          quantity: 1,
          acquisitionCostPerUnit: money("72.00", "eur"),
          observedAt: "2026-01-01T00:00:00Z",
          revision: "1",
        },
      ],
    });
    expect(result.coverage.sourceValue).toBe(0);
    expect(result.share.sourceValue).toBe(7_200);
    expect(result.share.source).toMatchObject({ kind: "policy-default", reason: "cost-basis-unavailable" });
    expect(result.discount.source).toEqual({
      kind: "policy-owned",
      policyRevision: "sha256:synthetic-policy-revision",
    });
  });
});

describe("daily return hurdle fixed oracle", () => {
  const overheadTerms = {
    platformFeeRelativeBps: 500,
    platformFeeFixedPerUnitAmount: money("0.00"),
    platformFeeCapPerUnitAmount: money("25.00"),
    sellerHandlingRelativeBps: 0,
    sellerHandlingFixedPerUnitAmount: money("0.30"),
    sellerHandlingCapPerUnitAmount: null,
  };

  it.each([
    ["100.00", 1, "0.30", 0.007321664541748893],
    ["1000.00", 1, "0.30", 0.007981454548142254],
    ["100.00", 3, "0.30", 0.007321664541748893],
    ["100.00", 1, "-0.50", 0.007029669429773777],
  ])("matches the independent oracle at %s x %i with discount %s", (amount, quantity, discount, expected) => {
    const quote = quoteSellerOverhead(money(amount), quantity, overheadTerms);
    const result = deriveCycleFacts({
      marketUnitPrice: money(amount),
      quantity,
      netProceedsAmount: quote.netProceedsAmount,
      costBasisShareOfMarketBps: 7_200,
      costBasisDiscountPerUnitAmount: signedMoney(discount),
      observations: observations(10, 28),
      policy: policy(),
    });
    expect(result.dailyReturnHurdle.sourceValue).toBeCloseTo(expected, 14);
    expect(result.diagnostics).toMatchObject({ hurdleStatus: "derived", hurdleReason: null, capitalCycleDays: 38 });
  });

  it.each([
    [observations(null, 28), undefined, "insufficient-observed-history"],
    [observations(10, 28), "cost-basis-unavailable", "cost-basis-unavailable"],
    [observations(0, 0), undefined, "non-positive-cycle"],
    [observations(10, 28), undefined, "non-positive-net-proceeds"],
  ] as const)("keeps failure numeric and explicit %#", (history, upstreamFailure, reason) => {
    const result = deriveCycleFacts({
      marketUnitPrice: money("100.00"),
      quantity: 1,
      netProceedsAmount: reason === "non-positive-net-proceeds" ? money("0.00") : money("94.70"),
      costBasisShareOfMarketBps: 7_200,
      costBasisDiscountPerUnitAmount: signedMoney("0.30"),
      observations: history,
      policy: policy(),
      upstreamFailure,
    });
    expect(result.dailyReturnHurdle.effectiveValue).toBe(0.005);
    expect(result.dailyReturnHurdle.effectiveValue).not.toBe(0);
    expect(result.diagnostics.hurdleReason).toBe(reason);
  });

  it("defaults when a signed discount makes effective cost non-positive", () => {
    const result = deriveCycleFacts({
      marketUnitPrice: money("1.00"),
      quantity: 1,
      netProceedsAmount: money("0.50"),
      costBasisShareOfMarketBps: 1_000,
      costBasisDiscountPerUnitAmount: signedMoney("1.00"),
      observations: observations(10, 28),
      policy: policy(),
    });
    expect(result.dailyReturnHurdle.effectiveValue).toBe(0.005);
    expect(result.diagnostics.hurdleReason).toBe("non-positive-cost");
  });

  it("rejects the fixed oracle's known omission mutants", () => {
    const expected = 0.007321664541748893;
    expect(expected).not.toBeCloseTo(0.007377183105534407, 12);
    expect(expected).not.toBeCloseTo(0.003179758508828245, 12);
    expect(expected).not.toBeCloseTo(0.00993654473523064, 12);
    expect(expected).not.toBeCloseTo(0.02782232525864579, 12);
  });
});
