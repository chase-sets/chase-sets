import { createHash } from "node:crypto";
import { t } from "@chase-sets/localization";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type {
  CatalogMergeCandidateConflict,
  CatalogMergeCandidateExternalCatalogItemReference,
  CatalogMergeCandidateExternalProductReference,
  CatalogMergeCandidateFieldProvenance,
  CatalogMergeCandidateIdentity,
  CatalogMergeCandidateObservationMember,
  CatalogMergeCandidateReviewSnapshot,
  CatalogMergeCandidateSelectedOptionReference,
  CatalogMergeCandidateWarning,
} from "../domain/catalog-merge-candidate";
import type {
  SourceObservationExternalCatalogItemReference,
  SourceObservationExternalProductReference,
  SourceObservationMergeIdentity,
  SourceObservationNormalized,
} from "../domain/domain";
import type { SourceObservationListRow } from "../read-model/queries";

export type CatalogMergeCandidateMatchResult = Readonly<{
  candidateId: string;
  snapshot: CatalogMergeCandidateReviewSnapshot;
}>;

type CandidateFieldKey =
  | "name"
  | "setName"
  | "expansionName"
  | "collectorNumber"
  | "rarity"
  | "releaseDate"
  | "releaseYear"
  | "productLineName"
  | "productForm"
  | "barcode";

type CandidateFieldSpec = Readonly<{
  factKey: string;
  fieldPath: string;
  read: (row: SourceObservationListRow, identity: CatalogMergeCandidateIdentity) => JsonValue | undefined;
}>;

type CatalogMergeCandidateConflictInput = Readonly<{
  code: string;
  message: string;
  fieldPath: string | null;
  observationIds: readonly string[];
  existingValue: JsonValue;
  proposedValue: JsonValue;
}>;

const CANDIDATE_FIELD_SPECS: readonly CandidateFieldSpec[] = [
  {
    factKey: "name",
    fieldPath: "catalogItem.name",
    read: (row, identity) => stringFact(row.normalized.name) ?? identity.printedProductName,
  },
  {
    factKey: "setName",
    fieldPath: "catalogItem.setName",
    read: (row, identity) => stringFact(row.normalized.setName) ?? identity.setName ?? undefined,
  },
  {
    factKey: "expansionName",
    fieldPath: "catalogItem.expansionName",
    read: (row) => stringFact(row.normalized.expansionName),
  },
  {
    factKey: "collectorNumber",
    fieldPath: "catalogItem.collectorNumber",
    read: (row, identity) => stringFact(row.normalized.cardNumber) ?? identity.collectorNumber ?? undefined,
  },
  {
    factKey: "rarity",
    fieldPath: "catalogItem.rarity",
    read: (row) => stringFact(valueAt(row.normalized, "rarity")),
  },
  {
    factKey: "releaseDate",
    fieldPath: "catalogItem.releaseDate",
    read: (row) => stringFact(valueAt(row.normalized, "releaseDate")),
  },
  {
    factKey: "releaseYear",
    fieldPath: "catalogItem.releaseYear",
    read: (row) => numberFact(valueAt(row.normalized, "releaseYear")),
  },
  {
    factKey: "productLineName",
    fieldPath: "catalogItem.productLineName",
    read: (row, identity) =>
      stringFact(valueAt(row.normalized, "productLineName")) ?? identity.productLineName ?? undefined,
  },
  {
    factKey: "productForm",
    fieldPath: "catalogItem.productForm",
    read: (row, identity) =>
      stringFact(valueAt(row.normalized, "sealedProductForm")) ??
      stringFact(row.normalized.kind) ??
      identity.productForm ??
      undefined,
  },
  {
    factKey: "barcode",
    fieldPath: "catalogItem.barcode",
    read: (row, identity) => stringFact(valueAt(row.normalized, "barcode")) ?? identity.barcode ?? undefined,
  },
];

