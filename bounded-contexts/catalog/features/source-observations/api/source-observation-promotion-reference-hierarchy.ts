import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { toJsonValue, type JsonValue } from "@chase-sets/primitives/json";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { ReferenceRecordId, ReferenceTypeId } from "../../../ids";
import type { LocalizedTextMap } from "../../../support/runtime-support/common";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import type { ReferenceRelationship } from "../../reference-data/domain/domain";
import {
  type SourceObservationLorcanaCardPrintNormalized,
  type SourceObservationLorcanaSetReferenceNormalized,
  type SourceObservationLorcanaSealedProductNormalized,
  type SourceObservationMagicCardPrintNormalized,
  type SourceObservationMagicSetReferenceNormalized,
  type SourceObservationMagicSealedProductNormalized,
  type SourceObservationOnePieceCardPrintNormalized,
  type SourceObservationOnePieceSetReferenceNormalized,
  type SourceObservationOnePieceSealedProductNormalized,
  type SourceObservationPokemonCardNormalized,
  type SourceObservationPokemonSealedProductNormalized,
  type SourceObservationYugiohSealedProductNormalized,
} from "../domain/domain";
import { type CatalogProviderIntegrationProfile } from "./provider-integration-profiles";
import { provisionCatalogProviderReferenceHierarchy } from "./provider-reference-hierarchy-provisioner";

export type CatalogItemPromotableSourceObservationNormalized =
  | SourceObservationPokemonCardNormalized
  | SourceObservationPokemonSealedProductNormalized
  | SourceObservationMagicCardPrintNormalized
  | SourceObservationMagicSealedProductNormalized
  | SourceObservationLorcanaCardPrintNormalized
  | SourceObservationLorcanaSealedProductNormalized
  | SourceObservationOnePieceCardPrintNormalized
  | SourceObservationOnePieceSealedProductNormalized
  | SourceObservationYugiohSealedProductNormalized;

export type ReferenceHierarchySourceObservationNormalized =
  | CatalogItemPromotableSourceObservationNormalized
  | SourceObservationMagicSetReferenceNormalized
  | SourceObservationLorcanaSetReferenceNormalized
  | SourceObservationOnePieceSetReferenceNormalized;

export async function ensurePokemonReferenceHierarchy(input: {
  deps: CatalogRuntimeDeps;
  referenceData: ReferenceDataServices;
  profile: CatalogProviderIntegrationProfile;
  normalized: SourceObservationPokemonCardNormalized;
  context: EventStoreContext;
}): Promise<ReferenceRecordId> {
  const result = await resolvePokemonReferenceHierarchy(input);
  return result.targetReferenceRecordId;
}

/**
 * Provision the Pokemon Reference Type/Record hierarchy and return the resolved
 * target (expansion) record id plus a map of every reference type key to its
 * resolved record id. Promotion alias planning needs the per-type-key
 * map so set-equivalent / series-equivalent aliases can resolve their Reference
 * Record id before they become Catalog facts.
 */
export async function resolvePokemonReferenceHierarchy(input: {
  deps: CatalogRuntimeDeps;
  referenceData: ReferenceDataServices;
  profile: CatalogProviderIntegrationProfile;
  normalized: SourceObservationPokemonCardNormalized;
  context: EventStoreContext;
}): Promise<{
  targetReferenceRecordId: ReferenceRecordId;
  referenceRecordIdsByTypeKey: Readonly<Record<string, string>>;
}> {
  return resolvePromotionReferenceHierarchy(input);
}

