import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type { CatalogItemCommand } from "../../catalog-items/domain/domain";
import type { BlueprintId, CatalogItemId, CategoryId, FieldId, ReferenceRecordId } from "../../../ids";
import type {
  CatalogMergeCandidateExternalCatalogItemReference,
  CatalogMergeCandidateExternalProductReference,
  CatalogMergeCandidateFieldProvenance,
  CatalogMergeCandidatePromotionIntent,
  CatalogMergeCandidateReviewSnapshot,
  CatalogMergeCandidateStatus,
} from "../domain/catalog-merge-candidate";
import type { CatalogMergeCandidateListRow } from "../read-model/queries";
import type { LocalizedTextMap } from "../../../support/runtime-support/common";
import type { ProductAssetSet } from "../../../support/runtime-support/product-assets";

export type CatalogMergeCandidatePromotionMode = "create" | "refresh" | "link-existing";

export type CatalogMergeCandidatePromotionFieldMapping = Readonly<
  {
    fieldPath: string;
    fieldId: FieldId;
    required?: boolean;
  } & (
    | Readonly<{
        valueKind: "raw";
        factKey: string;
      }>
    | Readonly<{
        valueKind: "localized-text";
        factKey: string;
      }>
    | Readonly<{
        valueKind: "reference-record";
        referenceRecordId: ReferenceRecordId | null;
      }>
  )
>;

export type CatalogMergeCandidatePromotionCatalogMapping = Readonly<{
  blueprintId: BlueprintId;
  categoryId: CategoryId;
  fields: readonly CatalogMergeCandidatePromotionFieldMapping[];
}>;

export type CatalogMergeCandidatePromotionAssetPlan = Readonly<{
  imageUrls?: readonly string[];
  productAssetSets?: readonly ProductAssetSet[];
}>;

export type CatalogMergeCandidatePromotionCandidate =
  | Readonly<{
      candidateId: string;
      status: CatalogMergeCandidateStatus;
      snapshot: CatalogMergeCandidateReviewSnapshot;
    }>
  | CatalogMergeCandidateListRow;

export type CatalogMergeCandidatePromotionPlanDiagnostic = Readonly<{
  code:
    | "candidate-not-ready"
    | "candidate-has-blocking-conflicts"
    | "conflicting-external-reference-level"
    | "missing-catalog-item-target"
    | "missing-create-catalog-item-id"
    | "missing-field-value"
    | "missing-reference-record-target"
    | "missing-title"
    | "external-product-reference-missing-selected-options"
    | "external-product-reference-duplicate-dimension"
    | "unsupported-promotion-intent";
  path: string;
  diagnosticText: string;
}>;

export type PromotableCatalogItemProductChange = Readonly<{
  changeKind: CatalogMergeCandidatePromotionIntent;
  catalogItemId: CatalogItemId;
  catalogItemFacts: JsonObject;
  fieldChanges: readonly CatalogMergeCandidatePromotionFieldChange[];
  externalCatalogItemReferences: readonly CatalogMergeCandidateExternalCatalogItemReference[];
  externalProductReferences: readonly CatalogMergeCandidateExternalProductReference[];
  assetPlan: CatalogMergeCandidatePromotionAssetPlan | null;
}>;

export type CatalogMergeCandidatePromotionFieldChange = Readonly<{
  fieldPath: string;
  fieldId: FieldId;
  value: JsonValue;
  provenance: readonly CatalogMergeCandidateFieldProvenance[];
}>;

export type CatalogMergeCandidatePromotionCommandPlan = Readonly<{
  planKind: "catalog-merge-candidate-promotion";
  candidateId: string;
  mode: CatalogMergeCandidatePromotionMode;
  catalogItemId: CatalogItemId;
  planFingerprint: string;
  requiresReview: true;
  commands: readonly CatalogItemCommand[];
  promotableChange: PromotableCatalogItemProductChange;
  review: Readonly<{
    commandCount: number;
    fieldChangeCount: number;
    catalogItemReferencesLinked: number;
    productReferencesLinked: number;
    provenanceEntryCount: number;
  }>;
}>;