export function buildCatalogMergeCandidatesFromObservations(
  observations: readonly SourceObservationListRow[],
  input: { addedAt: string },
): readonly CatalogMergeCandidateMatchResult[] {
  const eligible = observations
    .map(toMatchableObservation)
    .filter((observation): observation is MatchableObservation => observation !== null)
    .sort((left, right) => left.row.observation_id.localeCompare(right.row.observation_id));
  if (eligible.length === 0) {
    return [];
  }

  return connectedGroups(eligible)
    .map((group) => candidateFromGroup(group, input.addedAt))
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

type MatchableObservation = Readonly<{
  row: SourceObservationListRow;
  identity: CatalogMergeCandidateIdentity;
  identityFingerprint: string;
  externalCatalogItemReferences: readonly CatalogMergeCandidateExternalCatalogItemReference[];
  externalProductReferences: readonly CatalogMergeCandidateExternalProductReference[];
}>;

function toMatchableObservation(row: SourceObservationListRow): MatchableObservation | null {
  const identity = candidateIdentityFor(row.normalized);
  if (!identity) {
    return null;
  }

  return {
    row,
    identity,
    identityFingerprint: fingerprintIdentity(identity),
    externalCatalogItemReferences: normalizeExternalCatalogItemReferences(row.normalized.externalCatalogItemReferences),
    externalProductReferences: normalizeExternalProductReferences([
      ...(row.normalized.externalProductReferences ?? []),
      ...((row.normalized.kind === "provider-product" ? row.normalized.skuReferences : []) ?? []),
    ]),
  };
}

function candidateFromGroup(group: readonly MatchableObservation[], addedAt: string): CatalogMergeCandidateMatchResult {
  const representative = group[0];
  if (!representative) {
    throw new Error("Catalog Merge Candidate matching requires at least one observation.");
  }
  const identity = representative.identity;
  const syncRunIds = sortedUnique(group.flatMap((entry) => entry.row.sync_run_id ?? []));
  const membership = group.map(
    (entry): CatalogMergeCandidateObservationMember => ({
      observationId: entry.row.observation_id,
      syncRunId: entry.row.sync_run_id,
      providerKey: entry.row.provider_key,
      externalKey: entry.row.external_key,
      sourceRecordHash: entry.row.source_record_hash,
      sourceProfileKey: entry.row.source_profile_key,
      sourceProfileVersion: entry.row.source_profile_version,
      sourceMappingFingerprint: entry.row.source_mapping_fingerprint,
      observedAt: entry.row.observed_at,
      addedAt,
    }),
  );
  const fieldProjection = projectCandidateFields(group, identity);
  const externalCatalogItemReferences = uniqueBy(
    group.flatMap((entry) => entry.externalCatalogItemReferences),
    (reference) => `${reference.providerKey}:${reference.externalKey}`,
  );
  const externalProductReferences = uniqueBy(
    group.flatMap((entry) => entry.externalProductReferences),
    (reference) => `${reference.providerKey}:${reference.externalKey}`,
  );
  const identityConflicts = conflictingIdentities(group);
  const referenceConflicts = repeatedExternalCatalogReferences(group);
  const matchedCatalogItemIds = sortedUnique(group.flatMap((entry) => entry.row.promoted_catalog_item_id ?? []));
  const matchConflicts =
    matchedCatalogItemIds.length <= 1
      ? []
      : [
          conflict({
            code: "multiple-existing-catalog-items",
            message: t(
              "catalog.features.sourceObservations.api.catalogMergeCandidateMatcher.conflict.multipleExistingCatalogItems",
            ),
            fieldPath: "matches.catalogItemId",
            observationIds: group.map((entry) => entry.row.observation_id),
            existingValue: matchedCatalogItemIds,
            proposedValue: matchedCatalogItemIds[0] ?? null,
          }),
        ];

  const snapshot: CatalogMergeCandidateReviewSnapshot = {
    identityFingerprint: representative.identityFingerprint,
    syncRunIds,
    identity,
    membership,
    matches: {
      catalogItemId: matchedCatalogItemIds.length === 1 ? (matchedCatalogItemIds[0] ?? null) : null,
      productIds: [],
    },
    proposedCatalogItemFacts: fieldProjection.facts,
    proposedExternalCatalogItemReferences: externalCatalogItemReferences,
    proposedExternalProductReferences: externalProductReferences,
    conflicts: [...identityConflicts, ...fieldProjection.conflicts, ...referenceConflicts, ...matchConflicts],
    warnings: fieldProjection.warnings,
    fieldProvenance: fieldProjection.provenance,
    promotionIntent: matchedCatalogItemIds.length === 1 ? "update-catalog-item" : "create-catalog-item",
  };

  return {
    candidateId: candidateIdFor(representative.identityFingerprint),
    snapshot,
  };
}

function connectedGroups(observations: readonly MatchableObservation[]): readonly MatchableObservation[][] {
  const parent = new Map<string, string>();
  const byObservationId = new Map(observations.map((observation) => [observation.row.observation_id, observation]));
  for (const observation of observations) {
    parent.set(observation.row.observation_id, observation.row.observation_id);
  }

  connectByKey(observations, parent, (observation) => [`identity:${observation.identityFingerprint}`]);
  connectByKey(observations, parent, (observation) =>
    observation.externalCatalogItemReferences.map(
      (reference) => `external:${reference.providerKey}:${reference.externalKey.toLowerCase()}`,
    ),
  );

  const groups = new Map<string, MatchableObservation[]>();
  for (const observation of observations) {
    const root = find(parent, observation.row.observation_id);
    groups.set(root, [...(groups.get(root) ?? []), observation]);
  }

  return [...groups.values()].map((group) =>
    group.sort((left, right) => left.row.observation_id.localeCompare(right.row.observation_id)),
  );
}

function connectByKey(
  observations: readonly MatchableObservation[],
  parent: Map<string, string>,
  keysFor: (observation: MatchableObservation) => readonly string[],
): void {
  const firstByKey = new Map<string, string>();
  for (const observation of observations) {
    for (const key of keysFor(observation)) {
      const existing = firstByKey.get(key);
      if (existing) {
        union(parent, existing, observation.row.observation_id);
      } else {
        firstByKey.set(key, observation.row.observation_id);
      }
    }
  }
}

function projectCandidateFields(
  group: readonly MatchableObservation[],
  identity: CatalogMergeCandidateIdentity,
): Readonly<{
  facts: JsonObject;
  conflicts: readonly CatalogMergeCandidateConflict[];
  warnings: readonly CatalogMergeCandidateWarning[];
  provenance: readonly CatalogMergeCandidateFieldProvenance[];
}> {
  const facts: Record<string, JsonValue> = {};
  const conflicts: CatalogMergeCandidateConflict[] = [];
  const warnings: CatalogMergeCandidateWarning[] = [];
  const provenance: CatalogMergeCandidateFieldProvenance[] = [];

  for (const spec of CANDIDATE_FIELD_SPECS) {
    const entries = group.flatMap((entry) => {
      const value = spec.read(entry.row, identity);
      return value === undefined || value === null || value === "" ? [] : [{ entry, value }];
    });
    if (entries.length === 0) {
      continue;
    }

    const first = entries[0];
    if (!first) {
      continue;
    }
    facts[spec.factKey] = first.value;
    provenance.push(provenanceEntry(spec.fieldPath, first.value, first.entry, entries.length === 1 ? "exact" : "high"));
    const distinctValues = uniqueJsonValues(entries.map((entry) => entry.value));
    if (distinctValues.length > 1) {
      conflicts.push(
        conflict({
          code: `${spec.factKey}-mismatch`,
          message: t("catalog.features.sourceObservations.api.catalogMergeCandidateMatcher.conflict.fieldMismatch", {
            field: spec.factKey,
          }),
          fieldPath: spec.fieldPath,
          observationIds: entries.map((entry) => entry.entry.row.observation_id),
          existingValue: distinctValues.slice(1),
          proposedValue: first.value,
        }),
      );
      for (const entry of entries.slice(1)) {
        provenance.push(provenanceEntry(spec.fieldPath, entry.value, entry.entry, "candidate"));
      }
    }
  }

  const imageEntries = group.flatMap((entry) => {
    const urls = Array.isArray(entry.row.normalized.imageUrls) ? entry.row.normalized.imageUrls : [];
    return urls.length === 0 ? [] : [{ entry, value: urls }];
  });
  if (uniqueJsonValues(imageEntries.map((entry) => entry.value)).length > 1) {
    warnings.push({
      code: "image-source-differs",
      message: t("catalog.features.sourceObservations.api.catalogMergeCandidateMatcher.warning.imageSourceDiffers"),
      fieldPath: "catalogItem.imageUrls",
      observationIds: imageEntries.map((entry) => entry.entry.row.observation_id),
    });
  }

  return { facts, conflicts, warnings, provenance };
}

function candidateIdentityFor(normalized: SourceObservationNormalized): CatalogMergeCandidateIdentity | null {
  const declared = normalized.mergeIdentity;
  const identity: SourceObservationMergeIdentity = declared ?? {
    tcg: stringFact(valueAt(normalized, "tcg")) ?? "unknown",
    productLineName: stringFact(valueAt(normalized, "productLineName")) ?? stringFact(valueAt(normalized, "category")),
    setName: normalized.expansionName ?? normalized.setName ?? null,
    printedProductName: normalized.name,
    collectorNumber: normalized.cardNumber ?? null,
    languageCode: normalized.languageCode,
    productForm: stringFact(valueAt(normalized, "sealedProductForm")) ?? normalized.kind,
    barcode: stringFact(valueAt(normalized, "barcode")) ?? null,
  };

  const printedProductName = stringFact(identity.printedProductName);
  const productLineName =
    stringFact(identity.productLineName) ??
    stringFact(valueAt(normalized, "productLineName")) ??
    "Unknown Product Line";
  const languageCode = stringFact(identity.languageCode) ?? stringFact(normalized.languageCode);
  if (!printedProductName || !languageCode) {
    return null;
  }

  return {
    tcg: stringFact(identity.tcg)?.toLowerCase() ?? null,
    productLineName,
    setName: stringFact(identity.setName),
    printedProductName,
    collectorNumber: stringFact(identity.collectorNumber),
    languageCode: languageCode.toLowerCase(),
    productForm: stringFact(identity.productForm) ?? stringFact(normalized.kind),
    variantKey: stringFact(valueAt(normalized, "cardVariantKey")),
    barcode: stringFact(identity.barcode) ?? stringFact(valueAt(normalized, "barcode")),
  };
}

function conflictingIdentities(group: readonly MatchableObservation[]): readonly CatalogMergeCandidateConflict[] {
  const distinctFingerprints = sortedUnique(group.map((entry) => entry.identityFingerprint));
  if (distinctFingerprints.length <= 1) {
    return [];
  }

  return [
    conflict({
      code: "merge-identity-mismatch",
      message: t("catalog.features.sourceObservations.api.catalogMergeCandidateMatcher.conflict.mergeIdentityMismatch"),
      fieldPath: "identity",
      observationIds: group.map((entry) => entry.row.observation_id),
      existingValue: distinctFingerprints,
      proposedValue: group[0]?.identityFingerprint ?? null,
    }),
  ];
}

function repeatedExternalCatalogReferences(
  group: readonly MatchableObservation[],
): readonly CatalogMergeCandidateConflict[] {
  const byReference = new Map<string, MatchableObservation[]>();
  for (const entry of group) {
    for (const reference of entry.externalCatalogItemReferences) {
      const key = `${reference.providerKey}:${reference.externalKey.toLowerCase()}`;
      byReference.set(key, [...(byReference.get(key) ?? []), entry]);
    }
  }

  return [...byReference.entries()].flatMap(([key, entries]) => {
    const identities = sortedUnique(entries.map((entry) => entry.identityFingerprint));
    if (identities.length <= 1) {
      return [];
    }
    return [
      conflict({
        code: "repeated-external-catalog-item-reference",
        message: t(
          "catalog.features.sourceObservations.api.catalogMergeCandidateMatcher.conflict.repeatedExternalCatalogItemReference",
        ),
        fieldPath: "externalCatalogItemReferences",
        observationIds: entries.map((entry) => entry.row.observation_id),
        existingValue: key,
        proposedValue: identities,
      }),
    ];
  });
}

function normalizeExternalCatalogItemReferences(
  references: readonly SourceObservationExternalCatalogItemReference[] | undefined,
): CatalogMergeCandidateExternalCatalogItemReference[] {
  return uniqueBy(
    (references ?? []).flatMap((reference) => {
      const providerKey = stringFact(reference.providerKey)?.toLowerCase();
      const externalKey = stringFact(reference.externalKey);
      return providerKey && externalKey ? [{ providerKey, externalKey }] : [];
    }),
    (reference) => `${reference.providerKey}:${reference.externalKey.toLowerCase()}`,
  );
}

function normalizeExternalProductReferences(
  references: readonly SourceObservationExternalProductReference[],
): CatalogMergeCandidateExternalProductReference[] {
  return uniqueBy(
    references.flatMap((reference) => {
      const providerKey = stringFact(reference.providerKey)?.toLowerCase();
      const externalKey = stringFact(reference.externalKey);
      if (!providerKey || !externalKey) {
        return [];
      }
      return [
        {
          providerKey,
          externalKey,
          selectedOptions: normalizeSelectedOptions(reference.selectedOptions ?? []),
          reviewEvidence: reference.reviewEvidence ?? null,
        },
      ];
    }),
    (reference) => `${reference.providerKey}:${reference.externalKey.toLowerCase()}`,
  );
}

function normalizeSelectedOptions(
  selectedOptions: readonly { dimensionId: string; optionId: string }[],
): CatalogMergeCandidateSelectedOptionReference[] {
  return uniqueBy(
    selectedOptions.flatMap((option) => {
      const dimensionId = stringFact(option.dimensionId);
      const optionId = stringFact(option.optionId);
      return dimensionId && optionId ? [{ dimensionId, optionId }] : [];
    }),
    (option) => `${option.dimensionId}:${option.optionId}`,
  );
}

function provenanceEntry(
  fieldPath: string,
  value: JsonValue,
  entry: MatchableObservation,
  confidence: CatalogMergeCandidateFieldProvenance["confidence"],
): CatalogMergeCandidateFieldProvenance {
  return {
    fieldPath,
    value,
    observationId: entry.row.observation_id,
    providerKey: entry.row.provider_key,
    sourceProfileKey: entry.row.source_profile_key,
    sourceProfileVersion: entry.row.source_profile_version,
    confidence,
    evidence: {
      sourceField: fieldPath.replace(/^catalogItem\./, ""),
      sourceMappingFingerprint: entry.row.source_mapping_fingerprint,
    },
  };
}

function conflict(input: CatalogMergeCandidateConflictInput): CatalogMergeCandidateConflict {
  return {
    ...input,
    severity: "blocking",
    observationIds: sortedUnique(input.observationIds),
  };
}

function fingerprintIdentity(identity: CatalogMergeCandidateIdentity): string {
  return `sha256:${hashJson({
    tcg: identity.tcg,
    productLineName: canonicalText(identity.productLineName),
    setName: canonicalText(identity.setName),
    printedProductName: canonicalText(identity.printedProductName),
    collectorNumber: canonicalText(identity.collectorNumber),
    languageCode: canonicalText(identity.languageCode),
    productForm: canonicalText(identity.productForm),
    variantKey: canonicalText(identity.variantKey),
    barcode: canonicalText(identity.barcode),
  })}`;
}

function candidateIdFor(identityFingerprint: string): string {
  return `cand_${identityFingerprint.replace(/^sha256:/, "").slice(0, 24)}`;
}

function hashJson(value: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function valueAt(value: JsonObject, key: string): JsonValue | undefined {
  return value[key];
}

function stringFact(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberFact(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function canonicalText(value: string | null): string | null {
  return value?.trim().toLowerCase() || null;
}

function uniqueBy<T>(values: readonly T[], keyFor: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = keyFor(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function uniqueJsonValues(values: readonly JsonValue[]): readonly JsonValue[] {
  return uniqueBy(values, (value) => JSON.stringify(value));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function find(parent: Map<string, string>, value: string): string {
  const current = parent.get(value) ?? value;
  if (current === value) {
    return current;
  }
  const root = find(parent, current);
  parent.set(value, root);
  return root;
}

function union(parent: Map<string, string>, left: string, right: string): void {
  const leftRoot = find(parent, left);
  const rightRoot = find(parent, right);
  if (leftRoot !== rightRoot) {
    parent.set(rightRoot, leftRoot);
  }
}
