import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type {
  SourceObservationExternalCatalogItemReference,
  SourceObservationExternalProductReference,
  SourceObservationSelectedOptionReference,
} from "../../domain/domain";
import type {
  CatalogProviderExternalReferenceRule,
  CatalogProviderVariantRule,
} from "../provider-integration-profiles";

export type CatalogProviderExternalReferenceExtractionDiagnostic = Readonly<{
  code: "missing-reference-value" | "missing-selected-options" | "repeated-ambiguous-reference" | "wrong-target-level";
  path: string;
  diagnosticText: string;
}>;

export type CatalogProviderExternalReferenceReviewEvidence = Readonly<{
  target: CatalogProviderExternalReferenceRule["target"];
  providerKey: string;
  externalKey: string | null;
  reason: CatalogProviderExternalReferenceExtractionDiagnostic["code"];
  reviewEvidence?: JsonObject;
}>;

export type CatalogProviderExternalReferenceExtractionResult = Readonly<{
  externalCatalogItemReferences: readonly SourceObservationExternalCatalogItemReference[];
  externalProductReferences: readonly SourceObservationExternalProductReference[];
  reviewEvidence: readonly CatalogProviderExternalReferenceReviewEvidence[];
  diagnostics: readonly CatalogProviderExternalReferenceExtractionDiagnostic[];
}>;

export function extractCatalogProviderExternalReferences(input: {
  rules: readonly CatalogProviderExternalReferenceRule[];
  payload: JsonValue;
  variant?: Pick<CatalogProviderVariantRule, "pricingKeys" | "sourceKeys" | "variantKey"> | null;
}): CatalogProviderExternalReferenceExtractionResult {
  const catalogItemReferences: SourceObservationExternalCatalogItemReference[] = [];
  const productReferences: SourceObservationExternalProductReference[] = [];
  const reviewEvidence: CatalogProviderExternalReferenceReviewEvidence[] = [];
  const diagnostics: CatalogProviderExternalReferenceExtractionDiagnostic[] = [];

  input.rules.forEach((rule, ruleIndex) => {
    const candidates = referenceCandidatesForRule(rule, input.payload, input.variant ?? null, `rules.${ruleIndex}`);
    if (candidates.length === 0) {
      diagnostics.push({
        code: "missing-reference-value",
        path: `rules.${ruleIndex}`,
        diagnosticText: `${rule.providerKey} ${rule.target} rule did not resolve any provider identifiers.`,
      });
    }

    for (const candidate of candidates) {
      const externalKey = prefixedExternalKey(rule.externalKeyPrefix, candidate.externalId);
      if (!externalKey) {
        continue;
      }

      if (rule.target === "catalog-item-reference") {
        if (externalKey.startsWith("sku:")) {
          diagnostics.push(wrongTargetLevel(rule, externalKey, candidate.path));
          reviewEvidence.push({
            target: rule.target,
            providerKey: rule.providerKey,
            externalKey,
            reason: "wrong-target-level",
            reviewEvidence: candidate.reviewEvidence,
          });
          continue;
        }
        catalogItemReferences.push({ providerKey: rule.providerKey, externalKey });
        continue;
      }

      if (externalKey.startsWith("product:")) {
        diagnostics.push(wrongTargetLevel(rule, externalKey, candidate.path));
        reviewEvidence.push({
          target: rule.target,
          providerKey: rule.providerKey,
          externalKey,
          reason: "wrong-target-level",
          reviewEvidence: candidate.reviewEvidence,
        });
        continue;
      }

      if (!candidate.selectedOptions || candidate.selectedOptions.length === 0) {
        diagnostics.push({
          code: "missing-selected-options",
          path: candidate.path,
          diagnosticText: `${rule.providerKey} Product reference ${externalKey} did not have validated Catalog selected Options.`,
        });
        reviewEvidence.push({
          target: rule.target,
          providerKey: rule.providerKey,
          externalKey,
          reason: "missing-selected-options",
          reviewEvidence: candidate.reviewEvidence,
        });
        continue;
      }

      productReferences.push({
        providerKey: rule.providerKey,
        externalKey,
        selectedOptions: candidate.selectedOptions,
        reviewEvidence: candidate.reviewEvidence,
      });
    }
  });

  return {
    externalCatalogItemReferences: uniqueCatalogItemReferences(catalogItemReferences),
    externalProductReferences: uniqueProductReferences(productReferences),
    reviewEvidence,
    diagnostics,
  };
}

export function dropRepeatedCatalogItemReferencesAcrossVariants(
  referencesByVariantKey: ReadonlyMap<string, readonly SourceObservationExternalCatalogItemReference[]>,
): ReadonlyMap<string, readonly SourceObservationExternalCatalogItemReference[]> {
  const occurrences = new Map<string, number>();
  for (const references of referencesByVariantKey.values()) {
    for (const reference of uniqueCatalogItemReferences(references)) {
      const key = catalogItemReferenceIdentity(reference);
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    }
  }

  return new Map(
    Array.from(referencesByVariantKey.entries()).map(([variantKey, references]) => [
      variantKey,
      references.filter((reference) => occurrences.get(catalogItemReferenceIdentity(reference)) === 1),
    ]),
  );
}

type ReferenceCandidate = Readonly<{
  externalId: string;
  path: string;
  selectedOptions?: readonly SourceObservationSelectedOptionReference[];
  reviewEvidence?: JsonObject;
}>;

