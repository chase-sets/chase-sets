import { describe, expect, it } from "vitest";
import { addUtcMonths, evaluateSellerComplianceCohort } from "./cohort-window";
import {
  SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE,
  decodeSellerComplianceCohortPolicyValue,
} from "./seller-compliance-cohort-policy";

const policy = {
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
    const result = evaluateSellerComplianceCohort({
      sales: [sale("a", "2025-01-01T00:00:00.000Z", "250000"), sale("b", "2025-01-15T00:00:00.000Z", "250000")],
      policy,
      evaluationAt: "2025-01-20T00:00:00.000Z",
    });
    expect(result.state).toBe("member");
    expect(result.qualifyingGrossCents).toBe("500000");
  });

  it("rejects activated policy with unresolved interpretation", () => {
    expect(() => decodeSellerComplianceCohortPolicyValue({ ...policy, refundTreatment: null })).toThrow();
  });
});
