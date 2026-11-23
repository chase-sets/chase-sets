import { describe, expect, it } from "vitest";
import {
  buildPackagePlan,
  defaultPostagePolicy,
  type PostagePolicy,
  type ProductMeasureSnapshot,
  type ProductPhysicalFlag,
} from "./index";

const rawCardMeasure: ProductMeasureSnapshot = {
  catalogItemId: "cat_card",
  productId: "cat_card::raw",
  selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
  measureVersion: "pokemon-raw-card:v1",
  unitLengthInches: 3.5,
  unitWidthInches: 2.5,
  unitHeightInches: 0.012,
  unitWeightOunces: 0.064,
  physicalFlags: ["bendable"],
  stackBehavior: "stackable-thickness",
  source: "profile",
  confidence: "conservative-estimate",
};

const slabMeasure: ProductMeasureSnapshot = {
  ...rawCardMeasure,
  productId: "cat_card::graded",
  measureVersion: "psa-slab:v1",
  unitLengthInches: 5.375,
  unitWidthInches: 3.25,
  unitHeightInches: 0.375,
  unitWeightOunces: 2.4,
  physicalFlags: ["rigid"],
};

// Stored measures and policies can still carry the product kinds that were once Physical Flags.
function storedFlags(...flags: string[]) {
  return flags as ProductPhysicalFlag[];
}

const storedPolicyThatNamesKinds: Partial<PostagePolicy> = {
  policyVersion: "default-postage-policy-v2",
  letterRequiredPhysicalFlags: storedFlags("raw-card"),
  parcelRequiredPhysicalFlags: storedFlags("slab", "sealed", "rigid", "metal", "jumbo", "irregular"),
};

function planOneWithinLetterLimits(
  physicalFlags: readonly ProductPhysicalFlag[],
  postagePolicy?: Partial<PostagePolicy>,
) {
  return buildPackagePlan({
    shippingOption: "standard",
    itemSubtotalAmount: "12.00",
    lines: [{ productId: rawCardMeasure.productId, quantity: 1, measure: { ...rawCardMeasure, physicalFlags } }],
    postagePolicy,
  });
}

