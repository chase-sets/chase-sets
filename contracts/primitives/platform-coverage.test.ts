import { describe, expect, it } from "vitest";
import {
  buyerRemedyKinds,
  classifyLiabilityFundingKind,
  coverageRejectionReasonCodes,
  isRefundTrigger,
  isReturnDirective,
  normalizeBuyerRemedy,
  normalizeLiabilityAllocation,
  normalizeLiabilityAllocationForRemedy,
  refundTriggers,
  returnDirectives,
} from "./platform-coverage";

describe("platform-coverage vocabularies", () => {
  it("keeps the four decisions orthogonal and closed", () => {
    expect(returnDirectives).toStrictEqual(["return-to-seller", "return-to-platform", "no-return"]);
    expect(refundTriggers).toStrictEqual([
      "immediate",
      "carrier-accepted",
      "delivered",
      "facility-intake",
      "operator-release",
    ]);
    expect(buyerRemedyKinds).toStrictEqual(["full-refund", "partial-refund"]);
    expect(coverageRejectionReasonCodes).toContain("insufficient-reserve");
  });

  it("distinguishes return destination from refund timing", () => {
    // return-to-platform is a valid destination but never a refund trigger.
    expect(isReturnDirective("return-to-platform")).toBe(true);
    expect(isRefundTrigger("return-to-platform")).toBe(false);
    expect(isRefundTrigger("facility-intake")).toBe(true);
    expect(isReturnDirective("facility-intake")).toBe(false);
  });
});

describe("normalizeBuyerRemedy", () => {
  it("canonicalizes a positive remedy", () => {
    expect(normalizeBuyerRemedy({ kind: "full-refund", amount: "10", currencyCode: "USD" })).toStrictEqual({
      kind: "full-refund",
      amount: "10.00",
      currencyCode: "usd",
    });
  });

  it("rejects a zero or negative remedy", () => {
    expect(() => normalizeBuyerRemedy({ kind: "partial-refund", amount: "0", currencyCode: "usd" })).toThrow();
    expect(() => normalizeBuyerRemedy({ kind: "full-refund", amount: "-1.00", currencyCode: "usd" })).toThrow();
  });

  it("rejects an unknown remedy kind or malformed currency", () => {
    expect(() =>
      normalizeBuyerRemedy({ kind: "store-credit" as never, amount: "5.00", currencyCode: "usd" }),
    ).toThrow();
    expect(() => normalizeBuyerRemedy({ kind: "full-refund", amount: "5.00", currencyCode: "dollars" })).toThrow();
  });
});

describe("classifyLiabilityFundingKind", () => {
  it("derives the closed funding taxonomy from the components", () => {
    expect(classifyLiabilityFundingKind(500n, 0n)).toBe("seller-funded");
    expect(classifyLiabilityFundingKind(0n, 500n)).toBe("platform-funded");
    expect(classifyLiabilityFundingKind(200n, 300n)).toBe("split");
    // Degenerate both-zero classifies as seller-funded (no reserve consumed).
    expect(classifyLiabilityFundingKind(0n, 0n)).toBe("seller-funded");
  });

  it("rejects negative components", () => {
    expect(() => classifyLiabilityFundingKind(-1n, 0n)).toThrow();
  });
});

describe("normalizeLiabilityAllocationForRemedy", () => {
  const remedy = normalizeBuyerRemedy({ kind: "full-refund", amount: "10.00", currencyCode: "usd" });

  it("accepts a fully platform-funded allocation and labels it", () => {
    const allocation = normalizeLiabilityAllocationForRemedy(remedy, {
      sellerFundedAmount: "0.00",
      platformFundedAmount: "10.00",
      currencyCode: "usd",
    });
    expect(allocation).toStrictEqual({
      sellerFundedAmount: "0.00",
      platformFundedAmount: "10.00",
      currencyCode: "usd",
      fundingKind: "platform-funded",
    });
  });

  it("accepts a split allocation whose components sum to the remedy", () => {
    const allocation = normalizeLiabilityAllocationForRemedy(remedy, {
      sellerFundedAmount: "4.00",
      platformFundedAmount: "6.00",
      currencyCode: "usd",
    });
    expect(allocation.fundingKind).toBe("split");
  });

  it("rejects an allocation that does not sum to the remedy", () => {
    expect(() =>
      normalizeLiabilityAllocationForRemedy(remedy, {
        sellerFundedAmount: "4.00",
        platformFundedAmount: "5.00",
        currencyCode: "usd",
      }),
    ).toThrow(/sum exactly/);
  });

  it("rejects a currency mismatch between allocation and remedy", () => {
    expect(() =>
      normalizeLiabilityAllocationForRemedy(remedy, {
        sellerFundedAmount: "0.00",
        platformFundedAmount: "10.00",
        currencyCode: "eur",
      }),
    ).toThrow(/currency/);
  });

  it("rejects negative components", () => {
    expect(() =>
      normalizeLiabilityAllocation({ sellerFundedAmount: "-1.00", platformFundedAmount: "0.00", currencyCode: "usd" }),
    ).toThrow();
  });
});