export async function resolvePromotionReferenceHierarchy(input: {
  deps: CatalogRuntimeDeps;
  referenceData: ReferenceDataServices;
  profile: CatalogProviderIntegrationProfile;
  normalized: ReferenceHierarchySourceObservationNormalized;
  context: EventStoreContext;
}): Promise<{
  targetReferenceRecordId: ReferenceRecordId;
  referenceRecordIdsByTypeKey: Readonly<Record<string, string>>;
}> {
  if (input.normalized.kind === "yugioh-sealed-product") {
    return resolveYugiohSealedProductSetReference({
      deps: input.deps,
      normalized: input.normalized,
    });
  }

  const result = await provisionCatalogProviderReferenceHierarchy({
    profile: input.profile,
    payload: promotionReferenceHierarchyPayload(input.normalized),
    provisioner: {
      ensureReferenceType: (def) => ensureReferenceType(input, def),
      ensureReferenceRecord: (def) => ensureReferenceRecord(input, def),
    },
  });

  const referenceRecordIdsByTypeKey: Record<string, string> = {};
  for (const recordRule of input.profile.referenceHierarchyMapping.referenceRecords) {
    const referenceRecordId = result.referenceRecordIdsByRuleKey.get(recordRule.ruleKey);
    if (referenceRecordId) {
      // Last rule per type key wins; expansion/series each have a single rule.
      referenceRecordIdsByTypeKey[recordRule.typeKey.trim().toLowerCase()] = referenceRecordId;
    }
  }

  return {
    targetReferenceRecordId: result.targetReferenceRecordId,
    referenceRecordIdsByTypeKey,
  };
}