describe("measured package planning", () => {
  it("selects letter mail for low-value raw singles within limits", () => {
    const plan = buildPackagePlan({
      shippingOption: "standard",
      itemSubtotalAmount: "12.00",
      lines: [{ productId: rawCardMeasure.productId, quantity: 4, measure: rawCardMeasure }],
    });

    expect(plan.packageCount).toBe(1);
    expect(plan.packages[0]?.mailpieceClass).toBe("letter");
    expect(plan.letterEligibility.eligible).toBe(true);
    expect(plan.postagePolicySnapshot).toMatchObject({
      policyVersion: "default-postage-policy-v3",
      parcelRequired: false,
      signatureRequired: false,
      insuranceRequired: false,
      insuredValueAmount: null,
      shippingEvidenceTier: "letter-untracked",
    });
  });

  it.each([
    ["50.00", "letter", false],
    ["50.01", "parcel", true],
  ])("applies the letter-class value cap above %s", (itemSubtotalAmount, mailpieceClass, parcelRequired) => {
    const plan = buildPackagePlan({
      shippingOption: "standard",
      itemSubtotalAmount,
      lines: [{ productId: rawCardMeasure.productId, quantity: 1, measure: rawCardMeasure }],
    });

    expect(plan.packages[0]?.mailpieceClass).toBe(mailpieceClass);
    expect(plan.postagePolicySnapshot?.parcelRequired).toBe(parcelRequired);
    if (parcelRequired) {
      expect(plan.letterEligibility.reasons).toContain("declared-value-requires-parcel");
      expect(plan.postagePolicySnapshot?.parcelReasons).toContain("declared-value-requires-parcel");
    }
  });

  it("moves slabs to parcel even when quantity and value are small", () => {
    const plan = buildPackagePlan({
      shippingOption: "standard",
      itemSubtotalAmount: "20.00",
      lines: [{ productId: slabMeasure.productId, quantity: 1, measure: slabMeasure }],
    });

    expect(plan.packages[0]?.mailpieceClass).toBe("parcel");
    expect(plan.letterEligibility.reasons).toContain("product-type-requires-parcel");
    expect(plan.postagePolicySnapshot?.parcelRequired).toBe(true);
  });

  it("decides letter eligibility from physical properties under the default policy", () => {
    expect(defaultPostagePolicy).toMatchObject({
      policyVersion: "default-postage-policy-v3",
      letterRequiredPhysicalFlags: ["bendable"],
      parcelRequiredPhysicalFlags: ["rigid", "metal", "jumbo", "irregular"],
    });

    const bendable = planOneWithinLetterLimits(["bendable"]);
    expect(bendable.packages[0]?.mailpieceClass).toBe("letter");
    expect(bendable.letterEligibility).toEqual({ eligible: true, reasons: [] });
  });

  it.each<[string, readonly ProductPhysicalFlag[]]>([
    ["rigid", ["rigid"]],
    ["metal", ["metal"]],
    ["jumbo", ["jumbo"]],
    ["irregular", ["irregular"]],
    ["bendable and rigid", ["bendable", "rigid"]],
    ["unflagged", []],
  ])("needs a parcel for a %s line within the letter limits", (_label, physicalFlags) => {
    const plan = planOneWithinLetterLimits(physicalFlags);

    expect(plan.packages[0]?.mailpieceClass).toBe("parcel");
    expect(plan.letterEligibility.reasons).toEqual(["product-type-requires-parcel"]);
  });

  it.each<[string[], "letter" | "parcel"]>([
    [["raw-card", "bendable"], "letter"],
    [["slab", "rigid"], "parcel"],
    [["sealed"], "parcel"],
    [["sealed", "rigid"], "parcel"],
  ])("plans a measure stored as %j the way the policy that named kinds did", (flags, mailpieceClass) => {
    const underDefault = planOneWithinLetterLimits(storedFlags(...flags));
    const underStoredPolicy = planOneWithinLetterLimits(storedFlags(...flags), storedPolicyThatNamesKinds);

    expect(underDefault.packages[0]?.mailpieceClass).toBe(mailpieceClass);
    expect(underStoredPolicy.packages[0]?.mailpieceClass).toBe(mailpieceClass);
    expect(underDefault.letterEligibility).toEqual(underStoredPolicy.letterEligibility);
  });

  it("needs a parcel for a measure stored with only the raw-card kind", () => {
    const plan = planOneWithinLetterLimits(storedFlags("raw-card"));

    expect(plan.packages[0]?.mailpieceClass).toBe("parcel");
    expect(plan.letterEligibility.reasons).toEqual(["product-type-requires-parcel"]);
  });

  it("needs a parcel for a bendable line while a stored policy still requires the raw-card kind", () => {
    const plan = planOneWithinLetterLimits(["bendable"], storedPolicyThatNamesKinds);

    expect(plan.packages[0]?.mailpieceClass).toBe("parcel");
    expect(plan.letterEligibility.reasons).toEqual(["product-type-requires-parcel"]);
    expect(plan.postagePolicySnapshot?.policyVersion).toBe("default-postage-policy-v2");
  });

  it("records signature requirements from the active postage policy", () => {
    const plan = buildPackagePlan({
      shippingOption: "priority",
      itemSubtotalAmount: "20.00",
      lines: [{ productId: rawCardMeasure.productId, quantity: 1, measure: rawCardMeasure }],
    });

    expect(plan.packages[0]?.mailpieceClass).toBe("parcel");
    expect(plan.postagePolicySnapshot).toMatchObject({
      policyVersion: "default-postage-policy-v3",
      parcelRequired: true,
      signatureRequired: true,
      insuranceRequired: false,
      shippingEvidenceTier: "signature-confirmed",
    });
    expect(plan.postagePolicySnapshot?.parcelReasons).toContain("shipping-option-requires-parcel");
    expect(plan.postagePolicySnapshot?.signatureReasons).toContain("shipping-option-requires-signature");
  });

  it.each([
    ["249.99", false, "tracked-parcel"],
    ["250.00", true, "signature-confirmed"],
    ["250.01", true, "signature-confirmed"],
  ])("applies the signature-required value threshold at %s", (itemSubtotalAmount, signatureRequired, evidenceTier) => {
    const plan = buildPackagePlan({
      shippingOption: "standard",
      itemSubtotalAmount,
      lines: [{ productId: slabMeasure.productId, quantity: 1, measure: slabMeasure }],
    });

    expect(plan.postagePolicySnapshot).toMatchObject({
      signatureRequired,
      shippingEvidenceTier: evidenceTier,
    });
    if (signatureRequired) {
      expect(plan.postagePolicySnapshot?.signatureReasons).toContain("declared-value-requires-signature");
    }
  });

  it.each([
    ["499.99", false, null, "signature-confirmed"],
    ["500.00", true, "500.00", "carrier-insured"],
    ["500.01", true, "500.01", "carrier-insured"],
  ])(
    "applies the carrier insurance value threshold at %s",
    (itemSubtotalAmount, insuranceRequired, insuredValueAmount, evidenceTier) => {
      const plan = buildPackagePlan({
        shippingOption: "standard",
        itemSubtotalAmount,
        lines: [{ productId: slabMeasure.productId, quantity: 1, measure: slabMeasure }],
      });

      expect(plan.postagePolicySnapshot).toMatchObject({
        insuranceRequired,
        insuredValueAmount,
        shippingEvidenceTier: evidenceTier,
      });
      if (insuranceRequired) {
        expect(plan.postagePolicySnapshot?.insuranceReasons).toContain("declared-value-requires-insurance");
      }
    },
  );

  it("supports custom policy versions and declared-value signature thresholds", () => {
    const plan = buildPackagePlan({
      shippingOption: "standard",
      itemSubtotalAmount: "75.00",
      lines: [{ productId: rawCardMeasure.productId, quantity: 1, measure: rawCardMeasure }],
      postagePolicy: {
        policyVersion: "operator-policy-v2",
        maxLetterDeclaredValueAmount: 100,
        signatureRequiredDeclaredValueAmount: 50,
        insuranceRequiredDeclaredValueAmount: null,
      },
    });

    expect(plan.packages[0]?.mailpieceClass).toBe("letter");
    expect(plan.postagePolicySnapshot).toMatchObject({
      policyVersion: "operator-policy-v2",
      parcelRequired: false,
      signatureRequired: true,
      insuranceRequired: false,
      shippingEvidenceTier: "signature-confirmed",
    });
    expect(plan.postagePolicySnapshot?.signatureReasons).toContain("declared-value-requires-signature");
  });

  it("reports missing product measurements explicitly", () => {
    const plan = buildPackagePlan({
      shippingOption: "standard",
      itemSubtotalAmount: "20.00",
      lines: [{ productId: "cat_missing::raw", quantity: 1, measure: null }],
    });

    expect(plan.packageCount).toBe(0);
    expect(plan.missingProductIds).toEqual(["cat_missing::raw"]);
    expect(plan.letterEligibility.reasons).toContain("missing-product-measures");
    expect(plan.postagePolicySnapshot?.parcelRequired).toBe(true);
  });
});
