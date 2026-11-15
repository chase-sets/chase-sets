import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { MONEY_AMOUNT_MAX_CENTS } from "@chase-sets/primitives/money";

export type SellerComplianceRefundTreatment = "exclude-refunded" | "count-refunded";
export type SellerComplianceCancellationTreatment =
  | "exclude-cancelled"
  | "exclude-if-fully-refunded"
  | "count-cancelled";
export type SellerComplianceMixedLineTreatment = "exclude-mixed" | "count-mixed";
export type SellerComplianceUnclassifiableTreatment = "exclude-unclassifiable" | "count-unclassifiable";

export type SellerComplianceGrossBasis = "item-gross" | "item-gross-plus-shipping";
export type SellerComplianceSaleUnit = "captured-order";

export type SellerComplianceClassificationRule = Readonly<{
  source: "productId" | "catalogItemId" | "selectedOptionId" | "gradedCard";
  value: string;
}>;

export type SellerComplianceCohortPolicyValue = Readonly<{
  activated: boolean;
  currencyCode: string | null;
  qualifyingTransactionCount: number | null;
  qualifyingGrossCents: string | null;
  disclosureGrossCents: string | null;
  windowMonths: number | null;
  lookbackMonths: number | null;
  comparisonIsInclusive: boolean | null;
  saleUnit: SellerComplianceSaleUnit | null;
  qualifyingGrossBasis: SellerComplianceGrossBasis | null;
  refundTreatment: SellerComplianceRefundTreatment | null;
  postCaptureCancellationTreatment: SellerComplianceCancellationTreatment | null;
  mixedLineTreatment: SellerComplianceMixedLineTreatment | null;
  unclassifiableTreatment: SellerComplianceUnclassifiableTreatment | null;
  classificationRules: readonly SellerComplianceClassificationRule[] | null;
}>;

export const SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE: SellerComplianceCohortPolicyValue = {
  activated: false,
  currencyCode: null,
  qualifyingTransactionCount: null,
  qualifyingGrossCents: null,
  disclosureGrossCents: null,
  windowMonths: null,
  lookbackMonths: null,
  comparisonIsInclusive: null,
  saleUnit: null,
  qualifyingGrossBasis: null,
  refundTreatment: null,
  postCaptureCancellationTreatment: null,
  mixedLineTreatment: null,
  unclassifiableTreatment: null,
  classificationRules: null,
};

export class SellerComplianceCohortPolicyDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SellerComplianceCohortPolicyDomainError";
  }
}

const interpretiveFields: (keyof SellerComplianceCohortPolicyValue)[] = [
  "currencyCode",
  "qualifyingTransactionCount",
  "qualifyingGrossCents",
  "disclosureGrossCents",
  "windowMonths",
  "lookbackMonths",
  "comparisonIsInclusive",
  "saleUnit",
  "qualifyingGrossBasis",
  "refundTreatment",
  "postCaptureCancellationTreatment",
  "mixedLineTreatment",
  "unclassifiableTreatment",
  "classificationRules",
];

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0)
    throw new SellerComplianceCohortPolicyDomainError(`${key} must be a non-empty string or null.`);
  return value;
}

function nullableInteger(record: Record<string, unknown>, key: string, min: number, max: number): number | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number")
    throw new SellerComplianceCohortPolicyDomainError(`${key} must be an integer between ${min} and ${max} or null.`);
  const n = value;
  if (!Number.isInteger(n) || n < min || n > max)
    throw new SellerComplianceCohortPolicyDomainError(`${key} must be an integer between ${min} and ${max} or null.`);
  return n;
}

function nullableBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean")
    throw new SellerComplianceCohortPolicyDomainError(`${key} must be a boolean or null.`);
  return value;
}

function nullableCents(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^\d+$/.test(text))
    throw new SellerComplianceCohortPolicyDomainError(`${key} must be non-negative integer cents or null.`);
  const cents = BigInt(text);
  if (cents > MONEY_AMOUNT_MAX_CENTS)
    throw new SellerComplianceCohortPolicyDomainError(`${key} exceeds the money bound.`);
  return text;
}

function nullableTreatment<T extends string>(
  record: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !values.includes(value as T))
    throw new SellerComplianceCohortPolicyDomainError(`${key} contains an unsupported treatment.`);
  return value as T;
}

function nullableEnum<T extends string>(record: Record<string, unknown>, key: string, values: readonly T[]): T | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !values.includes(value as T))
    throw new SellerComplianceCohortPolicyDomainError(`${key} contains an unsupported value.`);
  return value as T;
}

