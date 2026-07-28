import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type { CatalogItemId, FieldId, ReferenceRecordId } from "../../../../ids";
import type {
  SourceObservationMagicCardPrintNormalized,
  SourceObservationMagicSealedProductNormalized,
  SourceObservationNormalized,
  SourceObservationOnePieceCardPrintNormalized,
  SourceObservationOnePieceSealedProductNormalized,
  SourceObservationPokemonCardNormalized,
} from "../../domain/domain";
import {
  normalizeSourceObservationNaturalKeys,
  normalizeSourceObservationProviderKey,
  sourceObservationLinkExternalKey,
} from "../../domain/domain";
import type {
  CatalogProviderDuplicatePreventionIdentityRule,
  CatalogProviderDuplicatePreventionTagRule,
  CatalogProviderIntegrationProfile,
} from "../provider-integration-profiles";
import type { CatalogProviderPromotionResolvedCatalogMapping } from "./provider-promotion-command-planner";

export type CatalogProviderDuplicatePreventionDb = Readonly<{
  query: <T>(sql: string, values?: readonly unknown[]) => Promise<{ rowCount?: number | null; rows: T[] }>;
}>;

export type CatalogProviderDuplicatePreventionResult =
  | Readonly<{
      status: "matched";
      catalogItemId: CatalogItemId;
      ruleKey: string;
      evidenceSummary: CatalogProviderDuplicatePreventionEvidenceSummary;
    }>
  | Readonly<{
      status: "none";
      evidenceSummaries: readonly CatalogProviderDuplicatePreventionEvidenceSummary[];
    }>
  | Readonly<{
      status: "blocked";
      ruleKey: string;
      diagnosticText: string;
      candidateCatalogItemIds: readonly CatalogItemId[];
      evidenceSummary: CatalogProviderDuplicatePreventionEvidenceSummary;
    }>
  | Readonly<{
      status: "review-only";
      ruleKey: string;
      candidateCatalogItemIds: readonly CatalogItemId[];
      evidenceSummary: CatalogProviderDuplicatePreventionEvidenceSummary;
    }>;

export type CatalogProviderDuplicatePreventionEvidenceSummary = Readonly<{
  ruleKey: string;
  matchKind: CatalogProviderDuplicatePreventionIdentityRule["matchKind"];
  evidenceText: string;
  candidateCatalogItemIds: readonly CatalogItemId[];
}>;

export async function resolveCatalogProviderDuplicatePrevention(input: {
  db: CatalogProviderDuplicatePreventionDb;
  profile: CatalogProviderIntegrationProfile;
  providerKey: string;
  externalKey: string;
  normalized: SourceObservationNormalized;
  catalog: CatalogProviderPromotionResolvedCatalogMapping;
}): Promise<CatalogProviderDuplicatePreventionResult> {
  const normalizedInput = {
    ...input,
    normalized: normalizeSourceObservationNaturalKeys(input.normalized),
  };
  const evidenceSummaries: CatalogProviderDuplicatePreventionEvidenceSummary[] = [];

  for (const rule of normalizedInput.profile.duplicatePreventionMapping.rules) {
    const ruleResult = await evaluateDuplicatePreventionRule(normalizedInput, rule);
    if (!ruleResult) {
      continue;
    }

    evidenceSummaries.push(ruleResult.evidenceSummary);

    if (ruleResult.candidatePolicy === "review-only") {
      return {
        status: "review-only",
        ruleKey: rule.ruleKey,
        candidateCatalogItemIds: ruleResult.candidateCatalogItemIds,
        evidenceSummary: ruleResult.evidenceSummary,
      };
    }

    if (ruleResult.candidateCatalogItemIds.length === 1) {
      return {
        status: "matched",
        catalogItemId: ruleResult.candidateCatalogItemIds[0],
        ruleKey: rule.ruleKey,
        evidenceSummary: ruleResult.evidenceSummary,
      };
    }

    if (ruleResult.candidateCatalogItemIds.length > 1) {
      if (input.profile.duplicatePreventionMapping.ambiguousCandidatePolicy === "review-only") {
        return {
          status: "review-only",
          ruleKey: rule.ruleKey,
          candidateCatalogItemIds: ruleResult.candidateCatalogItemIds,
          evidenceSummary: ruleResult.evidenceSummary,
        };
      }

      return {
        status: "blocked",
        ruleKey: rule.ruleKey,
        diagnosticText: ambiguousDiagnosticText(rule),
        candidateCatalogItemIds: ruleResult.candidateCatalogItemIds,
        evidenceSummary: ruleResult.evidenceSummary,
      };
    }
  }

  return {
    status: "none",
    evidenceSummaries,
  };
}