function referenceCandidatesForRule(
  rule: CatalogProviderExternalReferenceRule,
  payload: JsonValue,
  variant: Pick<CatalogProviderVariantRule, "pricingKeys" | "sourceKeys" | "variantKey"> | null,
  path: string,
): readonly ReferenceCandidate[] {
  return containersForRule(rule, payload, variant, path).flatMap((container) =>
    candidatesFromValue(rule, container.value, container.path),
  );
}

function containersForRule(
  rule: CatalogProviderExternalReferenceRule,
  payload: JsonValue,
  variant: Pick<CatalogProviderVariantRule, "pricingKeys" | "sourceKeys" | "variantKey"> | null,
  path: string,
): readonly { value: JsonValue; path: string }[] {
  const containers: { value: JsonValue; path: string }[] = [{ value: payload, path: `${path}.payload` }];
  if (isJsonRecord(payload)) {
    for (const containerKey of rule.containerKeys) {
      const container = payload[containerKey];
      if (container !== undefined && container !== null) {
        containers.push({ value: container, path: `${path}.containerKeys.${containerKey}` });
      }
    }

    const pricingContainer = isJsonRecord(payload.pricing) ? payload.pricing : null;
    for (const pricingRootKey of rule.pricingRootKeys) {
      const pricingRoot = payload[pricingRootKey] ?? pricingContainer?.[pricingRootKey];
      if (!pricingRoot) {
        continue;
      }
      containers.push({ value: pricingRoot, path: `${path}.pricingRootKeys.${pricingRootKey}` });

      if (rule.pricingScope === "by-variant" && variant) {
        for (const variantKey of pricingKeysForVariant(variant)) {
          if (isJsonRecord(pricingRoot) && pricingRoot[variantKey] !== undefined && pricingRoot[variantKey] !== null) {
            containers.push({
              value: pricingRoot[variantKey],
              path: `${path}.pricingRootKeys.${pricingRootKey}.${variantKey}`,
            });
          }
        }
      }
    }
  }

  return containers;
}

function candidatesFromValue(
  rule: CatalogProviderExternalReferenceRule,
  value: JsonValue,
  path: string,
): readonly ReferenceCandidate[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => candidatesFromValue(rule, entry, `${path}.${index}`));
  }

  if (isJsonRecord(value)) {
    const ids = idsFromRecord(rule, value);
    return ids.map((externalId) => ({
      externalId,
      path,
      selectedOptions: selectedOptionsFromRecord(value),
      reviewEvidence: reviewEvidenceFromRecord(value),
    }));
  }

  return cleanProviderIds(value).map((externalId) => ({ externalId, path }));
}

function idsFromRecord(rule: CatalogProviderExternalReferenceRule, record: JsonObject): readonly string[] {
  return uniqueStrings([...rule.valueKeys, ...rule.recordIdKeys].flatMap((key) => cleanProviderIds(record[key])));
}

function prefixedExternalKey(prefix: string, value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return normalized.startsWith(prefix) ? normalized : `${prefix}${normalized}`;
}

function cleanProviderIds(value: JsonValue | undefined): readonly string[] {
  if (typeof value === "string" || typeof value === "number") {
    const cleaned = String(value).trim();
    return cleaned ? [cleaned] : [];
  }

  return [];
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.trim().toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function selectedOptionsFromRecord(
  record: JsonObject,
): readonly SourceObservationSelectedOptionReference[] | undefined {
  const selectedOptions = record.selectedOptions;
  if (!Array.isArray(selectedOptions)) {
    return undefined;
  }

  const normalized = selectedOptions.filter(
    (option): option is SourceObservationSelectedOptionReference =>
      isJsonRecord(option) && typeof option.dimensionId === "string" && typeof option.optionId === "string",
  );

  return normalized.length > 0 ? normalized : undefined;
}

function reviewEvidenceFromRecord(record: JsonObject): JsonObject | undefined {
  const reviewEvidence = record.reviewEvidence;
  return isJsonRecord(reviewEvidence) ? reviewEvidence : undefined;
}

function pricingKeysForVariant(
  variant: Pick<CatalogProviderVariantRule, "pricingKeys" | "sourceKeys" | "variantKey">,
): readonly string[] {
  return [...(variant.pricingKeys ?? []), variant.variantKey, ...variant.sourceKeys];
}

function uniqueCatalogItemReferences(
  references: readonly SourceObservationExternalCatalogItemReference[],
): readonly SourceObservationExternalCatalogItemReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = catalogItemReferenceIdentity(reference);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueProductReferences(
  references: readonly SourceObservationExternalProductReference[],
): readonly SourceObservationExternalProductReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.providerKey.trim().toLowerCase()}:${reference.externalKey.trim().toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function catalogItemReferenceIdentity(reference: SourceObservationExternalCatalogItemReference): string {
  return `${reference.providerKey.trim().toLowerCase()}:${reference.externalKey.trim().toLowerCase()}`;
}

function wrongTargetLevel(
  rule: CatalogProviderExternalReferenceRule,
  externalKey: string,
  path: string,
): CatalogProviderExternalReferenceExtractionDiagnostic {
  return {
    code: "wrong-target-level",
    path,
    diagnosticText: `${rule.providerKey} ${externalKey} cannot be mapped as ${rule.target}.`,
  };
}

function isJsonRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