export function decodeSellerComplianceCohortPolicyValue(raw: JsonValue): SellerComplianceCohortPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new SellerComplianceCohortPolicyDomainError("Seller compliance cohort policy value must be an object.");
  const r = raw as Record<string, unknown>;
  if (typeof r.activated !== "boolean")
    throw new SellerComplianceCohortPolicyDomainError("activated must be a boolean.");
  const value: SellerComplianceCohortPolicyValue = {
    activated: r.activated,
    currencyCode: nullableString(r, "currencyCode"),
    qualifyingTransactionCount: nullableInteger(r, "qualifyingTransactionCount", 1, 1_000_000),
    qualifyingGrossCents: nullableCents(r, "qualifyingGrossCents"),
    disclosureGrossCents: nullableCents(r, "disclosureGrossCents"),
    windowMonths: nullableInteger(r, "windowMonths", 1, 24),
    lookbackMonths: nullableInteger(r, "lookbackMonths", 1, 60),
    comparisonIsInclusive: nullableBoolean(r, "comparisonIsInclusive"),
    saleUnit: nullableEnum(r, "saleUnit", ["captured-order"] as const),
    qualifyingGrossBasis: nullableEnum(r, "qualifyingGrossBasis", ["item-gross", "item-gross-plus-shipping"] as const),
    refundTreatment: nullableTreatment(r, "refundTreatment", ["exclude-refunded", "count-refunded"] as const),
    postCaptureCancellationTreatment: nullableTreatment(r, "postCaptureCancellationTreatment", [
      "exclude-cancelled",
      "exclude-if-fully-refunded",
      "count-cancelled",
    ] as const),
    mixedLineTreatment: nullableTreatment(r, "mixedLineTreatment", ["exclude-mixed", "count-mixed"] as const),
    unclassifiableTreatment: nullableTreatment(r, "unclassifiableTreatment", [
      "exclude-unclassifiable",
      "count-unclassifiable",
    ] as const),
    classificationRules: null,
  };
  const rules = r.classificationRules;
  if (rules !== null && rules !== undefined) {
    if (!Array.isArray(rules) || rules.length === 0)
      throw new SellerComplianceCohortPolicyDomainError("classificationRules must be a non-empty array or null.");
    const classificationRules = rules.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry))
        throw new SellerComplianceCohortPolicyDomainError("classificationRules entries must be objects.");
      const e = entry as Record<string, unknown>;
      if (
        typeof e.source !== "string" ||
        !["productId", "catalogItemId", "selectedOptionId", "gradedCard"].includes(e.source) ||
        typeof e.value !== "string" ||
        !e.value
      )
        throw new SellerComplianceCohortPolicyDomainError("classificationRules entries require source and value.");
      return { source: e.source as SellerComplianceClassificationRule["source"], value: e.value };
    });
    return validateSellerComplianceCohortPolicyValue({ ...value, classificationRules });
  }
  return validateSellerComplianceCohortPolicyValue(value);
}

function validateSellerComplianceCohortPolicyValue(
  value: SellerComplianceCohortPolicyValue,
): SellerComplianceCohortPolicyValue {
  if (value.currencyCode !== null && !/^[A-Z]{3}$/.test(value.currencyCode))
    throw new SellerComplianceCohortPolicyDomainError("currencyCode must be three uppercase letters or null.");
  if (value.lookbackMonths !== null && value.windowMonths !== null && value.lookbackMonths < value.windowMonths)
    throw new SellerComplianceCohortPolicyDomainError("lookbackMonths must be at least windowMonths.");
  if (
    value.qualifyingGrossCents !== null &&
    value.disclosureGrossCents !== null &&
    BigInt(value.disclosureGrossCents) < BigInt(value.qualifyingGrossCents)
  )
    throw new SellerComplianceCohortPolicyDomainError("disclosureGrossCents must be at least qualifyingGrossCents.");
  if (value.activated && interpretiveFields.some((key) => value[key] === null))
    throw new SellerComplianceCohortPolicyDomainError(
      "activated policy requires every interpretive field to be configured.",
    );
  return value;
}

export const sellerComplianceCohortPolicy: PolicyDefinition<SellerComplianceCohortPolicyValue> = definePolicy({
  policyKey: "platform-operations.seller-compliance-cohort",
  contextName: "platform-operations",
  schemaSummary:
    "policy-configured rolling-window seller compliance cohort; nullable until counsel-approved activation",
  defaultValue: SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE,
  decodeValue: decodeSellerComplianceCohortPolicyValue,
});