export async function resolveYugiohSealedProductSetReference(input: {
  deps: CatalogRuntimeDeps;
  normalized: SourceObservationYugiohSealedProductNormalized;
}): Promise<{
  targetReferenceRecordId: ReferenceRecordId;
  referenceRecordIdsByTypeKey: Readonly<Record<string, string>>;
}> {
  const setIds = Array.from(
    new Set(
      (input.normalized.boxOfSetEvidence ?? [])
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );

  if (setIds.length === 0) {
    throw new Error(
      "YGOJSON sealed product promotion is blocked because no Yu-Gi-Oh! Set Reference Record id was observed in boxOf evidence.",
    );
  }
  if (setIds.length > 1) {
    throw new Error(
      `YGOJSON sealed product promotion is blocked because boxOf evidence resolves ambiguously to ${setIds.length} Yu-Gi-Oh! sets.`,
    );
  }

  const setId = setIds[0] as string;
  const matches = await input.deps.db.query<{ reference_record_id: string }>(
    `SELECT reference_record_id
     FROM catalog_reference_records
     WHERE type_key = $1
       AND attributes ->> $2 = $3
     ORDER BY reference_record_id ASC`,
    ["set", "ygojson-set-id", setId],
  );

  if (matches.rows.length === 0) {
    throw new Error(
      `YGOJSON sealed product promotion is blocked because Yu-Gi-Oh! Set Reference Record '${setId}' is missing.`,
    );
  }
  if (matches.rows.length > 1) {
    throw new Error(
      `YGOJSON sealed product promotion is blocked because Yu-Gi-Oh! Set Reference Record '${setId}' is ambiguous (${matches.rows.length} matches).`,
    );
  }

  const targetReferenceRecordId = matches.rows[0]?.reference_record_id as ReferenceRecordId;
  return {
    targetReferenceRecordId,
    referenceRecordIdsByTypeKey: { set: targetReferenceRecordId },
  };
}

export async function resolveReferenceDataPromotionHierarchy(input: {
  deps: CatalogRuntimeDeps;
  referenceData: ReferenceDataServices;
  profile: CatalogProviderIntegrationProfile;
  normalized:
    | SourceObservationMagicSetReferenceNormalized
    | SourceObservationLorcanaSetReferenceNormalized
    | SourceObservationOnePieceSetReferenceNormalized;
  context: EventStoreContext;
}): Promise<{
  targetReferenceRecordId: ReferenceRecordId;
  referenceRecordIdsByTypeKey: Readonly<Record<string, string>>;
}> {
  return resolvePromotionReferenceHierarchy(input);
}

function promotionReferenceHierarchyPayload(normalized: ReferenceHierarchySourceObservationNormalized): JsonValue {
  if (normalized.kind === "magic-set-reference") {
    return toJsonValue({
      ...normalized,
      set: {
        code: normalized.setCode,
        name: normalized.setName,
      },
      set_name: normalized.setName,
    });
  }

  if (normalized.kind === "one-piece-set-reference") {
    return toJsonValue({
      ...normalized,
      expansion: {
        id: normalized.setId,
        code: normalized.setCode,
        name: normalized.setName,
        release_date: normalized.releaseDate,
      },
      set: {
        code: normalized.setCode,
        name: normalized.setName,
      },
      set_name: normalized.setName,
    });
  }

  if (normalized.kind === "lorcana-set-reference") {
    return toJsonValue({
      ...normalized,
      set: {
        id: normalized.setId,
        code: normalized.setCode,
        name: normalized.setName,
        release_date: normalized.releaseDate,
      },
      set_name: normalized.setName,
    });
  }

  if (normalized.kind === "magic-card-print" || normalized.kind === "magic-sealed-product") {
    return toJsonValue({
      ...normalized,
      set: normalized.setCode,
      set_name: normalized.setName,
    });
  }

  if (normalized.kind === "lorcana-card-print") {
    return toJsonValue({
      ...normalized,
      set: {
        id: normalized.setId,
        code: normalized.setCode,
        name: normalized.setName,
        release_date: normalized.releaseDate,
      },
      set_name: normalized.setName,
    });
  }

  if (normalized.kind === "lorcana-sealed-product") {
    return toJsonValue({
      ...normalized,
      sealedProduct: {
        set: normalized.setName
          ? {
              id: normalized.setId,
              code: normalized.setCode,
              name: normalized.setName,
              release_date: normalized.releaseDate,
            }
          : null,
      },
      set_name: normalized.setName,
    });
  }

  if (normalized.kind === "one-piece-card-print") {
    return toJsonValue({
      ...normalized,
      card: {
        expansion: {
          id: normalized.setId,
          code: normalized.setCode,
          name: normalized.setName,
          release_date: normalized.releaseDate,
        },
      },
    });
  }

  if (normalized.kind === "one-piece-sealed-product") {
    return toJsonValue({
      ...normalized,
      sealedProduct: {
        expansion: normalized.setId
          ? {
              id: normalized.setId,
              code: normalized.setCode,
              name: normalized.setName,
              release_date: normalized.releaseDate,
            }
          : null,
      },
    });
  }

  return toJsonValue(normalized);
}

async function ensureReferenceType(
  input: {
    deps: CatalogRuntimeDeps;
    referenceData: ReferenceDataServices;
    context: EventStoreContext;
  },
  def: {
    referenceTypeId: ReferenceTypeId;
    key: string;
    name: string;
    description: string;
    attributeKeys: readonly string[];
  },
): Promise<void> {
  const existing = await input.deps.db.query(
    "SELECT reference_type_id FROM catalog_reference_types WHERE reference_type_id = $1",
    [def.referenceTypeId],
  );

  if (existing.rowCount && existing.rowCount > 0) {
    return;
  }

  const streamId = `catalog.reference-type-${def.referenceTypeId}`;
  try {
    await input.referenceData.referenceTypeCommandHandler({
      streamId,
      command: {
        type: "CreateReferenceType",
        referenceTypeId: def.referenceTypeId,
        key: def.key,
        name: localizedText(def.name),
        description: localizedText(def.description),
        attributeKeys: def.attributeKeys,
      },
      context: input.context,
    });
  } catch (error) {
    if (!isAlreadyCreatedReferenceError(error)) {
      throw error;
    }
  }
  await publishReferenceTypeIfDraft(input.referenceData, streamId, input.context);
}

async function ensureReferenceRecord(
  input: {
    deps: CatalogRuntimeDeps;
    referenceData: ReferenceDataServices;
    context: EventStoreContext;
  },
  def: {
    referenceRecordId: ReferenceRecordId;
    typeKey: string;
    key: string;
    name: string;
    description: string;
    attributes?: Readonly<Record<string, JsonValue>>;
    relationships?: readonly ReferenceRelationship[];
  },
): Promise<ReferenceRecordId> {
  const existing = await input.deps.db.query<{ reference_record_id: string }>(
    `SELECT reference_record_id
     FROM catalog_reference_records
     WHERE type_key = $1 AND key = $2
     LIMIT 1`,
    [def.typeKey, def.key],
  );

  if (existing.rows[0]?.reference_record_id) {
    return existing.rows[0].reference_record_id as ReferenceRecordId;
  }

  const existingByProviderAttribute = await findReferenceRecordByProviderAttribute(input.deps, def);
  if (existingByProviderAttribute) {
    return existingByProviderAttribute;
  }

  const streamId = `catalog.reference-record-${def.referenceRecordId}`;
  try {
    await input.referenceData.referenceRecordCommandHandler({
      streamId,
      command: {
        type: "CreateReferenceRecord",
        referenceRecordId: def.referenceRecordId,
        typeKey: def.typeKey,
        key: def.key,
        name: localizedText(def.name),
        description: localizedText(def.description),
        attributes: def.attributes ?? {},
        relationships: def.relationships ?? [],
      },
      context: input.context,
    });
  } catch (error) {
    if (!isAlreadyCreatedReferenceError(error)) {
      throw error;
    }
  }
  await publishReferenceRecordIfDraft(input.referenceData, streamId, input.context);

  return def.referenceRecordId;
}

async function publishReferenceTypeIfDraft(
  referenceData: ReferenceDataServices,
  streamId: string,
  context: EventStoreContext,
) {
  try {
    await referenceData.referenceTypeCommandHandler({
      streamId,
      command: { type: "PublishReferenceType" },
      context,
    });
  } catch (error) {
    if (!isAlreadyPublishedReferenceError(error)) {
      throw error;
    }
  }
}

async function publishReferenceRecordIfDraft(
  referenceData: ReferenceDataServices,
  streamId: string,
  context: EventStoreContext,
) {
  try {
    await referenceData.referenceRecordCommandHandler({
      streamId,
      command: { type: "PublishReferenceRecord" },
      context,
    });
  } catch (error) {
    if (!isAlreadyPublishedReferenceError(error)) {
      throw error;
    }
  }
}

function isAlreadyCreatedReferenceError(error: unknown): boolean {
  return isConcurrencyConflict(error) || (error instanceof Error && error.message.includes("has already been created"));
}

function isAlreadyPublishedReferenceError(error: unknown): boolean {
  return isConcurrencyConflict(error) || (error instanceof Error && error.message.includes("Only draft reference"));
}

function isConcurrencyConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "concurrency_conflict"
  );
}

