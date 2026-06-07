export type ProductPhysicalFlag =
  | "raw-card"
  | "slab"
  | "sealed"
  | "rigid"
  | "bendable"
  | "metal"
  | "jumbo"
  | "irregular";

export type ProductMeasureStackBehavior = "stackable-thickness" | "stackable-height" | "non-stackable";

export type ProductMeasureSource = "profile" | "catalog-item-override" | "product-override";

export type ProductMeasureConfidence = "measured" | "provider" | "conservative-estimate";

export type ShippingOption = "standard" | "expedited" | "priority";

export type ProductMeasureSnapshot = Readonly<{
  catalogItemId: string;
  productId: string;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  measureVersion: string;
  unitLengthInches: number;
  unitWidthInches: number;
  unitHeightInches: number;
  unitWeightOunces: number;
  physicalFlags: readonly ProductPhysicalFlag[];
  stackBehavior: ProductMeasureStackBehavior;
  source: ProductMeasureSource;
  confidence: ProductMeasureConfidence;
}>;

export type PackagePlanPackage = Readonly<{
  packageId: string;
  mailpieceClass: "letter" | "parcel";
  lengthInches: number;
  widthInches: number;
  heightInches: number;
  weightOunces: number;
  billableWeightOunces: number;
  serviceLevel: "letter" | "standard-parcel" | "expedited-parcel" | "priority-parcel";
  productMeasureVersions: readonly string[];
}>;

export type LetterEligibility = Readonly<{
  eligible: boolean;
  reasons: readonly string[];
}>;

export type PackagePlanPostagePolicySnapshot = Readonly<{
  policyVersion: string;
  parcelRequired: boolean;
  parcelReasons: readonly string[];
  signatureRequired: boolean;
  signatureReasons: readonly string[];
}>;

export type PackagePlan = Readonly<{
  packagePlanVersion: string;
  packageCount: number;
  packages: readonly PackagePlanPackage[];
  letterEligibility: LetterEligibility;
  postagePolicySnapshot?: PackagePlanPostagePolicySnapshot;
  missingProductIds: readonly string[];
}>;

export type PackagePlanLine = Readonly<{
  productId: string;
  quantity: number;
  measure: ProductMeasureSnapshot | null;
}>;

export type PackagePlanPolicy = Readonly<{
  maxLetterUnits: number;
  maxLetterWeightOunces: number;
  maxLetterThicknessInches: number;
  maxLetterDeclaredValueAmount: number;
  letterEnvelopeWeightOunces: number;
  parcelPackagingWeightOunces: number;
}>;

export type PostagePolicy = PackagePlanPolicy &
  Readonly<{
    policyVersion: string;
    parcelRequiredShippingOptions: readonly ShippingOption[];
    letterRequiredPhysicalFlags: readonly ProductPhysicalFlag[];
    parcelRequiredPhysicalFlags: readonly ProductPhysicalFlag[];
    signatureRequiredShippingOptions: readonly ShippingOption[];
    signatureRequiredDeclaredValueAmount: number | null;
    signatureRequiredPhysicalFlags: readonly ProductPhysicalFlag[];
  }>;

export type BuildPackagePlanInput = Readonly<{
  shippingOption: ShippingOption;
  itemSubtotalAmount: string;
  lines: readonly PackagePlanLine[];
  postagePolicy?: Partial<PostagePolicy>;
  policy?: Partial<PackagePlanPolicy>;
}>;

export const defaultPackagePlanPolicy: PackagePlanPolicy = {
  maxLetterUnits: 8,
  maxLetterWeightOunces: 3.5,
  maxLetterThicknessInches: 0.25,
  maxLetterDeclaredValueAmount: 50,
  letterEnvelopeWeightOunces: 0.4,
  parcelPackagingWeightOunces: 2,
};

export const defaultPostagePolicy: PostagePolicy = {
  ...defaultPackagePlanPolicy,
  policyVersion: "default-postage-policy-v1",
  parcelRequiredShippingOptions: ["expedited", "priority"],
  letterRequiredPhysicalFlags: ["raw-card"],
  parcelRequiredPhysicalFlags: ["slab", "sealed", "rigid", "metal", "jumbo", "irregular"],
  signatureRequiredShippingOptions: ["priority"],
  signatureRequiredDeclaredValueAmount: null,
  signatureRequiredPhysicalFlags: [],
};