type DuplicatePreventionRuleEvaluation = Readonly<{
  candidatePolicy: "reuse" | "review-only";
  candidateCatalogItemIds: readonly CatalogItemId[];
  evidenceSummary: CatalogProviderDuplicatePreventionEvidenceSummary;
}>;

async function evaluateDuplicatePreventionRule(
  input: {
    db: CatalogProviderDuplicatePreventionDb;
    profile: CatalogProviderIntegrationProfile;
    providerKey: string;
    externalKey: string;
    normalized: SourceObservationNormalized;
    catalog: CatalogProviderPromotionResolvedCatalogMapping;
  },
  rule: CatalogProviderDuplicatePreventionIdentityRule,
): Promise<DuplicatePreventionRuleEvaluation | null> {
  if (rule.matchKind === "exact-external-catalog-item-reference") {
    const references = uniqueExternalCatalogItemReferences(input.normalized.externalCatalogItemReferences ?? []);
    if (references.length === 0) {
      return null;
    }

    const candidateCatalogItemIds = await findCatalogItemIdsForExternalCatalogItemReferences(input.db, references);
    return reusableRuleEvaluation(
      rule,
      candidateCatalogItemIds,
      `${references.length} external Catalog Item reference(s)`,
    );
  }

  if (rule.matchKind === "exact-external-product-reference") {
    const references = uniqueExternalProductReferences(input.normalized.externalProductReferences ?? []);
    if (references.length === 0) {
      return null;
    }

    const candidateCatalogItemIds = await findCatalogItemIdsForExternalProductReferences(input.db, references);
    return reusableRuleEvaluation(rule, candidateCatalogItemIds, `${references.length} external Product reference(s)`);
  }

  if (rule.matchKind === "source-observation-link") {
    const candidateCatalogItemId = await findCatalogItemIdForExternalProductReference(input.db, {
      providerKey: normalizeSourceObservationProviderKey(input.providerKey),
      externalKey: sourceObservationLinkExternalKey(input.normalized.languageCode, input.externalKey),
    });
    return candidateCatalogItemId
      ? reusableRuleEvaluation(rule, [candidateCatalogItemId], "source observation Product reference")
      : null;
  }

  if (rule.matchKind === "deterministic-pokemon-card-field-match") {
    if (input.normalized.kind !== rule.normalizedKind) {
      return null;
    }

    const expansionName = stringAtPath(input.normalized, rule.referenceRecord.keyPath);
    if (!expansionName) {
      return null;
    }

    const expansionReferenceId = await findReferenceRecordByTypeAndKey(
      input.db,
      rule.referenceRecord.typeKey,
      normalizeReferenceKey(expansionName),
    );
    if (!expansionReferenceId) {
      return null;
    }

    const candidateCatalogItemIds = await findCatalogItemIdsForDeterministicPokemonCardFields(input.db, {
      normalized: input.normalized,
      catalog: input.catalog,
      rule,
      expansionReferenceId,
    });
    return reusableRuleEvaluation(rule, candidateCatalogItemIds, "deterministic Pokemon card field identity");
  }

  if (rule.matchKind === "deterministic-magic-catalog-item-field-match") {
    if (input.normalized.kind !== rule.normalizedKind) {
      return null;
    }

    const setName = stringAtPath(input.normalized, rule.referenceRecord.keyPath);
    if (!setName) {
      return null;
    }

    const setReferenceId = await findReferenceRecordByTypeAndKey(
      input.db,
      rule.referenceRecord.typeKey,
      normalizeReferenceKey(setName),
    );
    if (!setReferenceId) {
      return null;
    }

    const candidateCatalogItemIds = await findCatalogItemIdsForDeterministicMagicCatalogItemFields(input.db, {
      normalized: input.normalized,
      catalog: input.catalog,
      rule,
      setReferenceId,
    });
    return reusableRuleEvaluation(rule, candidateCatalogItemIds, "deterministic Magic catalog item identity");
  }

  if (rule.matchKind === "deterministic-one-piece-catalog-item-field-match") {
    if (input.normalized.kind !== rule.normalizedKind) {
      return null;
    }

    const setName = stringAtPath(input.normalized, rule.referenceRecord.keyPath);
    if (!setName) {
      return null;
    }

    const setReferenceId = await findReferenceRecordByTypeAndKey(
      input.db,
      rule.referenceRecord.typeKey,
      normalizeReferenceKey(setName),
    );
    if (!setReferenceId) {
      return null;
    }

    const candidateCatalogItemIds = await findCatalogItemIdsForDeterministicOnePieceCatalogItemFields(input.db, {
      normalized: input.normalized,
      catalog: input.catalog,
      rule,
      setReferenceId,
    });
    return reusableRuleEvaluation(rule, candidateCatalogItemIds, "deterministic One Piece catalog item identity");
  }

  if (rule.matchKind === "partial-draft-pokemon-card-field-match") {
    if (input.normalized.kind !== rule.normalizedKind) {
      return null;
    }

    const candidateCatalogItemId = await findPartialDraftCatalogItemIdForPokemonCard(input.db, {
      profile: input.profile,
      normalized: input.normalized,
      catalog: input.catalog,
      rule,
    });
    return candidateCatalogItemId
      ? reusableRuleEvaluation(rule, [candidateCatalogItemId], "partial draft Pokemon card retry identity")
      : null;
  }

  if (rule.matchKind === "sealed-product-match") {
    const productForm = stringAtPath(input.normalized, rule.productFormPath);
    if (input.normalized.kind === rule.normalizedKind && productForm && rule.sealedValues.includes(productForm)) {
      if (input.normalized.kind === "magic-sealed-product" && rule.fieldMatches.length > 0) {
        const setName = stringAtPath(input.normalized, "setName");
        if (!setName) {
          return null;
        }
        const setReferenceId = await findReferenceRecordByTypeAndKey(input.db, "set", normalizeReferenceKey(setName));
        if (!setReferenceId) {
          return null;
        }
        const candidateCatalogItemIds = await findCatalogItemIdsForDeterministicMagicCatalogItemFields(input.db, {
          normalized: input.normalized,
          catalog: input.catalog,
          rule: {
            ruleKey: rule.ruleKey,
            matchKind: "deterministic-magic-catalog-item-field-match",
            normalizedKind: "magic-sealed-product",
            referenceRecord: { typeKey: "set", keyPath: "setName", targetFieldKey: "set" },
            fieldMatches: rule.fieldMatches,
          },
          setReferenceId,
        });
        return reusableRuleEvaluation(rule, candidateCatalogItemIds, "Magic sealed product provider set identity");
      }
      return reviewOnlyRuleEvaluation(rule, [], `sealed product form '${productForm}' requires sealed-product mapping`);
    }
    return null;
  }

  if (rule.matchKind === "barcode-gtin-match") {
    const barcodeValues = uniqueStrings(
      rule.barcodePaths.flatMap((path) => stringAtPath(input.normalized, path) ?? []),
    );
    return barcodeValues.length > 0
      ? reviewOnlyRuleEvaluation(rule, [], `barcode/GTIN evidence ${barcodeValues.join(", ")}`)
      : null;
  }

  const bridgeReferences = uniqueExternalCatalogItemReferences(
    input.normalized.externalCatalogItemReferences ?? [],
  ).filter((reference) => rule.bridgeReferenceProviderKeys.includes(reference.providerKey));
  return bridgeReferences.length > 0
    ? reviewOnlyRuleEvaluation(rule, [], `${bridgeReferences.length} bridge provider reference(s)`)
    : null;
}

