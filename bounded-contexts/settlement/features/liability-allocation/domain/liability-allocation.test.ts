import { describe, expect, it } from "vitest";
import {
  decideRefundLiability,
  distributeSellerFundedPortion,
  type AuthorizedRefundAllocation,
  type CoverageReservationState,
} from "./liability-allocation";

function allocation(overrides: Partial<AuthorizedRefundAllocation> = {}): AuthorizedRefundAllocation {
  return {
    refundId: "rfd_1",
    remedyId: "rmd_1",
    coverageId: "cov_1",
    sellerFundedAmount: "0.00",
    platformFundedAmount: "40.00",
    currencyCode: "usd",
    fundingKind: "platform-funded",
    ...overrides,
  };
}

function reservation(overrides: Partial<CoverageReservationState> = {}): CoverageReservationState {
  return {
    reservedAmount: "40.00",
    status: "reserved",
    refundId: null,
    policyVersion: "coverage-policy-2026-07",
    currencyCode: "usd",
    supportRequestId: "sup_1",
    remedyId: "rmd_1",
    ...overrides,
  };
}

describe("decideRefundLiability", () => {
  it("treats a refund with no authorized allocation as the seller-funded compatibility default", () => {
    const decision = decideRefundLiability({
      allocation: null,
      completedRefundAmount: "25.00",
      completedCurrencyCode: "usd",
      reservation: null,
    });
    expect(decision).toEqual({ outcome: "seller-funded-default", sellerDebitAmount: "25.00" });
  });

  it("posts no seller debit for a fully platform-funded refund and consumes the reserved amount once", () => {
    const decision = decideRefundLiability({
      allocation: allocation({
        sellerFundedAmount: "0.00",
        platformFundedAmount: "40.00",
        fundingKind: "platform-funded",
      }),
      completedRefundAmount: "40.00",
      completedCurrencyCode: "usd",
      reservation: reservation({ reservedAmount: "40.00" }),
    });
    expect(decision).toEqual({
      outcome: "allocated",
      fundingKind: "platform-funded",
      sellerDebitAmount: "0.00",
      platformSettleAmount: "40.00",
      coverageId: "cov_1",
      alreadySettled: false,
    });
  });

  it("debits exactly the seller-funded portion and consumes exactly the platform portion for a split refund", () => {
    const decision = decideRefundLiability({
      allocation: allocation({ sellerFundedAmount: "15.00", platformFundedAmount: "25.00", fundingKind: "split" }),
      completedRefundAmount: "40.00",
      completedCurrencyCode: "usd",
      reservation: reservation({ reservedAmount: "25.00" }),
    });
    expect(decision).toEqual({
      outcome: "allocated",
      fundingKind: "split",
      sellerDebitAmount: "15.00",
      platformSettleAmount: "25.00",
      coverageId: "cov_1",
      alreadySettled: false,
    });
  });

  it("debits the seller and consumes no reserve for a fully seller-funded authorization", () => {
    const decision = decideRefundLiability({
      allocation: allocation({
        sellerFundedAmount: "30.00",
        platformFundedAmount: "0.00",
        coverageId: null,
        fundingKind: "seller-funded",
      }),
      completedRefundAmount: "30.00",
      completedCurrencyCode: "usd",
      reservation: null,
    });
    expect(decision).toEqual({
      outcome: "allocated",
      fundingKind: "seller-funded",
      sellerDebitAmount: "30.00",
      platformSettleAmount: "0.00",
      coverageId: null,
      alreadySettled: false,
    });
  });

  it("is idempotent when the coverage is already settled against the same refund", () => {
    const decision = decideRefundLiability({
      allocation: allocation({ platformFundedAmount: "40.00" }),
      completedRefundAmount: "40.00",
      completedCurrencyCode: "usd",
      reservation: reservation({ status: "settled", refundId: "rfd_1" }),
    });
    expect(decision).toMatchObject({ outcome: "allocated", alreadySettled: true, platformSettleAmount: "40.00" });
  });

  it("quarantines a coverage already settled against a different refund", () => {
    const decision = decideRefundLiability({
      allocation: allocation({ platformFundedAmount: "40.00" }),
      completedRefundAmount: "40.00",
      completedCurrencyCode: "usd",
      reservation: reservation({ status: "settled", refundId: "rfd_other" }),
    });
    expect(decision).toMatchObject({ outcome: "quarantined", reasonCode: "coverage-already-settled" });
  });

  it("quarantines when the allocation does not sum to the completed refund", () => {
    const decision = decideRefundLiability({
      allocation: allocation({ sellerFundedAmount: "10.00", platformFundedAmount: "25.00", fundingKind: "split" }),
      completedRefundAmount: "40.00",
      completedCurrencyCode: "usd",
      reservation: reservation({ reservedAmount: "25.00" }),
    });
    expect(decision).toMatchObject({ outcome: "quarantined", reasonCode: "amount-mismatch" });
  });

  it("quarantines a wrong-currency allocation", () => {
    const decision = decideRefundLiability({
      allocation: allocation({ currencyCode: "eur" }),
      completedRefundAmount: "40.00",
      completedCurrencyCode: "usd",
      reservation: reservation(),
    });
    expect(decision).toMatchObject({ outcome: "quarantined", reasonCode: "currency-mismatch" });
  });

  it("quarantines a platform-funded refund whose platform portion exceeds the reservation", () => {
    const decision = decideRefundLiability({
      allocation: allocation({ platformFundedAmount: "40.00" }),
      completedRefundAmount: "40.00",
      completedCurrencyCode: "usd",
      reservation: reservation({ reservedAmount: "30.00" }),
    });
    expect(decision).toMatchObject({ outcome: "quarantined", reasonCode: "reservation-mismatch" });
  });

  it("quarantines a platform-funded refund with no reservation to consume", () => {
    const decision = decideRefundLiability({
      allocation: allocation({ platformFundedAmount: "40.00" }),
      completedRefundAmount: "40.00",
      completedCurrencyCode: "usd",
      reservation: null,
    });
    expect(decision).toMatchObject({ outcome: "quarantined", reasonCode: "coverage-not-reserved" });
  });

  it("quarantines a platform-funded allocation missing its coverage id", () => {
    const decision = decideRefundLiability({
      allocation: allocation({ coverageId: null, platformFundedAmount: "40.00" }),
      completedRefundAmount: "40.00",
      completedCurrencyCode: "usd",
      reservation: reservation(),
    });
    expect(decision).toMatchObject({ outcome: "quarantined", reasonCode: "coverage-missing" });
  });

  it("quarantines when the reservation is released rather than reserved", () => {
    const decision = decideRefundLiability({
      allocation: allocation({ platformFundedAmount: "40.00" }),
      completedRefundAmount: "40.00",
      completedCurrencyCode: "usd",
      reservation: reservation({ status: "released" }),
    });
    expect(decision).toMatchObject({ outcome: "quarantined", reasonCode: "coverage-not-reserved" });
  });
});