export type CatalogMergeCandidatePromotionCommandPlanResult =
  | Readonly<{
      status: "planned";
      plan: CatalogMergeCandidatePromotionCommandPlan;
      diagnostics: readonly [];
    }>
  | Readonly<{
      status: "blocked";
      plan: null;
      diagnostics: readonly CatalogMergeCandidatePromotionPlanDiagnostic[];
    }>;

export function planCatalogMergeCandidatePromotionCommands(input: {
  candidate: CatalogMergeCandidatePromotionCandidate;
  catalog: CatalogMergeCandidatePromotionCatalogMapping;
  createCatalogItemId?: CatalogItemId | null;
  assetPlan?: CatalogMergeCandidatePromotionAssetPlan | null;
}): CatalogMergeCandidatePromotionCommandPlanResult {
  const candidate = normalizeCandidate(input.candidate);
  const diagnostics = candidatePromotionDiagnostics(candidate, input.catalog, input.createCatalogItemId ?? null);
  if (diagnostics.length > 0) {
    return { status: "blocked", plan: null, diagnostics };
  }

  const mode = modeForPromotionIntent(candidate.snapshot.promotionIntent);
  const catalogItemId =
    ((candidate.snapshot.matches.catalogItemId ?? input.createCatalogItemId) as CatalogItemId) ?? null;
  if (!catalogItemId) {
    return {
      status: "blocked",
      plan: null,
      diagnostics: [
        {
          code: "missing-create-catalog-item-id",
          path: "createCatalogItemId",
          diagnosticText: "Catalog Merge Candidate create planning requires the Catalog Item id that will be created.",
        },
      ],
    };
  }

  const fieldChanges = fieldChangesForCandidate(candidate.snapshot, input.catalog.fields);
  const assetPlan = normalizeAssetPlan(input.assetPlan ?? null);
  const commands = catalogItemCommandsForCandidatePromotion({
    mode,
    catalogItemId,
    snapshot: candidate.snapshot,
    catalog: input.catalog,
    fieldChanges,
    assetPlan,
  });
  const planFingerprint = catalogMergeCandidatePromotionPlanFingerprint({
    candidateId: candidate.candidateId,
    mode,
    catalogItemId,
    commands,
    fieldChanges,
  });

  return {
    status: "planned",
    plan: {
      planKind: "catalog-merge-candidate-promotion",
      candidateId: candidate.candidateId,
      mode,
      catalogItemId,
      planFingerprint,
      requiresReview: true,
      commands,
      promotableChange: {
        changeKind: candidate.snapshot.promotionIntent,
        catalogItemId,
        catalogItemFacts: candidate.snapshot.proposedCatalogItemFacts,
        fieldChanges,
        externalCatalogItemReferences: candidate.snapshot.proposedExternalCatalogItemReferences,
        externalProductReferences: candidate.snapshot.proposedExternalProductReferences,
        assetPlan,
      },
      review: {
        commandCount: commands.length,
        fieldChangeCount: fieldChanges.length,
        catalogItemReferencesLinked: candidate.snapshot.proposedExternalCatalogItemReferences.length,
        productReferencesLinked: candidate.snapshot.proposedExternalProductReferences.length,
        provenanceEntryCount: fieldChanges.reduce((total, change) => total + change.provenance.length, 0),
      },
    },
    diagnostics: [],
  };
}

