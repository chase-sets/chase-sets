import { describe, expect, it } from "vitest";
import { parseAdmissionIdentity, parseOrderGroupCombinedPlanAccepted } from "@chase-sets/order-groups";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { PackagePlan } from "@chase-sets/product-measures";
import { initialFulfillmentShipmentState } from "./domain";
import { combinedPostagePlan, physicalDestinationsEqual, shipmentGroupPostageKey } from "./combined-plan";

const combinedPlanFixture: PackagePlan = {
  packagePlanVersion: "synthetic/v1",
  packageCount: 1,
  missingProductIds: [],
  letterEligibility: { eligible: false, reasons: [] },
  packages: [
    {
      packageId: "synthetic-package",
      mailpieceClass: "parcel",
      serviceLevel: "standard-parcel",
      lengthInches: 7,
      widthInches: 5,
      heightInches: 2,
      weightOunces: 8,
      billableWeightOunces: 8,
      productMeasureVersions: ["synthetic-measures/v1"],
    },
  ],
  postagePolicySnapshot: {
    policyVersion: "synthetic/v1",
    parcelRequired: true,
    parcelReasons: [],
    signatureRequired: false,
    signatureReasons: [],
    insuranceRequired: false,
    insuranceReasons: [],
    insuredValueAmount: null,
    shippingEvidenceTier: "tracked-parcel",
  },
};

function fixture(anchorValue = "200.00", memberValue = "400.00") {
  const identity = parseAdmissionIdentity({
    requestId: "request",
    sourceGeneration: 0,
    draftKey: "draft",
    anchorShipmentId: createId("shp"),
    anchorOrderId: createId("ord"),
    proposedMemberOrderId: createId("ord"),
    groupId: createId("ogr"),
    quoteFingerprint: "quote",
  });
  const insured = (value: string): PackagePlan => ({
    ...combinedPlanFixture,
    postagePolicySnapshot: {
      ...combinedPlanFixture.postagePolicySnapshot!,
      insuranceRequired: true,
      insuredValueAmount: value,
    },
  });
  const anchor = {
    ...initialFulfillmentShipmentState,
    orderId: identity.anchorOrderId,
    itemSubtotalAmount: anchorValue,
    shippingPlanSnapshot: insured(anchorValue),
  };
  const member = {
    ...initialFulfillmentShipmentState,
    orderId: identity.proposedMemberOrderId,
    itemSubtotalAmount: memberValue,
    shippingPlanSnapshot: insured(memberValue),
    combinedPlanAccepted: parseOrderGroupCombinedPlanAccepted({
      ...identity,
      contractVersion: "order-group-combined-plan/v1",
      combinedPackagePlan: combinedPlanFixture,
    }),
  };
  return { identity, anchor, member };
}