function reusableRuleEvaluation(
  rule: CatalogProviderDuplicatePreventionIdentityRule,
  candidateCatalogItemIds: readonly CatalogItemId[],
  evidenceText: string,
): DuplicatePreventionRuleEvaluation {
  return {
    candidatePolicy: "reuse",
    candidateCatalogItemIds,
    evidenceSummary: {
      ruleKey: rule.ruleKey,
      matchKind: rule.matchKind,
      evidenceText,
      candidateCatalogItemIds,
    },
  };
}

function reviewOnlyRuleEvaluation(
  rule: CatalogProviderDuplicatePreventionIdentityRule,
  candidateCatalogItemIds: readonly CatalogItemId[],
  evidenceText: string,
): DuplicatePreventionRuleEvaluation {
  return {
    candidatePolicy: "review-only",
    candidateCatalogItemIds,
    evidenceSummary: {
      ruleKey: rule.ruleKey,
      matchKind: rule.matchKind,
      evidenceText,
      candidateCatalogItemIds,
    },
  };
}

async function findCatalogItemIdsForExternalCatalogItemReferences(
  db: CatalogProviderDuplicatePreventionDb,
  references: readonly { providerKey: string; externalKey: string }[],
): Promise<readonly CatalogItemId[]> {
  const values = references.flatMap((reference) => [reference.providerKey, reference.externalKey]);
  const referencePredicates = references.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`).join(", ");
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT DISTINCT reference.catalog_item_id
     FROM catalog_external_catalog_item_references AS reference
     JOIN catalog_items AS item
       ON item.catalog_item_id = reference.catalog_item_id
     WHERE (reference.provider_key, reference.external_key) IN (${referencePredicates})
       AND item.status NOT IN ('archived', 'removed')
     ORDER BY reference.catalog_item_id ASC`,
    values,
  );

  return uniqueCatalogItemIds(result.rows.map((row) => row.catalog_item_id));
}