function candidatePromotionDiagnostics(
  candidate: ReturnType<typeof normalizeCandidate>,
  catalog: CatalogMergeCandidatePromotionCatalogMapping,
  createCatalogItemId: CatalogItemId | null,
): CatalogMergeCandidatePromotionPlanDiagnostic[] {
  const diagnostics: CatalogMergeCandidatePromotionPlanDiagnostic[] = [];
  const snapshot = candidate.snapshot;

  if (candidate.status !== "ready") {
    diagnostics.push({
      code: "candidate-not-ready",
      path: "candidate.status",
      diagnosticText: `Catalog Merge Candidate '${candidate.candidateId}' is ${candidate.status}; only ready candidates can produce a promotable plan.`,
    });
  }

  for (const conflict of snapshot.conflicts.filter((conflict) => conflict.severity === "blocking")) {
    diagnostics.push({
      code: "candidate-has-blocking-conflicts",
      path: conflict.fieldPath ?? "candidate.conflicts",
      diagnosticText: conflict.message,
    });
  }

  if (
    (snapshot.promotionIntent === "update-catalog-item" || snapshot.promotionIntent === "link-existing-catalog-item") &&
    !snapshot.matches.catalogItemId
  ) {
    diagnostics.push({
      code: "missing-catalog-item-target",
      path: "candidate.snapshot.matches.catalogItemId",
      diagnosticText: "Catalog Merge Candidate update planning requires exactly one matched Catalog Item.",
    });
  }

  if (
    snapshot.promotionIntent !== "create-catalog-item" &&
    snapshot.promotionIntent !== "update-catalog-item" &&
    snapshot.promotionIntent !== "link-existing-catalog-item"
  ) {
    diagnostics.push({
      code: "unsupported-promotion-intent",
      path: "candidate.snapshot.promotionIntent",
      diagnosticText: `Catalog Merge Candidate promotion intent '${snapshot.promotionIntent}' is not supported.`,
    });
  }

  if (snapshot.promotionIntent === "create-catalog-item" && !createCatalogItemId) {
    diagnostics.push({
      code: "missing-create-catalog-item-id",
      path: "createCatalogItemId",
      diagnosticText: "Catalog Merge Candidate create planning requires the Catalog Item id that will be created.",
    });
  }

  if (!candidateTitle(snapshot)) {
    diagnostics.push({
      code: "missing-title",
      path: "candidate.snapshot.proposedCatalogItemFacts.name",
      diagnosticText: "Catalog Merge Candidate promotion requires a proposed name or printed product name.",
    });
  }

  const externalCatalogItemKeys = new Set(
    snapshot.proposedExternalCatalogItemReferences.map(
      (reference) => `${reference.providerKey.trim().toLowerCase()}:${reference.externalKey.trim().toLowerCase()}`,
    ),
  );
  for (const reference of snapshot.proposedExternalProductReferences) {
    const referenceKey = `${reference.providerKey.trim().toLowerCase()}:${reference.externalKey.trim().toLowerCase()}`;
    if (externalCatalogItemKeys.has(referenceKey)) {
      diagnostics.push({
        code: "conflicting-external-reference-level",
        path: "candidate.snapshot.proposedExternalProductReferences",
        diagnosticText: `External reference '${reference.providerKey}:${reference.externalKey}' cannot be both an External Catalog Item Reference and an External Product Reference.`,
      });
    }
    if (reference.selectedOptions.length === 0) {
      diagnostics.push({
        code: "external-product-reference-missing-selected-options",
        path: `candidate.snapshot.proposedExternalProductReferences.${reference.providerKey}:${reference.externalKey}.selectedOptions`,
        diagnosticText: `External Product Reference '${reference.providerKey}:${reference.externalKey}' requires selected Options so it resolves a Product.`,
      });
    }
    const selectedDimensions = reference.selectedOptions.map((option) => option.dimensionId.trim()).filter(Boolean);
    if (new Set(selectedDimensions).size !== selectedDimensions.length) {
      diagnostics.push({
        code: "external-product-reference-duplicate-dimension",
        path: `candidate.snapshot.proposedExternalProductReferences.${reference.providerKey}:${reference.externalKey}.selectedOptions`,
        diagnosticText: `External Product Reference '${reference.providerKey}:${reference.externalKey}' has more than one selected Option for the same Dimension.`,
      });
    }
  }

  for (const mapping of catalog.fields) {
    if (mapping.valueKind === "reference-record" && mapping.required && !mapping.referenceRecordId) {
      diagnostics.push({
        code: "missing-reference-record-target",
        path: `catalog.fields.${mapping.fieldPath}.referenceRecordId`,
        diagnosticText: `Catalog Merge Candidate promotion requires a Reference Record target for '${mapping.fieldPath}'.`,
      });
    }
    if (
      mapping.valueKind !== "reference-record" &&
      mapping.required &&
      factValue(snapshot.proposedCatalogItemFacts, mapping.factKey) === null
    ) {
      diagnostics.push({
        code: "missing-field-value",
        path: `candidate.snapshot.proposedCatalogItemFacts.${mapping.factKey}`,
        diagnosticText: `Catalog Merge Candidate promotion requires proposed fact '${mapping.factKey}'.`,
      });
    }
  }

  return diagnostics;
}

