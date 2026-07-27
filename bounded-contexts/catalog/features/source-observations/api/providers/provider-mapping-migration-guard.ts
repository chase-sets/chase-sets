import type { JsonValue } from "@chase-sets/primitives/json";
import type {
  SourceObservationExternalCatalogItemReference,
  SourceObservationExternalProductReference,
  SourceObservationNormalized,
} from "../../domain/domain";
import type { CatalogProviderSourceObservationInput } from "../promotion/provider-source-observation-normalizer";

export type CatalogProviderMappingBreakingChangeCode =
  | "external-key-change"
  | "source-hash-change"
  | "selected-option-change"
  | "reference-target-level-change"
  | "promotion-plan-change";

export type CatalogProviderMappingMigrationDiagnostic = Readonly<{
  code: CatalogProviderMappingBreakingChangeCode;
  path: string;
  diagnosticText: string;
  previousValue: JsonValue;
  nextValue: JsonValue;
}>;

export type CatalogProviderMappingMigrationAssessment = Readonly<
  | {
      status: "compatible";
      diagnostics: readonly [];
    }
  | {
      status: "breaking-change";
      diagnostics: readonly CatalogProviderMappingMigrationDiagnostic[];
    }
>;

export function assessCatalogProviderMappingMigration(input: {
  previous: CatalogProviderSourceObservationInput;
  next: CatalogProviderSourceObservationInput;
  previousPromotionPlanFingerprint?: string | null;
  nextPromotionPlanFingerprint?: string | null;
}): CatalogProviderMappingMigrationAssessment {
  const diagnostics: CatalogProviderMappingMigrationDiagnostic[] = [];

  pushIfChanged(diagnostics, {
    code: "external-key-change",
    path: "sourceObservation.externalKey",
    previousValue: input.previous.externalKey,
    nextValue: input.next.externalKey,
    diagnosticText: "The mapping changes the Source Observation external key and may create duplicate rows.",
  });
  pushIfChanged(diagnostics, {
    code: "source-hash-change",
    path: "sourceObservation.sourceRecordHash",
    previousValue: input.previous.sourceRecordHash,
    nextValue: input.next.sourceRecordHash,
    diagnosticText: "The mapping changes source hash material and will mark existing observations as changed.",
  });
  pushIfChanged(diagnostics, {
    code: "selected-option-change",
    path: "normalized.externalProductReferences.selectedOptions",
    previousValue: selectedOptionFingerprintInput(input.previous.normalized),
    nextValue: selectedOptionFingerprintInput(input.next.normalized),
    diagnosticText: "The mapping changes Product selected-option evidence used by Inventory and Pricing consumers.",
  });
  pushIfChanged(diagnostics, {
    code: "reference-target-level-change",
    path: "normalized.externalReferences.targetLevel",
    previousValue: referenceTargetLevelFingerprintInput(input.previous.normalized),
    nextValue: referenceTargetLevelFingerprintInput(input.next.normalized),
    diagnosticText: "The mapping changes whether provider references target Catalog Items or Products.",
  });
  pushIfChanged(diagnostics, {
    code: "promotion-plan-change",
    path: "promotionCommandPlan",
    previousValue: input.previousPromotionPlanFingerprint ?? null,
    nextValue: input.nextPromotionPlanFingerprint ?? null,
    diagnosticText: "The mapping changes the Catalog Item promotion command plan.",
  });

  return diagnostics.length === 0
    ? { status: "compatible", diagnostics: [] }
    : { status: "breaking-change", diagnostics };
}

function pushIfChanged(
  diagnostics: CatalogProviderMappingMigrationDiagnostic[],
  input: CatalogProviderMappingMigrationDiagnostic,
) {
  if (JSON.stringify(input.previousValue) !== JSON.stringify(input.nextValue)) {
    diagnostics.push(input);
  }
}

function selectedOptionFingerprintInput(normalized: SourceObservationNormalized): JsonValue {
  const references = [
    ...(normalized.externalProductReferences ?? []),
    ...(normalized.kind === "provider-product" ? normalized.skuReferences : []),
  ];

  return references
    .map(productReferenceFingerprintInput)
    .sort((left, right) => left.externalKey.localeCompare(right.externalKey));
}

function productReferenceFingerprintInput(reference: SourceObservationExternalProductReference) {
  return {
    providerKey: reference.providerKey,
    externalKey: reference.externalKey,
    selectedOptions: [...(reference.selectedOptions ?? [])].sort((left, right) =>
      `${left.dimensionId}:${left.optionId}`.localeCompare(`${right.dimensionId}:${right.optionId}`),
    ),
  };
}

function referenceTargetLevelFingerprintInput(normalized: SourceObservationNormalized): JsonValue {
  return {
    catalogItemReferences: [...(normalized.externalCatalogItemReferences ?? [])]
      .map(catalogItemReferenceFingerprintInput)
      .sort((left, right) =>
        `${left.providerKey}:${left.externalKey}`.localeCompare(`${right.providerKey}:${right.externalKey}`),
      ),
    productReferences: [...(normalized.externalProductReferences ?? [])]
      .map((reference) => ({ providerKey: reference.providerKey, externalKey: reference.externalKey }))
      .sort((left, right) =>
        `${left.providerKey}:${left.externalKey}`.localeCompare(`${right.providerKey}:${right.externalKey}`),
      ),
  };
}

function catalogItemReferenceFingerprintInput(reference: SourceObservationExternalCatalogItemReference) {
  return {
    providerKey: reference.providerKey,
    externalKey: reference.externalKey,
  };
}