async function findCatalogItemIdsForExternalProductReferences(
  db: CatalogProviderDuplicatePreventionDb,
  references: readonly { providerKey: string; externalKey: string }[],
): Promise<readonly CatalogItemId[]> {
  const values = references.flatMap((reference) => [reference.providerKey, reference.externalKey]);
  const referencePredicates = references.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`).join(", ");
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT DISTINCT reference.catalog_item_id
     FROM catalog_external_product_references AS reference
     JOIN catalog_items AS item
       ON item.catalog_item_id = reference.catalog_item_id
     WHERE (reference.provider_key, reference.external_key) IN (${referencePredicates})
       AND item.status NOT IN ('archived', 'removed')
     ORDER BY reference.catalog_item_id ASC`,
    values,
  );

  return uniqueCatalogItemIds(result.rows.map((row) => row.catalog_item_id));
}

async function findCatalogItemIdForExternalProductReference(
  db: CatalogProviderDuplicatePreventionDb,
  reference: { providerKey: string; externalKey: string },
): Promise<CatalogItemId | null> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT reference.catalog_item_id
     FROM catalog_external_product_references AS reference
     JOIN catalog_items AS item
       ON item.catalog_item_id = reference.catalog_item_id
     WHERE reference.provider_key = $1
       AND reference.external_key = $2
       AND item.status NOT IN ('archived', 'removed')
     LIMIT 1`,
    [reference.providerKey, reference.externalKey],
  );

  return (result.rows[0]?.catalog_item_id as CatalogItemId | undefined) ?? null;
}

async function findCatalogItemIdsForDeterministicPokemonCardFields(
  db: CatalogProviderDuplicatePreventionDb,
  input: {
    normalized: SourceObservationPokemonCardNormalized;
    catalog: CatalogProviderPromotionResolvedCatalogMapping;
    rule: Extract<
      CatalogProviderDuplicatePreventionIdentityRule,
      { matchKind: "deterministic-pokemon-card-field-match" }
    >;
    expansionReferenceId: ReferenceRecordId;
  },
): Promise<readonly CatalogItemId[]> {
  const fieldValues = fieldValuesForRule(input.normalized, input.catalog.fieldIds, input.rule.fieldMatches);
  const expansionField = [
    {
      fieldId: input.catalog.fieldIds[input.rule.referenceRecord.targetFieldKey],
      value: { referenceId: input.expansionReferenceId },
    },
  ];
  const fieldPredicates = [...fieldValues, expansionField];
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT item.catalog_item_id
     FROM catalog_items AS item
     WHERE item.status NOT IN ('archived', 'removed')
       AND item.language_code = $1
       ${fieldPredicates.map((_, index) => `AND item.field_values @> $${index + 2}::jsonb`).join("\n       ")}
     ORDER BY item.updated_at DESC, item.catalog_item_id ASC`,
    [input.normalized.languageCode, ...fieldPredicates.map((fieldValue) => JSON.stringify(fieldValue))],
  );

  return uniqueCatalogItemIds(result.rows.map((row) => row.catalog_item_id));
}

