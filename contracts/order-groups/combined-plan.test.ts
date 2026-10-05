import { describe, expect, it } from "vitest";
import {
  orderGroupCombinedPlanAcceptedCodec,
  orderGroupContractVersion,
  orderGroupFactRegistry,
  parseOrderGroupCombinedPlanAccepted,
} from "./index";

const fact = {
  contractVersion: "order-group-combined-plan/v1",
  requestId: "request-1",
  sourceGeneration: 0,
  draftKey: "draft-1",
  anchorShipmentId: "shp_01ARYZ6S41TSV4RRFFQ69G5FAV",
  anchorOrderId: "ord_01ARYZ6S41TSV4RRFFQ69G5FAV",
  proposedMemberOrderId: "ord_01ARYZ6S41TSV4RRFFQ69G5FAW",
  groupId: "ogr_01ARYZ6S41TSV4RRFFQ69G5FAV",
  quoteFingerprint: "quote-1",
  combinedPackagePlan: {
    packagePlanVersion: "synthetic/v1",
    packageCount: 1,
    packages: [
      {
        packageId: "package-1",
        mailpieceClass: "parcel",
        lengthInches: 7,
        widthInches: 5,
        heightInches: 2,
        weightOunces: 8,
        billableWeightOunces: 8,
        serviceLevel: "standard-parcel",
        productMeasureVersions: ["synthetic-measure/v1"],
      },
    ],
    letterEligibility: { eligible: false, reasons: ["parcel-required"] },
    postagePolicySnapshot: {
      policyVersion: "synthetic-policy/v1",
      parcelRequired: true,
      parcelReasons: ["parcel-required"],
      signatureRequired: false,
      signatureReasons: [],
      insuranceRequired: true,
      insuranceReasons: ["value"],
      insuredValueAmount: "600.00",
      shippingEvidenceTier: "carrier-insured",
    },
    missingProductIds: [],
  },
};

describe("Ordering accepted combined plan sibling contract", () => {
  it("round trips full admission identity and one closed package without changing the nine admission facts", () => {
    const data = parseOrderGroupCombinedPlanAccepted(fact);
    const event = { type: "ordering.order.combined-plan-accepted" as const, data };
    expect(orderGroupCombinedPlanAcceptedCodec.decode(orderGroupCombinedPlanAcceptedCodec.encode(event))).toEqual(
      event,
    );
    expect(Object.keys(orderGroupFactRegistry)).toHaveLength(9);
    expect(orderGroupContractVersion).toBe("order-group-admission/v1");
  });

  it.each([
    { ...fact, contractVersion: "order-group-admission/v1" },
    { ...fact, proposedMemberOrderId: fact.anchorOrderId },
    { ...fact, sourceGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...fact, extra: true },
    { ...fact, combinedPackagePlan: { ...fact.combinedPackagePlan, packageCount: 2 } },
    { ...fact, combinedPackagePlan: { ...fact.combinedPackagePlan, packages: [] } },
    { ...fact, combinedPackagePlan: { ...fact.combinedPackagePlan, postagePolicySnapshot: null } },
    { ...fact, combinedPackagePlan: { ...fact.combinedPackagePlan, missingProductIds: ["missing"] } },
    { ...fact, combinedPackagePlan: { ...fact.combinedPackagePlan, extra: true } },
    {
      ...fact,
      combinedPackagePlan: {
        ...fact.combinedPackagePlan,
        letterEligibility: { ...fact.combinedPackagePlan.letterEligibility, extra: true },
      },
    },
    {
      ...fact,
      combinedPackagePlan: {
        ...fact.combinedPackagePlan,
        postagePolicySnapshot: { ...fact.combinedPackagePlan.postagePolicySnapshot, extra: true },
      },
    },
    ...[0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "8"].map((weightOunces) => ({
      ...fact,
      combinedPackagePlan: {
        ...fact.combinedPackagePlan,
        packages: [{ ...fact.combinedPackagePlan.packages[0], weightOunces }],
      },
    })),
    ...["-1.00", "NaN", "600", "600.001", "9007199254740992.00"].map((insuredValueAmount) => ({
      ...fact,
      combinedPackagePlan: {
        ...fact.combinedPackagePlan,
        postagePolicySnapshot: { ...fact.combinedPackagePlan.postagePolicySnapshot, insuredValueAmount },
      },
    })),
  ])("rejects malformed or extended plan %#", (value) => {
    expect(() => parseOrderGroupCombinedPlanAccepted(value)).toThrow();
  });

  it("requires every field, including recursively closed packages", () => {
    for (const key of Object.keys(fact)) {
      const candidate: Record<string, unknown> = { ...fact };
      delete candidate[key];
      expect(() => parseOrderGroupCombinedPlanAccepted(candidate)).toThrow();
    }
    expect(() =>
      parseOrderGroupCombinedPlanAccepted({
        ...fact,
        combinedPackagePlan: {
          ...fact.combinedPackagePlan,
          packages: [{ ...fact.combinedPackagePlan.packages[0], extra: true }],
        },
      }),
    ).toThrow();
  });
});