export function buildPackagePlan(input: BuildPackagePlanInput): PackagePlan {
  const policy = normalizePostagePolicy(input);
  const missingProductIds = input.lines.filter((line) => line.measure === null).map((line) => line.productId);
  const itemSubtotalAmount = moneyToNumber(input.itemSubtotalAmount);

  if (missingProductIds.length > 0) {
    const letterEligibility = {
      eligible: false,
      reasons: ["missing-product-measures"],
    };
    const signatureRequirement = evaluateSignatureRequirement([], input.shippingOption, itemSubtotalAmount, policy);
    return {
      packagePlanVersion: "measured-package-plan-v1",
      packageCount: 0,
      packages: [],
      letterEligibility,
      postagePolicySnapshot: buildPostagePolicySnapshot(policy, letterEligibility, signatureRequirement),
      missingProductIds,
    };
  }

  const measuredLines = input.lines.map((line) => ({
    ...line,
    measure: line.measure as ProductMeasureSnapshot,
  }));
  const letterEligibility = evaluateLetterEligibility(measuredLines, input.shippingOption, itemSubtotalAmount, policy);
  const signatureRequirement = evaluateSignatureRequirement(
    measuredLines,
    input.shippingOption,
    itemSubtotalAmount,
    policy,
  );
  const packagePlanPackage = letterEligibility.eligible
    ? buildLetterPackage(measuredLines, policy)
    : buildParcelPackage(measuredLines, input.shippingOption, policy);

  return {
    packagePlanVersion: "measured-package-plan-v1",
    packageCount: 1,
    packages: [packagePlanPackage],
    letterEligibility,
    postagePolicySnapshot: buildPostagePolicySnapshot(policy, letterEligibility, signatureRequirement),
    missingProductIds,
  };
}

function normalizePostagePolicy(input: BuildPackagePlanInput): PostagePolicy {
  return {
    ...defaultPostagePolicy,
    ...input.policy,
    ...input.postagePolicy,
  };
}

function evaluateLetterEligibility(
  lines: readonly (PackagePlanLine & { measure: ProductMeasureSnapshot })[],
  shippingOption: ShippingOption,
  itemSubtotalAmount: number,
  policy: PostagePolicy,
): LetterEligibility {
  const reasons: string[] = [];
  const totalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);
  const totalWeight = totalUnitWeight(lines) + policy.letterEnvelopeWeightOunces;
  const totalThickness = totalStackedHeight(lines);

  if (policy.parcelRequiredShippingOptions.includes(shippingOption)) {
    reasons.push("shipping-option-requires-parcel");
  }
  if (totalQuantity > policy.maxLetterUnits) {
    reasons.push("too-many-units-for-letter");
  }
  if (totalWeight > policy.maxLetterWeightOunces) {
    reasons.push("too-heavy-for-letter");
  }
  if (totalThickness > policy.maxLetterThicknessInches) {
    reasons.push("too-thick-for-letter");
  }
  if (itemSubtotalAmount > policy.maxLetterDeclaredValueAmount) {
    reasons.push("declared-value-requires-parcel");
  }
  if (
    !lines.every(
      (line) =>
        policy.letterRequiredPhysicalFlags.every((flag) => hasFlag(line.measure, flag)) &&
        policy.parcelRequiredPhysicalFlags.every((flag) => !hasFlag(line.measure, flag)),
    )
  ) {
    reasons.push("product-type-requires-parcel");
  }

  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

function evaluateSignatureRequirement(
  lines: readonly (PackagePlanLine & { measure: ProductMeasureSnapshot })[],
  shippingOption: ShippingOption,
  itemSubtotalAmount: number,
  policy: PostagePolicy,
) {
  const reasons: string[] = [];

  if (policy.signatureRequiredShippingOptions.includes(shippingOption)) {
    reasons.push("shipping-option-requires-signature");
  }
  if (
    policy.signatureRequiredDeclaredValueAmount != null &&
    itemSubtotalAmount > policy.signatureRequiredDeclaredValueAmount
  ) {
    reasons.push("declared-value-requires-signature");
  }
  if (lines.some((line) => policy.signatureRequiredPhysicalFlags.some((flag) => hasFlag(line.measure, flag)))) {
    reasons.push("product-type-requires-signature");
  }

  return {
    required: reasons.length > 0,
    reasons,
  };
}