async function findCatalogItemIdsForDeterministicMagicCatalogItemFields(
  db: CatalogProviderDuplicatePreventionDb,
  input: {
    normalized: SourceObservationMagicCardPrintNormalized | SourceObservationMagicSealedProductNormalized;
    catalog: CatalogProviderPromotionResolvedCatalogMapping;
    rule: Extract<
      CatalogProviderDuplicatePreventionIdentityRule,
      { matchKind: "deterministic-magic-catalog-item-field-match" }
    >;
    setReferenceId: ReferenceRecordId;
  },
): Promise<readonly CatalogItemId[]> {
  const fieldValues = fieldValuesForRule(input.normalized, input.catalog.fieldIds, input.rule.fieldMatches);
  if (fieldValues.length !== input.rule.fieldMatches.length) {
    return [];
  }
  const setFieldId = input.catalog.fieldIds[input.rule.referenceRecord.targetFieldKey];
  if (!setFieldId) {
    return [];
  }

  const setField = [
    {
      fieldId: setFieldId,
      value: { referenceId: input.setReferenceId },
    },
  ];
  const fieldPredicates = [...fieldValues, setField];
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT item.catalog_item_id
     FROM catalog_items AS item
     WHERE item.status NOT IN ('archived', 'removed')
       AND item.language_code = $1
       ${fieldPredicates.map((_, index) => `AND item.field_values @> $${index + 2}::jsonb`).join("\n       ")}
     ORDER BY item.updated_at DESC, item.catalog_item_id ASC`,
    [input.normalized.languageCode, ...fieldPredicates.map((fieldValue) => JSON.stringify(fieldValue))],
  );

  return uniqueCatalogItemIds(result.rows.map((row) => row.catalog_item_id));
}

async function findCatalogItemIdsForDeterministicOnePieceCatalogItemFields(
  db: CatalogProviderDuplicatePreventionDb,
  input: {
    normalized: SourceObservationOnePieceCardPrintNormalized | SourceObservationOnePieceSealedProductNormalized;
    catalog: CatalogProviderPromotionResolvedCatalogMapping;
    rule: Extract<
      CatalogProviderDuplicatePreventionIdentityRule,
      { matchKind: "deterministic-one-piece-catalog-item-field-match" }
    >;
    setReferenceId: ReferenceRecordId;
  },
): Promise<readonly CatalogItemId[]> {
  const fieldValues = fieldValuesForRule(input.normalized, input.catalog.fieldIds, input.rule.fieldMatches);
  if (fieldValues.length !== input.rule.fieldMatches.length) {
    return [];
  }
  const setFieldId = input.catalog.fieldIds[input.rule.referenceRecord.targetFieldKey];
  if (!setFieldId) {
    return [];
  }

  const setField = [
    {
      fieldId: setFieldId,
      value: { referenceId: input.setReferenceId },
    },
  ];
  const fieldPredicates = [...fieldValues, setField];
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT item.catalog_item_id
     FROM catalog_items AS item
     WHERE item.status NOT IN ('archived', 'removed')
       AND item.language_code = $1
       ${fieldPredicates.map((_, index) => `AND item.field_values @> $${index + 2}::jsonb`).join("\n       ")}
     ORDER BY item.updated_at DESC, item.catalog_item_id ASC`,
    [input.normalized.languageCode, ...fieldPredicates.map((fieldValue) => JSON.stringify(fieldValue))],
  );

  return uniqueCatalogItemIds(result.rows.map((row) => row.catalog_item_id));
}

