import { describe, expect, it } from "vitest";
import { addUtcMonths, evaluateSellerComplianceCohort } from "./cohort-window";
import {
  SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE,
  decodeSellerComplianceCohortPolicyValue,
  type SellerComplianceCohortPolicyValue,
} from "./seller-compliance-cohort-policy";

const policy: SellerComplianceCohortPolicyValue = {
  ...SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE,
  activated: true,
  currencyCode: "USD",
  qualifyingTransactionCount: 2,
  qualifyingGrossCents: "500000",
  disclosureGrossCents: "2000000",
  windowMonths: 1,
  lookbackMonths: 2,
  comparisonIsInclusive: true,
  saleUnit: "captured-order",
  qualifyingGrossBasis: "item-gross",
  refundTreatment: "exclude-refunded" as const,
  postCaptureCancellationTreatment: "exclude-cancelled" as const,
  mixedLineTreatment: "exclude-mixed" as const,
  unclassifiableTreatment: "exclude-unclassifiable" as const,
  classificationRules: [{ source: "productId", value: "card" }],
};

function sale(id: string, occurredAt: string, gross: string, overrides: Record<string, unknown> = {}) {
  return {
    paymentId: `pay-${id}`,
    orderId: `ord-${id}`,
    sellerAccountId: "seller",
    saleState: "captured" as const,
    occurredAt,
    currencyCode: "USD",
    itemGrossCents: gross,
    shippingChargeCents: "0",
    salesTaxCents: "0",
    authenticityFeeCents: "0",
    protectionCents: "0",
    orderTotalCents: gross,
    marketplaceSalesFeeCents: "0",
    sellerItemNetCents: gross,
    sellerPayoutCents: gross,
    refundedOrderTotalCents: null,
    orderRefundCapCents: null,
    cancelledAt: null,
    captureAnomalies: [],
    refundAnomalies: [],
    reconciliationMismatches: [],
    classificationInputs: [{ productId: "card" }],
    classificationInputsVersion: 1,
    changeSequence: "1",
    revision: "1",
    ...overrides,
  };
}

