import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type { SourceObservationSelectedOptionReference } from "../../domain/domain";
import type { CatalogProviderSelectedOptionMapping } from "../provider-integration-profiles";

export type CatalogProviderSelectedOptionResolutionDiagnostic = Readonly<{
  code:
    | "missing-provider-value"
    | "missing-schema-dimension"
    | "inactive-schema-dimension"
    | "unknown-provider-option"
    | "inactive-schema-option";
  path: string;
  diagnosticText: string;
}>;

export type CatalogProviderSelectedOptionReviewEvidence = Readonly<{
  dimensionKey: string;
  providerValue: string | null;
  reason: CatalogProviderSelectedOptionResolutionDiagnostic["code"];
}>;

export type CatalogProviderSelectedOptionResolutionResult = Readonly<{
  resolved: boolean;
  selectedOptions: readonly SourceObservationSelectedOptionReference[];
  reviewEvidence: readonly CatalogProviderSelectedOptionReviewEvidence[];
  diagnostics: readonly CatalogProviderSelectedOptionResolutionDiagnostic[];
}>;

export type CatalogProviderProductReferenceSchema = Readonly<{
  dimensions: readonly CatalogProviderProductReferenceDimension[];
}>;

export type CatalogProviderProductReferenceDimension = Readonly<{
  dimensionKey: string;
  dimensionId: string;
  required?: boolean;
  status?: string;
  options: readonly CatalogProviderProductReferenceOption[];
}>;

export type CatalogProviderProductReferenceOption = Readonly<{
  optionId: string;
  optionKey?: string;
  code?: string;
  aliases?: readonly string[];
  status?: string;
}>;

export function resolveCatalogProviderSelectedOptions(input: {
  mapping: CatalogProviderSelectedOptionMapping;
  payload: JsonValue;
  record: JsonValue;
  productReferenceSchema: CatalogProviderProductReferenceSchema;
}): CatalogProviderSelectedOptionResolutionResult {
  const selectedOptions: SourceObservationSelectedOptionReference[] = [];
  const reviewEvidence: CatalogProviderSelectedOptionReviewEvidence[] = [];
  const diagnostics: CatalogProviderSelectedOptionResolutionDiagnostic[] = [];
  const schemaOrderByDimensionId = new Map(
    input.productReferenceSchema.dimensions.map((dimension, index) => [dimension.dimensionId, index]),
  );
  let resolved = true;

  input.mapping.dimensions.forEach((dimensionRule, dimensionIndex) => {
    const rulePath = `selectedOptionMapping.dimensions.${dimensionIndex}`;
    const schemaDimension = input.productReferenceSchema.dimensions.find(
      (dimension) => dimension.dimensionKey === dimensionRule.dimensionKey,
    );
    const dimensionRequired = dimensionRule.required || schemaDimension?.required === true;

    if (!schemaDimension) {
      if (dimensionRequired) {
        resolved = false;
        diagnostics.push({
          code: "missing-schema-dimension",
          path: `${rulePath}.dimensionKey`,
          diagnosticText: `Product schema is missing required dimension '${dimensionRule.dimensionKey}'.`,
        });
        reviewEvidence.push({
          dimensionKey: dimensionRule.dimensionKey,
          providerValue: providerValueForReview(input, dimensionRule),
          reason: "missing-schema-dimension",
        });
      }
      return;
    }

    if (!isActive(schemaDimension.status)) {
      if (dimensionRequired) {
        resolved = false;
        diagnostics.push({
          code: "inactive-schema-dimension",
          path: `${rulePath}.dimensionKey`,
          diagnosticText: `Product schema dimension '${dimensionRule.dimensionKey}' is not active.`,
        });
        reviewEvidence.push({
          dimensionKey: dimensionRule.dimensionKey,
          providerValue: providerValueForReview(input, dimensionRule),
          reason: "inactive-schema-dimension",
        });
      }
      return;
    }

    const providerValue = providerValueForRule(input, dimensionRule);
    if (!providerValue) {
      if (dimensionRequired) {
        resolved = false;
        diagnostics.push({
          code: "missing-provider-value",
          path: `${rulePath}.providerValue.path`,
          diagnosticText: `Provider evidence is missing required selected-option dimension '${dimensionRule.dimensionKey}'.`,
        });
        reviewEvidence.push({
          dimensionKey: dimensionRule.dimensionKey,
          providerValue: null,
          reason: "missing-provider-value",
        });
      }
      return;
    }

    const option = optionForProviderValue(providerValue, dimensionRule, schemaDimension);
    if (!option) {
      if (dimensionRequired || dimensionRule.unknownPolicy === "review-evidence") {
        resolved = false;
        diagnostics.push({
          code: "unknown-provider-option",
          path: `${rulePath}.providerValue.path`,
          diagnosticText: `Provider selected-option value did not resolve for dimension '${dimensionRule.dimensionKey}'.`,
        });
        reviewEvidence.push({
          dimensionKey: dimensionRule.dimensionKey,
          providerValue,
          reason: "unknown-provider-option",
        });
      }
      return;
    }

    if (!isActive(option.status)) {
      if (dimensionRequired || dimensionRule.unknownPolicy === "review-evidence") {
        resolved = false;
        diagnostics.push({
          code: "inactive-schema-option",
          path: `${rulePath}.providerValue.path`,
          diagnosticText: `Provider selected-option value resolved to an inactive option for dimension '${dimensionRule.dimensionKey}'.`,
        });
        reviewEvidence.push({
          dimensionKey: dimensionRule.dimensionKey,
          providerValue,
          reason: "inactive-schema-option",
        });
      }
      return;
    }

    selectedOptions.push({
      dimensionId: schemaDimension.dimensionId,
      optionId: option.optionId,
    });
  });

  return {
    resolved: resolved && selectedOptions.length > 0,
    selectedOptions: selectedOptions.sort((left, right) =>
      (schemaOrderByDimensionId.get(left.dimensionId) ?? Number.MAX_SAFE_INTEGER) ===
      (schemaOrderByDimensionId.get(right.dimensionId) ?? Number.MAX_SAFE_INTEGER)
        ? left.optionId.localeCompare(right.optionId)
        : (schemaOrderByDimensionId.get(left.dimensionId) ?? Number.MAX_SAFE_INTEGER) -
          (schemaOrderByDimensionId.get(right.dimensionId) ?? Number.MAX_SAFE_INTEGER),
    ),
    reviewEvidence,
    diagnostics,
  };
}