async function findReferenceRecordByProviderAttribute(
  deps: CatalogRuntimeDeps,
  def: {
    typeKey: string;
    attributes?: Readonly<Record<string, JsonValue>>;
  },
): Promise<ReferenceRecordId | null> {
  const providerAttribute = Object.entries(def.attributes ?? {}).find(
    ([key, value]) => isProviderReferenceAttributeKey(key) && typeof value === "string" && value.trim().length > 0,
  );
  const providerAttributeKey = providerAttribute?.[0] ?? null;
  const providerAttributeValue = providerAttribute?.[1] ?? null;

  if (typeof providerAttributeValue !== "string" || providerAttributeValue.trim().length === 0) {
    return null;
  }

  const existing = await deps.db.query<{ reference_record_id: string }>(
    `SELECT reference_record_id
     FROM catalog_reference_records
     WHERE type_key = $1
       AND attributes ->> $2 = $3
     LIMIT 1`,
    [def.typeKey, providerAttributeKey, providerAttributeValue],
  );

  return (existing.rows[0]?.reference_record_id as ReferenceRecordId | undefined) ?? null;
}

function isProviderReferenceAttributeKey(key: string): boolean {
  return (
    key.startsWith("tcgdex-") ||
    key.startsWith("tcgplayer-") ||
    key.startsWith("scryfall-") ||
    key.startsWith("mtgjson-") ||
    key.startsWith("scrydex-one-piece-")
  );
}

function localizedText(value: string): LocalizedTextMap {
  return {
    defaultLocale: "en" as const,
    values: {
      en: value,
    },
  };
}