async function findPartialDraftCatalogItemIdForPokemonCard(
  db: CatalogProviderDuplicatePreventionDb,
  input: {
    profile: CatalogProviderIntegrationProfile;
    normalized: SourceObservationPokemonCardNormalized;
    catalog: CatalogProviderPromotionResolvedCatalogMapping;
    rule: Extract<
      CatalogProviderDuplicatePreventionIdentityRule,
      { matchKind: "partial-draft-pokemon-card-field-match" }
    >;
  },
): Promise<CatalogItemId | null> {
  const reusableTags = input.rule.requiredTags.flatMap((tagRule) =>
    tagValueForRule(tagRule, input.profile, input.normalized),
  );
  const fieldValues = fieldValuesForRule(input.normalized, input.catalog.fieldIds, input.rule.fieldMatches);
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT item.catalog_item_id
     FROM catalog_items AS item
     LEFT JOIN catalog_external_product_references AS reference
       ON reference.catalog_item_id = item.catalog_item_id
     WHERE item.status = 'draft'
       AND item.language_code = $1
       AND item.tags @> $2::jsonb
       ${fieldValues.map((_, index) => `AND item.field_values @> $${index + 3}::jsonb`).join("\n       ")}
       AND reference.catalog_item_id IS NULL
     ORDER BY item.updated_at DESC, item.catalog_item_id ASC
     LIMIT 1`,
    [
      input.normalized.languageCode,
      JSON.stringify(reusableTags),
      ...fieldValues.map((fieldValue) => JSON.stringify(fieldValue)),
    ],
  );

  return (result.rows[0]?.catalog_item_id as CatalogItemId | undefined) ?? null;
}

async function findReferenceRecordByTypeAndKey(
  db: CatalogProviderDuplicatePreventionDb,
  typeKey: string,
  key: string,
): Promise<ReferenceRecordId | null> {
  const existing = await db.query<{ reference_record_id: string }>(
    `SELECT reference_record_id
     FROM catalog_reference_records
     WHERE type_key = $1
       AND key = $2
     LIMIT 1`,
    [typeKey, key],
  );

  return (existing.rows[0]?.reference_record_id as ReferenceRecordId | undefined) ?? null;
}

function fieldValuesForRule(
  normalized: SourceObservationNormalized,
  fieldIds: CatalogProviderPromotionResolvedCatalogMapping["fieldIds"],
  fieldMatches: readonly {
    fieldKey: keyof CatalogProviderPromotionResolvedCatalogMapping["fieldIds"];
    valuePath: string;
    valueTransform?: "localized-text";
  }[],
) {
  return fieldMatches.flatMap((fieldMatch) => {
    const value = valueAtPath(normalized, fieldMatch.valuePath);
    if (value === undefined || value === null) {
      return [];
    }
    const fieldId = fieldIds[fieldMatch.fieldKey];
    if (!fieldId) {
      return [];
    }
    return [
      {
        fieldId,
        value:
          fieldMatch.valueTransform === "localized-text" && typeof value === "string"
            ? localizedJsonText(value)
            : value,
      },
    ];
  });
}

function tagValueForRule(
  rule: CatalogProviderDuplicatePreventionTagRule,
  profile: CatalogProviderIntegrationProfile,
  normalized: SourceObservationPokemonCardNormalized,
): readonly string[] {
  if (rule.kind === "profile-provider-key") {
    return [profile.providerKey];
  }
  if (rule.kind === "static") {
    return rule.value ? [rule.value] : [];
  }
  if (!rule.template || !rule.values) {
    return [];
  }

  return [
    Object.entries(rule.values).reduce(
      (tag, [key, path]) => tag.replaceAll(`{${key}}`, stringAtPath(normalized, path) ?? ""),
      rule.template,
    ),
  ];
}

function uniqueExternalCatalogItemReferences(
  references: readonly NonNullable<SourceObservationNormalized["externalCatalogItemReferences"]>[number][],
) {
  const seen = new Set<string>();
  return references
    .map((reference) => ({
      providerKey: reference.providerKey.trim().toLowerCase(),
      externalKey: reference.externalKey.trim().toLowerCase(),
    }))
    .filter((reference) => reference.providerKey.length > 0 && reference.externalKey.length > 0)
    .filter((reference) => {
      const key = `${reference.providerKey}:${reference.externalKey}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function uniqueExternalProductReferences(
  references: readonly NonNullable<SourceObservationNormalized["externalProductReferences"]>[number][],
) {
  const seen = new Set<string>();
  return references
    .map((reference) => ({
      providerKey: reference.providerKey.trim().toLowerCase(),
      externalKey: reference.externalKey.trim().toLowerCase(),
    }))
    .filter((reference) => reference.providerKey.length > 0 && reference.externalKey.length > 0)
    .filter((reference) => {
      const key = `${reference.providerKey}:${reference.externalKey}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function uniqueCatalogItemIds(values: readonly string[]): readonly CatalogItemId[] {
  return uniqueStrings(values).map((value) => value as CatalogItemId);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function ambiguousDiagnosticText(rule: CatalogProviderDuplicatePreventionIdentityRule): string {
  if (rule.matchKind === "exact-external-catalog-item-reference") {
    return "Multiple Catalog Items match this Source Observation's external catalog item references.";
  }
  if (rule.matchKind === "deterministic-pokemon-card-field-match") {
    return "Multiple Catalog Items match this Source Observation's deterministic card evidence.";
  }
  if (rule.matchKind === "deterministic-magic-catalog-item-field-match") {
    return "Multiple Catalog Items match this Source Observation's deterministic Magic identity evidence.";
  }
  if (rule.matchKind === "deterministic-one-piece-catalog-item-field-match") {
    return "Multiple Catalog Items match this Source Observation's deterministic One Piece identity evidence.";
  }
  return `Multiple Catalog Items match this Source Observation's duplicate-prevention rule '${rule.ruleKey}'.`;
}

function localizedJsonText(value: string): JsonObject {
  return {
    defaultLocale: "en",
    values: {
      en: value,
    },
  };
}

function normalizeReferenceKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function stringAtPath(value: JsonValue, path: string): string | null {
  const found = valueAtPath(value, path);
  if (typeof found === "string" || typeof found === "number" || typeof found === "boolean") {
    const normalized = String(found).trim();
    return normalized ? normalized : null;
  }
  return null;
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

function isJsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