describe("accepted combined postage plan", () => {
  it("no underinsurance: adds 200 + 400, not max or anchor-only", () => {
    const f = fixture();
    expect(combinedPostagePlan(f.anchor, f.member, f.identity).insuranceAmount).toBe("600.00");
  });
  it("no underinsurance: required 300 plus uninsured subtotal 300 covers both", () => {
    const f = fixture("300.00", "300.00");
    expect(
      combinedPostagePlan(f.anchor, { ...f.member, shippingPlanSnapshot: combinedPlanFixture }, f.identity)
        .insuranceAmount,
    ).toBe("600.00");
  });
  it("does not count the combined minimum as a third member", () => {
    const f = fixture();
    const accepted = parseOrderGroupCombinedPlanAccepted({
      ...f.member.combinedPlanAccepted,
      combinedPackagePlan: {
        ...combinedPlanFixture,
        postagePolicySnapshot: {
          ...combinedPlanFixture.postagePolicySnapshot!,
          insuranceRequired: true,
          insuredValueAmount: "600.00",
        },
      },
    });
    expect(
      combinedPostagePlan(f.anchor, { ...f.member, combinedPlanAccepted: accepted }, f.identity).insuranceAmount,
    ).toBe("600.00");
    expect(() =>
      combinedPostagePlan(
        f.anchor,
        {
          ...f.member,
          combinedPlanAccepted: {
            ...accepted,
            combinedPackagePlan: {
              ...accepted.combinedPackagePlan,
              postagePolicySnapshot: {
                ...accepted.combinedPackagePlan.postagePolicySnapshot,
                insuredValueAmount: "700.00",
              },
            },
          },
        },
        f.identity,
      ),
    ).toThrow(/envelope/);
  });
  it.each([null, "", "300", "-1.00", "USD 300.00", "NaN", "9007199254740992.00"])(
    "fails closed on missing or malformed member value %s",
    (itemSubtotalAmount) => {
      const f = fixture();
      expect(() => combinedPostagePlan({ ...f.anchor, itemSubtotalAmount }, f.member, f.identity)).toThrow();
    },
  );
  it("refuses unbound plans, unevidenced signature and differing caller parcels", () => {
    const f = fixture();
    expect(() => combinedPostagePlan(f.anchor, { ...f.member, combinedPlanAccepted: null }, f.identity)).toThrow();
    expect(() => combinedPostagePlan(f.anchor, f.member, { ...f.identity, quoteFingerprint: "other" })).toThrow();
    expect(() =>
      combinedPostagePlan(
        {
          ...f.anchor,
          shippingPlanSnapshot: {
            ...combinedPlanFixture,
            postagePolicySnapshot: { ...combinedPlanFixture.postagePolicySnapshot!, signatureRequired: true },
          },
        },
        f.member,
        f.identity,
      ),
    ).toThrow(/signature/);
    const parcel = combinedPostagePlan(f.anchor, f.member, f.identity).parcel;
    expect(() => combinedPostagePlan(f.anchor, f.member, f.identity, { ...parcel, weightOunces: 9 })).toThrow(
      /Caller parcel/,
    );
    expect(() => combinedPostagePlan(f.anchor, f.member, f.identity, parcel, "Priority")).toThrow(/envelope/);
  });
  it("no mismatch bypass: compares every physical field, excluding email and verification", () => {
    const address = {
      name: "Buyer",
      company: "Shop",
      line1: "1 Main",
      line2: "Unit 2",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
      phone: "5551234567",
      email: "one@example.test",
    };
    expect(
      physicalDestinationsEqual(address, {
        ...address,
        email: "two@example.test",
        verification: { status: "verified", source: "synthetic", checkedAt: "2026-10-05T00:00:00Z" },
      }),
    ).toBe(true);
    for (const key of ["name", "company", "line1", "line2", "city", "state", "postalCode", "country", "phone"])
      expect(physicalDestinationsEqual(address, { ...address, [key]: "different" })).toBe(false);
    expect(physicalDestinationsEqual(address, { ...address, name: " Buyer ", country: "us" })).toBe(true);
  });
  it("freezes operation identity independently of current stream version and caller retry IDs", () => {
    const f = fixture();
    const input = {
      tenantId: "tnt_synthetic",
      group: {
        shipmentGroupId: createId("shg"),
        identity: f.identity,
        memberShipmentId: createId("shp"),
        committedVersion: 3,
        disposition: "combined" as const,
        dispositionVersion: 4,
      },
      subjectId: f.identity.anchorShipmentId,
      operationKind: "purchase-usps-label" as const,
      labelGeneration: 0,
    };
    const key = shipmentGroupPostageKey(input);
    expect(key).toMatch(/^shipment-group-postage:v1:[a-f0-9]{64}$/);
    expect(shipmentGroupPostageKey({ ...input, group: { ...input.group } })).toBe(key);
    expect(shipmentGroupPostageKey({ ...input, labelGeneration: 9 })).not.toBe(key);
    expect(shipmentGroupPostageKey({ ...input, tenantId: "tnt_other" })).not.toBe(key);
    expect(shipmentGroupPostageKey({ ...input, subjectId: input.group.memberShipmentId })).not.toBe(key);
  });
});