function buildPostagePolicySnapshot(
  policy: PostagePolicy,
  letterEligibility: LetterEligibility,
  signatureRequirement: Readonly<{ required: boolean; reasons: readonly string[] }>,
): PackagePlanPostagePolicySnapshot {
  return {
    policyVersion: policy.policyVersion,
    parcelRequired: !letterEligibility.eligible,
    parcelReasons: letterEligibility.reasons,
    signatureRequired: signatureRequirement.required,
    signatureReasons: signatureRequirement.reasons,
  };
}

function buildLetterPackage(
  lines: readonly (PackagePlanLine & { measure: ProductMeasureSnapshot })[],
  policy: PackagePlanPolicy,
): PackagePlanPackage {
  return {
    packageId: "pkg_1",
    mailpieceClass: "letter",
    lengthInches: 9.5,
    widthInches: 4.125,
    heightInches: roundUp(totalStackedHeight(lines), 3),
    weightOunces: roundUp(totalUnitWeight(lines) + policy.letterEnvelopeWeightOunces, 2),
    billableWeightOunces: roundUp(totalUnitWeight(lines) + policy.letterEnvelopeWeightOunces, 2),
    serviceLevel: "letter",
    productMeasureVersions: measureVersions(lines),
  };
}

function buildParcelPackage(
  lines: readonly (PackagePlanLine & { measure: ProductMeasureSnapshot })[],
  shippingOption: ShippingOption,
  policy: PackagePlanPolicy,
): PackagePlanPackage {
  const length = Math.max(...lines.map((line) => line.measure.unitLengthInches));
  const width = Math.max(...lines.map((line) => line.measure.unitWidthInches));
  const height = totalParcelHeight(lines);
  const weight = totalUnitWeight(lines) + policy.parcelPackagingWeightOunces;

  return {
    packageId: "pkg_1",
    mailpieceClass: "parcel",
    lengthInches: roundUp(Math.max(length, 6), 2),
    widthInches: roundUp(Math.max(width, 4), 2),
    heightInches: roundUp(Math.max(height, 0.75), 2),
    weightOunces: roundUp(Math.max(weight, 1), 2),
    billableWeightOunces: Math.ceil(Math.max(weight, 1)),
    serviceLevel:
      shippingOption === "priority"
        ? "priority-parcel"
        : shippingOption === "expedited"
          ? "expedited-parcel"
          : "standard-parcel",
    productMeasureVersions: measureVersions(lines),
  };
}

function totalUnitWeight(lines: readonly (PackagePlanLine & { measure: ProductMeasureSnapshot })[]) {
  return lines.reduce((sum, line) => sum + line.measure.unitWeightOunces * line.quantity, 0);
}

function totalStackedHeight(lines: readonly (PackagePlanLine & { measure: ProductMeasureSnapshot })[]) {
  return lines.reduce((sum, line) => sum + line.measure.unitHeightInches * line.quantity, 0);
}

function totalParcelHeight(lines: readonly (PackagePlanLine & { measure: ProductMeasureSnapshot })[]) {
  return lines.reduce((sum, line) => {
    if (line.measure.stackBehavior === "non-stackable") {
      return sum + line.measure.unitHeightInches * line.quantity;
    }
    return sum + line.measure.unitHeightInches * Math.max(1, line.quantity);
  }, 0);
}

function measureVersions(lines: readonly (PackagePlanLine & { measure: ProductMeasureSnapshot })[]) {
  return [...new Set(lines.map((line) => line.measure.measureVersion))].sort();
}

function hasFlag(measure: ProductMeasureSnapshot, flag: ProductPhysicalFlag) {
  return measure.physicalFlags.includes(flag);
}

function moneyToNumber(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundUp(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.ceil(value * factor) / factor;
}