function catalogItemCommandsForCandidatePromotion(input: {
  mode: CatalogMergeCandidatePromotionMode;
  catalogItemId: CatalogItemId;
  snapshot: CatalogMergeCandidateReviewSnapshot;
  catalog: CatalogMergeCandidatePromotionCatalogMapping;
  fieldChanges: readonly CatalogMergeCandidatePromotionFieldChange[];
  assetPlan: CatalogMergeCandidatePromotionAssetPlan | null;
}): readonly CatalogItemCommand[] {
  const commands: CatalogItemCommand[] = [];
  const title = candidateTitle(input.snapshot);
  const subtitle = candidateSubtitle(input.snapshot);

  if (input.mode === "create") {
    commands.push({
      type: "CreateCatalogItem",
      itemId: input.catalogItemId,
      languageCode: input.snapshot.identity.languageCode,
      title: localizedText(title),
      subtitle: localizedText(subtitle),
      description: localizedText(""),
    });
    commands.push({
      type: "AssignBlueprintToCatalogItem",
      blueprintId: input.catalog.blueprintId,
    });
  } else if (input.mode === "refresh") {
    commands.push({
      type: "ReviseCatalogItemMetadata",
      languageCode: input.snapshot.identity.languageCode,
      title: localizedText(title),
      subtitle: localizedText(subtitle),
      description: localizedText(""),
    });
  }

  if (input.mode !== "link-existing") {
    for (const change of input.fieldChanges) {
      commands.push({
        type: "SetCatalogItemFieldValue",
        fieldId: change.fieldId,
        value: change.value,
      });
    }
  }

  if (input.mode === "create") {
    commands.push({
      type: "AssignCatalogItemToCategory",
      categoryId: input.catalog.categoryId,
    });
  }

  if (input.assetPlan?.imageUrls) {
    commands.push({ type: "SetCatalogItemImageUrls", imageUrls: input.assetPlan.imageUrls });
  }

  if (input.assetPlan?.productAssetSets) {
    commands.push({ type: "SetCatalogItemProductAssetSets", productAssetSets: input.assetPlan.productAssetSets });
  }

  for (const reference of input.snapshot.proposedExternalCatalogItemReferences) {
    commands.push({
      type: "LinkExternalCatalogItemReference",
      providerKey: reference.providerKey,
      externalKey: reference.externalKey,
    });
  }

  for (const reference of input.snapshot.proposedExternalProductReferences) {
    commands.push({
      type: "LinkExternalProductReference",
      providerKey: reference.providerKey,
      externalKey: reference.externalKey,
      selectedOptions: reference.selectedOptions,
    });
  }

  return commands;
}

function fieldChangesForCandidate(
  snapshot: CatalogMergeCandidateReviewSnapshot,
  mappings: readonly CatalogMergeCandidatePromotionFieldMapping[],
): readonly CatalogMergeCandidatePromotionFieldChange[] {
  return mappings.flatMap((mapping) => {
    const value = fieldMappingValue(snapshot.proposedCatalogItemFacts, mapping);
    if (value === null) {
      return [];
    }
    return [
      {
        fieldPath: mapping.fieldPath,
        fieldId: mapping.fieldId,
        value,
        provenance: snapshot.fieldProvenance.filter((entry) => entry.fieldPath === mapping.fieldPath),
      },
    ];
  });
}

