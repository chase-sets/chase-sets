import { describe, expect, it } from "vitest";
import { normalizeRefundCausation, refundCausationsEqual, refundIdForRemedy } from "./causation";

const platformAllocation = {
  sellerFundedAmount: "0.00",
  platformFundedAmount: "10.00",
  currencyCode: "usd",
  fundingKind: "platform-funded" as const,
};

const sellerAllocation = {
  sellerFundedAmount: "10.00",
  platformFundedAmount: "0.00",
  currencyCode: "usd",
  fundingKind: "seller-funded" as const,
};

const splitAllocation = {
  sellerFundedAmount: "4.00",
  platformFundedAmount: "6.00",
  currencyCode: "usd",
  fundingKind: "split" as const,
};

describe("refund causation", () => {
  it("normalizes a platform-funded causation and keeps its coverage reference", () => {
    const causation = normalizeRefundCausation(
      {
        remedyId: "rmd_1",
        coverageId: "cov_1",
        allocation: platformAllocation,
        reasonCode: "goodwill-coverage",
        refundTrigger: "immediate",
        refundTriggerEvidenceRef: "fct_release",
        policyVersion: "policy_1",
      },
      "10.00",
      "usd",
    );

    expect(causation).toEqual({
      remedyId: "rmd_1",
      coverageId: "cov_1",
      allocation: {
        sellerFundedAmount: "0.00",
        platformFundedAmount: "10.00",
        currencyCode: "usd",
        fundingKind: "platform-funded",
      },
      reasonCode: "goodwill-coverage",
      refundTrigger: "immediate",
      refundTriggerEvidenceRef: "fct_release",
      policyVersion: "policy_1",
    });
  });

  it("normalizes a seller-funded causation with no coverage reference", () => {
    const causation = normalizeRefundCausation(
      { remedyId: "rmd_2", allocation: sellerAllocation, reasonCode: "seller-fault", refundTrigger: "delivered" },
      "10.00",
      "usd",
    );

    expect(causation.coverageId).toBeNull();
    expect(causation.allocation.fundingKind).toBe("seller-funded");
    expect(causation.refundTriggerEvidenceRef).toBeNull();
    expect(causation.policyVersion).toBeNull();
  });

  it("normalizes a split allocation that sums to the refund amount", () => {
    const causation = normalizeRefundCausation(
      {
        remedyId: "rmd_3",
        coverageId: "cov_3",
        allocation: splitAllocation,
        reasonCode: "shared",
        refundTrigger: "immediate",
      },
      "10.00",
      "usd",
    );

    expect(causation.allocation.fundingKind).toBe("split");
    expect(causation.coverageId).toBe("cov_3");
  });

  it("rejects a platform-funded causation missing its approved coverage reference", () => {
    expect(() =>
      normalizeRefundCausation(
        { remedyId: "rmd_4", allocation: platformAllocation, reasonCode: "goodwill", refundTrigger: "immediate" },
        "10.00",
        "usd",
      ),
    ).toThrow("A platform-funded refund requires an approved coverage reference.");
  });

  it("rejects a seller-funded causation carrying a coverage reference", () => {
    expect(() =>
      normalizeRefundCausation(
        {
          remedyId: "rmd_5",
          coverageId: "cov_5",
          allocation: sellerAllocation,
          reasonCode: "seller",
          refundTrigger: "immediate",
        },
        "10.00",
        "usd",
      ),
    ).toThrow("A seller-funded refund must not carry a coverage reference.");
  });

  it("rejects an allocation whose components do not sum to the refund amount", () => {
    expect(() =>
      normalizeRefundCausation(
        {
          remedyId: "rmd_6",
          coverageId: "cov_6",
          allocation: platformAllocation,
          reasonCode: "goodwill",
          refundTrigger: "immediate",
        },
        "9.00",
        "usd",
      ),
    ).toThrow("Refund causation allocation must sum exactly to the refund amount.");
  });

  it("rejects an allocation whose currency differs from the refund currency", () => {
    expect(() =>
      normalizeRefundCausation(
        {
          remedyId: "rmd_7",
          coverageId: "cov_7",
          allocation: { ...platformAllocation, currencyCode: "eur" },
          reasonCode: "goodwill",
          refundTrigger: "immediate",
        },
        "10.00",
        "usd",
      ),
    ).toThrow("Refund causation currency must match the refund currency.");
  });

  it("rejects a declared funding kind that disagrees with its components", () => {
    expect(() =>
      normalizeRefundCausation(
        {
          remedyId: "rmd_8",
          coverageId: "cov_8",
          allocation: { ...platformAllocation, fundingKind: "seller-funded" },
          reasonCode: "goodwill",
          refundTrigger: "immediate",
        },
        "10.00",
        "usd",
      ),
    ).toThrow("Refund causation funding kind disagrees with its allocation components.");
  });

  it("rejects an unknown refund trigger", () => {
    expect(() =>
      normalizeRefundCausation(
        { remedyId: "rmd_9", allocation: sellerAllocation, reasonCode: "seller", refundTrigger: "whenever" },
        "10.00",
        "usd",
      ),
    ).toThrow("Unknown refund trigger: whenever");
  });

  it("derives a stable refund id from the remedy id, independent of request timing", () => {
    expect(refundIdForRemedy("rmd_01ABC")).toBe("rfd_01ABC");
    expect(refundIdForRemedy("rmd_01ABC")).toBe(refundIdForRemedy("rmd_01ABC"));
  });

  it("treats structurally identical causations as equal and different ones as unequal", () => {
    const build = (reasonCode: string) =>
      normalizeRefundCausation(
        {
          remedyId: "rmd_10",
          coverageId: "cov_10",
          allocation: platformAllocation,
          reasonCode,
          refundTrigger: "immediate",
        },
        "10.00",
        "usd",
      );

    expect(refundCausationsEqual(build("a"), build("a"))).toBe(true);
    expect(refundCausationsEqual(build("a"), build("b"))).toBe(false);
    expect(refundCausationsEqual(null, null)).toBe(true);
    expect(refundCausationsEqual(build("a"), null)).toBe(false);
  });
});