describe("seller compliance cohort window", () => {
  it("clamps UTC month arithmetic", () => {
    expect(addUtcMonths("2025-01-31T00:00:00.000Z", 1)).toBe("2025-02-28T00:00:00.000Z");
    expect(addUtcMonths("2024-01-31T00:00:00.000Z", 1)).toBe("2024-02-29T00:00:00.000Z");
    expect(addUtcMonths("2024-02-29T00:00:00.000Z", -12)).toBe("2023-02-28T00:00:00.000Z");
  });

  it("enters only at the exact transaction and gross edges", () => {
    const make = (count: number, amount: string) =>
      Array.from({ length: count }, (_, index) =>
        sale(String(index), `2025-01-${String((index % 20) + 1).padStart(2, "0")}T00:00:00.000Z`, amount),
      );
    const exact = evaluateSellerComplianceCohort({
      sales: make(200, "2500"),
      policy: { ...policy, qualifyingTransactionCount: 200, qualifyingGrossCents: "500000" },
      evaluationAt: "2025-01-31T00:00:00.000Z",
    });
    const belowCount = evaluateSellerComplianceCohort({
      sales: make(199, "2500"),
      policy: { ...policy, qualifyingTransactionCount: 200, qualifyingGrossCents: "500000" },
      evaluationAt: "2025-01-31T00:00:00.000Z",
    });
    const belowGross = evaluateSellerComplianceCohort({
      sales: [...make(199, "2500"), sale("gross-below", "2025-01-01T00:00:00.000Z", "2499")],
      policy: { ...policy, qualifyingTransactionCount: 200, qualifyingGrossCents: "500000" },
      evaluationAt: "2025-01-31T00:00:00.000Z",
    });
    const disclosureBelow = evaluateSellerComplianceCohort({
      sales: make(200, "9999"),
      policy: { ...policy, qualifyingTransactionCount: 200, qualifyingGrossCents: "500000" },
      evaluationAt: "2025-01-31T00:00:00.000Z",
    });
    const disclosureExact = evaluateSellerComplianceCohort({
      sales: make(200, "10000"),
      policy: { ...policy, qualifyingTransactionCount: 200, qualifyingGrossCents: "500000" },
      evaluationAt: "2025-01-31T00:00:00.000Z",
    });
    expect(exact.state).toBe("member");
    expect(belowCount.state).toBe("outside");
    expect(belowGross.state).toBe("outside");
    expect(exact.qualifyingGrossCents).toBe("500000");
    expect(disclosureBelow.band).toBe("none");
    expect(disclosureExact.band).toBe("disclosure");
  });

  it("rejects activated policy with unresolved interpretation", () => {
    expect(() => decodeSellerComplianceCohortPolicyValue({ ...policy, refundTreatment: null })).toThrow();
    expect(() => decodeSellerComplianceCohortPolicyValue({ ...policy, windowMonths: true })).toThrow();
    expect(() =>
      decodeSellerComplianceCohortPolicyValue({ ...policy, classificationRules: [{ source: "unknown", value: "x" }] }),
    ).toThrow();
    expect(() => decodeSellerComplianceCohortPolicyValue({ ...policy, lookbackMonths: 1, windowMonths: 2 })).toThrow();
    expect(() =>
      decodeSellerComplianceCohortPolicyValue({ ...policy, qualifyingGrossCents: "500", disclosureGrossCents: "499" }),
    ).toThrow();
    expect(() => decodeSellerComplianceCohortPolicyValue({ ...policy, refundTreatment: "count-cancelled" })).toThrow();
    expect(() =>
      decodeSellerComplianceCohortPolicyValue({ ...policy, mixedLineTreatment: "count-refunded" }),
    ).toThrow();
    expect(() =>
      decodeSellerComplianceCohortPolicyValue({ ...policy, unclassifiableTreatment: "count-mixed" }),
    ).toThrow();
  });

  it("pins every window and month-arithmetic edge in UTC", () => {
    expect(addUtcMonths("2025-03-31T00:00:00.000Z", -1)).toBe("2025-02-28T00:00:00.000Z");
    const edge = evaluateSellerComplianceCohort({
      sales: [sale("edge", "2025-01-20T00:00:00.000Z", "500000")],
      policy,
      evaluationAt: "2025-01-20T00:00:00.000Z",
    });
    const floor = evaluateSellerComplianceCohort({
      sales: [sale("floor", "2024-11-20T00:00:00.000Z", "500000")],
      policy: { ...policy, qualifyingTransactionCount: 1 },
      evaluationAt: "2025-01-20T00:00:00.000Z",
    });
    expect(edge.state).toBe("outside");
    expect(floor.state).toBe("member");
    const start = sale("start", "2025-01-01T00:00:00.000Z", "500000");
    const end = sale("end", "2025-02-01T00:00:00.000Z", "500000");
    expect(
      evaluateSellerComplianceCohort({
        sales: [start],
        policy: { ...policy, qualifyingTransactionCount: 1 },
        evaluationAt: "2025-02-01T00:00:00.000Z",
      }).state,
    ).toBe("member");
    expect(
      evaluateSellerComplianceCohort({
        sales: [end],
        policy: { ...policy, qualifyingTransactionCount: 1 },
        evaluationAt: "2025-02-01T00:00:00.000Z",
      }).state,
    ).toBe("outside");
    expect(
      evaluateSellerComplianceCohort({
        sales: [
          sale("window-start", "2025-01-01T00:00:00.000Z", "250000"),
          sale("window-end", "2025-02-01T00:00:00.000Z", "250000"),
        ],
        policy: { ...policy, qualifyingTransactionCount: 2 },
        evaluationAt: "2025-03-01T00:00:00.000Z",
      }).state,
    ).toBe("outside");
    expect(
      evaluateSellerComplianceCohort({
        sales: [sale("at", "2025-02-02T00:00:00.000Z", "500000")],
        policy: { ...policy, qualifyingTransactionCount: 1 },
        evaluationAt: "2025-02-02T00:00:00.000Z",
      }).state,
    ).toBe("outside");

    const previous = {
      state: "member" as const,
      band: "none" as const,
      entryEffectiveAt: "2025-01-15T00:00:00.000Z",
    };
    const sales = [
      sale("a", "2025-01-01T00:00:00.000Z", "250000"),
      sale("b", "2025-01-15T00:00:00.000Z", "250000"),
      sale("c", "2025-02-20T00:00:00.000Z", "1"),
    ];
    const onTime = evaluateSellerComplianceCohort({
      sales,
      policy,
      evaluationAt: "2025-03-05T00:00:00.000Z",
      previous,
    });
    const late = evaluateSellerComplianceCohort({ sales, policy, evaluationAt: "2025-03-10T00:00:00.000Z", previous });
    expect(onTime.exitEffectiveAt).toBe("2025-03-01T00:00:00.001Z");
    expect(late.exitEffectiveAt).toBe(onTime.exitEffectiveAt);
  });

  it("sale-anchored windows agree with an exhaustive sliding scan under shuffled input", () => {
    const sales = Array.from({ length: 200 }, (_, index) =>
      sale(String(index), `2024-${String((index % 12) + 1).padStart(2, "0")}-01T00:00:00.000Z`, "500000"),
    );
    const expected = evaluateSellerComplianceCohort({
      sales,
      policy: { ...policy, qualifyingTransactionCount: 2 },
      evaluationAt: "2025-01-01T00:00:00.000Z",
    });
    const brute = (at: string) => {
      const end = Date.parse(at);
      const floor = Date.parse(addUtcMonths(at, -2));
      const starts = sales.map((item) => Date.parse(item.occurredAt)).filter((start) => start >= floor && start < end);
      const winners = starts
        .flatMap((start) => {
          const windowEnd = Date.parse(addUtcMonths(new Date(start).toISOString(), 1));
          const qualifying = sales.filter(
            (item) => Date.parse(item.occurredAt) >= start && Date.parse(item.occurredAt) < windowEnd,
          );
          return qualifying.length >= 1 &&
            qualifying.reduce((sum, item) => sum + Number(item.sellerItemNetCents), 0) >= 500000
            ? [{ start, windowEnd, qualifying }]
            : [];
        })
        .filter((candidate) => candidate.start < end);
      return winners[0] ?? null;
    };
    expect(brute("2025-01-01T00:00:00.000Z")?.start).toBe(Date.parse(expected.entryEffectiveAt ?? ""));
    for (let i = 0; i < 10; i++) {
      const shuffled = [...sales].sort(
        (a, b) => ((i * 17 + Number(a.paymentId.slice(4))) % 31) - ((i * 17 + Number(b.paymentId.slice(4))) % 31),
      );
      expect(
        evaluateSellerComplianceCohort({
          sales: shuffled,
          policy: { ...policy, qualifyingTransactionCount: 1 },
          evaluationAt: "2025-01-01T00:00:00.000Z",
        }),
      ).toEqual(expected);
    }
  });

  it("counts only classified, reconciled, policy-currency sales", () => {
    const foreign = { ...sale("foreign", "2025-01-01T00:00:00.000Z", "500000"), currencyCode: "EUR" };
    const unreconciled = {
      ...sale("unreconciled", "2025-01-01T00:00:00.000Z", "500000"),
      reconciliationMismatches: [{ code: "x" }] as never,
    };
    const unclassified = {
      ...sale("unclassified", "2025-01-01T00:00:00.000Z", "500000"),
      classificationInputs: [{ productId: "other" }],
    };
    const result = evaluateSellerComplianceCohort({
      sales: [foreign, unreconciled, unclassified, sale("good", "2025-01-02T00:00:00.000Z", "500000")],
      policy: { ...policy, qualifyingTransactionCount: 2 },
      evaluationAt: "2025-01-03T00:00:00.000Z",
    });
    expect(result.state).toBe("outside");
    expect(result.unclassifiableCount).toBe(1);
    expect(
      evaluateSellerComplianceCohort({
        sales: [
          sale("cross-field", "2025-01-02T00:00:00.000Z", "500000", {
            classificationInputs: [{ productId: "option-1" }],
          }),
        ],
        policy: {
          ...policy,
          qualifyingTransactionCount: 1,
          classificationRules: [{ source: "selectedOptionId", value: "option-1" }],
        },
        evaluationAt: "2025-01-03T00:00:00.000Z",
      }).state,
    ).toBe("outside");
  });

  it("applies every interpretive treatment branch distinctly", () => {
    const refunded = {
      ...sale("refund", "2025-01-01T00:00:00.000Z", "500000"),
      refundedOrderTotalCents: "500000",
      orderRefundCapCents: "500000",
    };
    const excluded = evaluateSellerComplianceCohort({
      sales: [refunded],
      policy: { ...policy, qualifyingTransactionCount: 1 },
      evaluationAt: "2025-01-02T00:00:00.000Z",
    });
    const counted = evaluateSellerComplianceCohort({
      sales: [refunded],
      policy: { ...policy, qualifyingTransactionCount: 1, refundTreatment: "count-refunded" },
      evaluationAt: "2025-01-02T00:00:00.000Z",
    });
    expect(excluded.state).toBe("outside");
    expect(counted.state).toBe("member");

    const cancelled = {
      ...sale("cancelled", "2025-01-01T00:00:00.000Z", "500000"),
      cancelledAt: "2025-01-01T01:00:00.000Z",
    };
    expect(
      evaluateSellerComplianceCohort({
        sales: [cancelled],
        policy: { ...policy, qualifyingTransactionCount: 1, postCaptureCancellationTreatment: "exclude-cancelled" },
        evaluationAt: "2025-01-02T00:00:00.000Z",
      }).state,
    ).toBe("outside");
    expect(
      evaluateSellerComplianceCohort({
        sales: [cancelled],
        policy: {
          ...policy,
          qualifyingTransactionCount: 1,
          postCaptureCancellationTreatment: "exclude-if-fully-refunded",
        },
        evaluationAt: "2025-01-02T00:00:00.000Z",
      }).state,
    ).toBe("member");
    expect(
      evaluateSellerComplianceCohort({
        sales: [cancelled],
        policy: { ...policy, qualifyingTransactionCount: 1, postCaptureCancellationTreatment: "count-cancelled" },
        evaluationAt: "2025-01-02T00:00:00.000Z",
      }).state,
    ).toBe("member");

    const mixed = {
      ...sale("mixed", "2025-01-01T00:00:00.000Z", "500000"),
      classificationInputs: [{ productId: "card" }, { productId: "other" }],
    };
    expect(
      evaluateSellerComplianceCohort({
        sales: [mixed],
        policy: { ...policy, qualifyingTransactionCount: 1, mixedLineTreatment: "exclude-mixed" },
        evaluationAt: "2025-01-02T00:00:00.000Z",
      }).state,
    ).toBe("outside");
    expect(
      evaluateSellerComplianceCohort({
        sales: [mixed],
        policy: { ...policy, qualifyingTransactionCount: 1, mixedLineTreatment: "count-mixed" },
        evaluationAt: "2025-01-02T00:00:00.000Z",
      }).state,
    ).toBe("member");
    const unknown = {
      ...sale("unknown", "2025-01-01T00:00:00.000Z", "500000"),
      classificationInputs: [{ productId: "other" }],
    };
    expect(
      evaluateSellerComplianceCohort({
        sales: [unknown],
        policy: { ...policy, qualifyingTransactionCount: 1, unclassifiableTreatment: "exclude-unclassifiable" },
        evaluationAt: "2025-01-02T00:00:00.000Z",
      }).state,
    ).toBe("outside");
    expect(
      evaluateSellerComplianceCohort({
        sales: [unknown],
        policy: { ...policy, qualifyingTransactionCount: 1, unclassifiableTreatment: "count-unclassifiable" },
        evaluationAt: "2025-01-02T00:00:00.000Z",
      }).state,
    ).toBe("member");
  });

  it("expires on the first inadmissible instant after the due chain", () => {
    const previous = { state: "member" as const, band: "none" as const, entryEffectiveAt: "2025-01-15T00:00:00.000Z" };
    const result = evaluateSellerComplianceCohort({
      sales: [sale("a", "2025-01-01T00:00:00.000Z", "250000"), sale("b", "2025-01-15T00:00:00.000Z", "250000")],
      policy,
      evaluationAt: "2025-03-15T00:00:00.000Z",
      previous,
    });
    expect(result.exitEffectiveAt).toBe("2025-03-01T00:00:00.001Z");
    expect(result.nextReevaluationAt).toBeNull();
  });

  it("stamps a revision-only exit at the revision instant", () => {
    const result = evaluateSellerComplianceCohort({
      sales: [sale("a", "2025-01-01T00:00:00.000Z", "250000"), sale("b", "2025-01-15T00:00:00.000Z", "250000")],
      policy: { ...policy, qualifyingGrossCents: "1000000" },
      evaluationAt: "2025-02-10T00:00:00.000Z",
      previous: { state: "member", band: "none", entryEffectiveAt: "2025-01-15T00:00:00.000Z" },
      revisionEffectiveAt: "2025-02-10T00:00:00.000Z",
    });
    expect(result.state).toBe("outside");
    expect(result.exitEffectiveAt).toBe("2025-02-10T00:00:00.000Z");
  });
});