function fieldMappingValue(facts: JsonObject, mapping: CatalogMergeCandidatePromotionFieldMapping): JsonValue | null {
  if (mapping.valueKind === "reference-record") {
    return mapping.referenceRecordId ? { referenceId: mapping.referenceRecordId } : null;
  }

  const value = factValue(facts, mapping.factKey);
  if (value === null) {
    return null;
  }

  return mapping.valueKind === "localized-text" && typeof value === "string" ? localizedJsonText(value) : value;
}

function factValue(facts: JsonObject, factKey: string): JsonValue | null {
  const value = facts[factKey];
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : null;
  }
  return value === undefined ? null : value;
}

function modeForPromotionIntent(intent: CatalogMergeCandidatePromotionIntent): CatalogMergeCandidatePromotionMode {
  switch (intent) {
    case "create-catalog-item":
      return "create";
    case "update-catalog-item":
      return "refresh";
    case "link-existing-catalog-item":
      return "link-existing";
  }
}

function normalizeCandidate(candidate: CatalogMergeCandidatePromotionCandidate): Readonly<{
  candidateId: string;
  status: CatalogMergeCandidateStatus;
  snapshot: CatalogMergeCandidateReviewSnapshot;
}> {
  if ("snapshot" in candidate) {
    return {
      candidateId: candidate.candidateId,
      status: candidate.status,
      snapshot: candidate.snapshot,
    };
  }

  return {
    candidateId: candidate.candidate_id,
    status: candidate.status,
    snapshot: {
      identityFingerprint: candidate.identity_fingerprint,
      syncRunIds: candidate.sync_run_ids_json,
      identity: candidate.identity_json,
      membership: [],
      matches: {
        catalogItemId: candidate.matched_catalog_item_id,
        productIds: candidate.matched_product_ids_json,
      },
      proposedCatalogItemFacts: asJsonObject(candidate.proposed_catalog_item_facts_json),
      proposedExternalCatalogItemReferences: candidate.proposed_external_catalog_item_references_json,
      proposedExternalProductReferences: candidate.proposed_external_product_references_json,
      conflicts: candidate.conflicts_json,
      warnings: candidate.warnings_json,
      fieldProvenance: candidate.field_provenance_json,
      promotionIntent: candidate.promotion_intent,
    },
  };
}

function candidateTitle(snapshot: CatalogMergeCandidateReviewSnapshot): string {
  return stringFact(snapshot.proposedCatalogItemFacts.name) ?? snapshot.identity.printedProductName;
}

function candidateSubtitle(snapshot: CatalogMergeCandidateReviewSnapshot): string {
  const parts = [snapshot.identity.setName, snapshot.identity.collectorNumber].flatMap((value) =>
    value?.trim() ? [value.trim()] : [],
  );
  return parts.join(" #");
}

function normalizeAssetPlan(
  assetPlan: CatalogMergeCandidatePromotionAssetPlan | null,
): CatalogMergeCandidatePromotionAssetPlan | null {
  if (!assetPlan) {
    return null;
  }
  return {
    ...(assetPlan.imageUrls ? { imageUrls: [...assetPlan.imageUrls] } : {}),
    ...(assetPlan.productAssetSets ? { productAssetSets: [...assetPlan.productAssetSets] } : {}),
  };
}

function asJsonObject(value: JsonValue): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringFact(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function localizedText(value: string): LocalizedTextMap {
  return {
    defaultLocale: "en",
    values: {
      en: value,
    },
  };
}

function localizedJsonText(value: string): JsonObject {
  return localizedText(value) as unknown as JsonObject;
}

export function catalogMergeCandidatePromotionPlanFingerprint(input: {
  candidateId: string;
  mode: CatalogMergeCandidatePromotionMode;
  catalogItemId: CatalogItemId;
  commands: readonly CatalogItemCommand[];
  fieldChanges: readonly CatalogMergeCandidatePromotionFieldChange[];
}): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        candidateId: input.candidateId,
        mode: input.mode,
        catalogItemId: input.catalogItemId,
        commands: input.commands,
        fieldChanges: input.fieldChanges,
      }),
    )
    .digest("hex")}`;
}