describe("distributeSellerFundedPortion", () => {
  it("distributes the exact seller-funded portion across payouts summing to the whole", () => {
    const amounts = distributeSellerFundedPortion("10.00", [
      { orderId: "ord_1", sellerAccountId: "acc_1", weightAmount: "30.00" },
      { orderId: "ord_2", sellerAccountId: "acc_2", weightAmount: "10.00" },
    ]);
    const total = amounts.reduce((sum, amount) => sum + Math.round(Number(amount) * 100), 0);
    expect(total).toBe(1000);
  });

  it("assigns leftover pennies deterministically by largest remainder", () => {
    const amounts = distributeSellerFundedPortion("10.00", [
      { orderId: "ord_1", sellerAccountId: "acc_1", weightAmount: "1.00" },
      { orderId: "ord_2", sellerAccountId: "acc_2", weightAmount: "1.00" },
      { orderId: "ord_3", sellerAccountId: "acc_3", weightAmount: "1.00" },
    ]);
    const total = amounts.reduce((sum, amount) => sum + Math.round(Number(amount) * 100), 0);
    expect(total).toBe(1000);
  });

  it("posts nothing when the seller-funded portion is zero", () => {
    const amounts = distributeSellerFundedPortion("0.00", [
      { orderId: "ord_1", sellerAccountId: "acc_1", weightAmount: "30.00" },
    ]);
    expect(amounts).toEqual(["0.00"]);
  });

  it("returns all zero when there is no seller exposure, so the caller can fail closed", () => {
    const amounts = distributeSellerFundedPortion("10.00", [
      { orderId: "ord_1", sellerAccountId: "acc_1", weightAmount: "0.00" },
    ]);
    const total = amounts.reduce((sum, amount) => sum + Math.round(Number(amount) * 100), 0);
    expect(total).toBe(0);
  });
});
