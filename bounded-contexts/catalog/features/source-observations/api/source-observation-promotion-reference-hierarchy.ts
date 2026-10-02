import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { toJsonValue, type JsonValue } from "@chase-sets/primitives/json";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { ReferenceRecordId, ReferenceTypeId } from "../../../ids";
import type { LocalizedTextMap } from "../../../support/runtime-support/common";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import {
  evolveReferenceRecord,
  evolveReferenceType,
  initialReferenceRecordState,
  initialReferenceTypeState,
  isLegalReferenceRecordTransition,
  isLegalReferenceTypeTransition,
  type ReferenceRecordEvent,
  type ReferenceRecordState,
  type ReferenceTypeEvent,
  type ReferenceRelationship,
} from "../../reference-data/domain/domain";
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
import { provisionCatalogProviderReferenceHierarchy } from "./promotion/provider-reference-hierarchy-provisioner";

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

/**
 * READ-ONLY reference hierarchy resolution for promotion preview. Resolves the
 * same deterministic target/type-key ids the executing path would provision,
 * but never creates or publishes a Reference Type or Reference Record. A record
 * the executing path would create is reported by its deterministic id; the
 * display identity resolver then sees it as absent, which is the truthful
 * preview of the current Catalog data. A reuse candidate the executing path
 * would refuse is refused here by the same authoritative-history proof.
 */
