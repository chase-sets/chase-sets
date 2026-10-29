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

function sale(id: string, occurredAt: string, gross: string) {
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
  };
}

describe("seller compliance cohort window", () => {
  it("clamps UTC month arithmetic", () => {
    expect(addUtcMonths("2025-01-31T00:00:00.000Z", 1)).toBe("2025-02-28T00:00:00.000Z");
    expect(addUtcMonths("2024-01-31T00:00:00.000Z", 1)).toBe("2024-02-29T00:00:00.000Z");
    expect(addUtcMonths("2024-02-29T00:00:00.000Z", -12)).toBe("2023-02-28T00:00:00.000Z");
  });

  it("enters only at inclusive count and gross edges", () => {
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
    expect(exact.state).toBe("member");
    expect(belowCount.state).toBe("outside");
    expect(belowGross.state).toBe("outside");
    expect(exact.qualifyingGrossCents).toBe("500000");
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
  });

  it("pins every window and month-arithmetic edge in UTC", () => {
    expect(addUtcMonths("2025-03-31T00:00:00.000Z", -1)).toBe("2025-02-28T00:00:00.000Z");
    const edge = evaluateSellerComplianceCohort({
      sales: [sale("edge", "2025-01-20T00:00:00.000Z", "500000")],
      policy,
      evaluationAt: "2025-01-20T00:00:00.000Z",
    });
    expect(edge.state).toBe("outside");
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
  });

  it("sale-anchored windows agree with an exhaustive sliding scan under shuffled input", () => {
    const sales = Array.from({ length: 200 }, (_, index) =>
      sale(String(index), `2024-${String((index % 12) + 1).padStart(2, "0")}-01T00:00:00.000Z`, "250000"),
    );
    const expected = evaluateSellerComplianceCohort({
      sales,
      policy: { ...policy, qualifyingTransactionCount: 1 },
      evaluationAt: "2025-01-01T00:00:00.000Z",
    });
    expect(
      evaluateSellerComplianceCohort({
        sales: [...sales].reverse(),
        policy: { ...policy, qualifyingTransactionCount: 2 },
        evaluationAt: "2025-01-01T00:00:00.000Z",
      }),
    ).toEqual(expected);
  });

  it("counts only classified, reconciled, policy-currency sales", () => {
    const foreign = { ...sale("foreign", "2025-01-01T00:00:00.000Z", "500000"), currencyCode: "EUR" };
    const result = evaluateSellerComplianceCohort({
      sales: [foreign, sale("good", "2025-01-02T00:00:00.000Z", "500000")],
      policy: { ...policy, qualifyingTransactionCount: 1 },
      evaluationAt: "2025-01-03T00:00:00.000Z",
    });
    expect(result.qualifyingCount).toBe(1);
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
  });
});