type SelectedOptionDimensionRule = CatalogProviderSelectedOptionMapping["dimensions"][number];

function providerValueForReview(
  input: {
    payload: JsonValue;
    record: JsonValue;
  },
  rule: SelectedOptionDimensionRule,
): string | null {
  return providerValueForRule(input, rule);
}

function providerValueForRule(
  input: {
    payload: JsonValue;
    record: JsonValue;
  },
  rule: SelectedOptionDimensionRule,
): string | null {
  const source = rule.providerValue.source === "payload" ? input.payload : input.record;
  const rawValue = valueAtPath(source, rule.providerValue.path);
  const mappedValue = rule.valueMappings?.find((mapping) => valuesEqual(mapping.from, rawValue))?.value ?? rawValue;

  if (typeof mappedValue === "string" || typeof mappedValue === "number" || typeof mappedValue === "boolean") {
    const normalized = String(mappedValue).trim();
    return normalized ? normalized : null;
  }

  return null;
}

function optionForProviderValue(
  providerValue: string,
  rule: SelectedOptionDimensionRule,
  schemaDimension: CatalogProviderProductReferenceDimension,
): CatalogProviderProductReferenceOption | null {
  const providerOptionKey = optionKeyForProviderValue(providerValue, rule);
  const normalizedProviderValue = normalizeProviderOption(providerValue);

  return (
    schemaDimension.options.find((option) => {
      const optionKeys = [option.optionKey, option.code, option.optionId]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map(normalizeProviderOption);
      if (providerOptionKey && optionKeys.includes(normalizeProviderOption(providerOptionKey))) {
        return true;
      }

      return (option.aliases ?? []).some((alias) => normalizeProviderOption(alias) === normalizedProviderValue);
    }) ?? null
  );
}

function optionKeyForProviderValue(providerValue: string, rule: SelectedOptionDimensionRule): string | null {
  const normalizedProviderValue = normalizeProviderOption(providerValue);
  const synonym = (rule.valueSynonyms ?? []).find((candidate) =>
    candidate.providerValues.some((value) => normalizeProviderOption(value) === normalizedProviderValue),
  );

  return synonym?.optionKey ?? null;
}

function valueAtPath(value: JsonValue, path: string): JsonValue | undefined {
  const segments = path.split(".").filter(Boolean);
  let current: JsonValue | undefined = value;

  for (const segment of segments) {
    if (!isJsonRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function valuesEqual(left: JsonValue, right: JsonValue | undefined): boolean {
  if (typeof left === "string" || typeof left === "number" || typeof left === "boolean") {
    return String(left) === String(right);
  }

  return left === right;
}

function isActive(status: string | undefined): boolean {
  return status === undefined || status === "active";
}

function isJsonRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProviderOption(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}