export async function resolvePromotionReferenceHierarchyReadOnly(input: {
  deps: CatalogRuntimeDeps;
  profile: CatalogProviderIntegrationProfile;
  normalized: ReferenceHierarchySourceObservationNormalized;
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
      ensureReferenceType: async () => undefined,
      ensureReferenceRecord: async (def) =>
        (await readProvisionableReferenceRecord(input.deps, def, await findExistingReferenceRecord(input.deps, def)))
          .referenceRecordId,
    },
  });

  const referenceRecordIdsByTypeKey: Record<string, string> = {};
  for (const recordRule of input.profile.referenceHierarchyMapping.referenceRecords) {
    const referenceRecordId = result.referenceRecordIdsByRuleKey.get(recordRule.ruleKey);
    if (referenceRecordId) {
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
  const streamId = `catalog.reference-type-${def.referenceTypeId}`;
  const history = await readCompleteStream(input.deps.eventStore, { streamId });
  const codec = createPassthroughDomainEventCodec<ReferenceTypeEvent>();
  let state = initialReferenceTypeState;
  for (const stored of history) {
    const event = codec.decode(stored);
    if (!isLegalReferenceTypeTransition(state, event, def.referenceTypeId)) {
      throw new Error(`promotion-reference-history-invalid:${streamId}`);
    }
    state = evolveReferenceType(state, event);
  }
  if (history.length > 0 && (state.key !== def.key || !isProvisionableStatus(state.status))) {
    throw new Error(`promotion-reference-history-invalid:${streamId}`);
  }
  if (state.status === "active") return;
  // Every write is fenced to the history this validation saw. A revision that
  // lands between the read and the publish refuses with the event store's
  // concurrency conflict instead of publishing a type that was never validated.
  let expectedVersion = history[history.length - 1]?.streamVersion ?? 0;
  if (history.length === 0) {
    const created = await input.referenceData.referenceTypeCommandHandler({
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
      expectedVersion,
    });
    expectedVersion = created.version;
  }
  await input.referenceData.referenceTypeCommandHandler({
    streamId,
    command: { type: "PublishReferenceType" },
    context: input.context,
    expectedVersion,
  });
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
  const { referenceRecordId, streamId, state, version } = await readProvisionableReferenceRecord(
    input.deps,
    def,
    await findExistingReferenceRecord(input.deps, def),
  );
  if (state.status === "active") return referenceRecordId;
  // Every write is fenced to the history this validation saw. A revision that
  // lands between the read and the publish refuses with the event store's
  // concurrency conflict instead of publishing a record that was never validated.
  let expectedVersion = version;
  if (version === 0) {
    const created = await input.referenceData.referenceRecordCommandHandler({
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
      expectedVersion,
    });
    expectedVersion = created.version;
  }
  await input.referenceData.referenceRecordCommandHandler({
    streamId,
    command: { type: "PublishReferenceRecord" },
    context: input.context,
    expectedVersion,
  });
  return referenceRecordId;
}

/**
 * A reuse candidate discovered through the projected read model, together with
 * the selector that discovered it. The projection only discovers; the selector
 * is re-proven against the candidate's complete authoritative history before
 * provisioning accepts the candidate.
 */
type ReferenceRecordReuseCandidate = Readonly<{
  referenceRecordId: ReferenceRecordId;
  selector:
    | Readonly<{ kind: "type-key" }>
    | Readonly<{ kind: "provider-attribute"; attributeKey: string; attributeValue: string }>;
}>;

/**
 * Fold the complete authoritative history of the record provisioning would
 * reuse or create, validating every transition, and prove the folded record is
 * the one the rule asked for: the requested type, a draft or active lifecycle,
 * and the selector that discovered it (requested key, or the exact requested
 * provider attribute) still holding. A lagging projection can therefore never
 * redirect provisioning to a record that was renamed or re-keyed away, and a
 * stream the evolver would fold but the decider could never have produced is
 * refused instead of folded. The returned version is the fence for any write.
 */
async function readProvisionableReferenceRecord(
  deps: CatalogRuntimeDeps,
  def: {
    referenceRecordId: ReferenceRecordId;
    typeKey: string;
    key: string;
  },
  candidate: ReferenceRecordReuseCandidate | null,
): Promise<{
  referenceRecordId: ReferenceRecordId;
  streamId: string;
  state: ReferenceRecordState;
  version: number;
}> {
  const referenceRecordId = candidate?.referenceRecordId ?? def.referenceRecordId;
  const streamId = `catalog.reference-record-${referenceRecordId}`;
  const history = await readCompleteStream(deps.eventStore, { streamId });
  const codec = createPassthroughDomainEventCodec<ReferenceRecordEvent>();
  let state = initialReferenceRecordState;
  for (const stored of history) {
    const event = codec.decode(stored);
    if (!isLegalReferenceRecordTransition(state, event, referenceRecordId)) {
      throw new Error(`promotion-reference-history-invalid:${streamId}`);
    }
    state = evolveReferenceRecord(state, event);
  }
  const selector = candidate?.selector ?? { kind: "type-key" };
  const represented =
    history.length > 0 &&
    state.typeKey === def.typeKey &&
    isProvisionableStatus(state.status) &&
    (referenceRecordId !== def.referenceRecordId || state.key === def.key) &&
    (selector.kind === "type-key"
      ? state.key === def.key
      : state.attributes[selector.attributeKey] === selector.attributeValue);
  if (history.length > 0 ? !represented : candidate !== null) {
    throw new Error(`promotion-reference-history-invalid:${streamId}`);
  }
  return { referenceRecordId, streamId, state, version: history[history.length - 1]?.streamVersion ?? 0 };
}

function isProvisionableStatus(status: ReferenceRecordState["status"]): boolean {
  return status === "draft" || status === "active";
}

async function findExistingReferenceRecord(
  deps: CatalogRuntimeDeps,
  def: {
    typeKey: string;
    key: string;
    attributes?: Readonly<Record<string, JsonValue>>;
  },
): Promise<ReferenceRecordReuseCandidate | null> {
  const existing = await deps.db.query<{ reference_record_id: string }>(
    `SELECT reference_record_id
     FROM catalog_reference_records
     WHERE type_key = $1 AND key = $2
     LIMIT 1`,
    [def.typeKey, def.key],
  );

  const referenceRecordId = existing.rows[0]?.reference_record_id;
  if (referenceRecordId) {
    return { referenceRecordId: referenceRecordId as ReferenceRecordId, selector: { kind: "type-key" } };
  }

  return findReferenceRecordByProviderAttribute(deps, def);
}

async function findReferenceRecordByProviderAttribute(
  deps: CatalogRuntimeDeps,
  def: {
    typeKey: string;
    attributes?: Readonly<Record<string, JsonValue>>;
  },
): Promise<ReferenceRecordReuseCandidate | null> {
  const providerAttribute = Object.entries(def.attributes ?? {}).find(
    ([key, value]) => isProviderReferenceAttributeKey(key) && typeof value === "string" && value.trim().length > 0,
  );
  if (!providerAttribute) {
    return null;
  }
  const [attributeKey, attributeValue] = providerAttribute;
  if (typeof attributeValue !== "string" || attributeValue.trim().length === 0) {
    return null;
  }

  const existing = await deps.db.query<{ reference_record_id: string }>(
    `SELECT reference_record_id
     FROM catalog_reference_records
     WHERE type_key = $1
       AND attributes ->> $2 = $3
     LIMIT 1`,
    [def.typeKey, attributeKey, attributeValue],
  );

  const referenceRecordId = existing.rows[0]?.reference_record_id;
  return referenceRecordId
    ? {
        referenceRecordId: referenceRecordId as ReferenceRecordId,
        selector: { kind: "provider-attribute", attributeKey, attributeValue },
      }
    : null;
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
