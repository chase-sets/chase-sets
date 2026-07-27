import { createHash } from "node:crypto";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { type JsonValue } from "@chase-sets/primitives/json";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { CatalogItemId, BlueprintId, CategoryId, FieldId, ReferenceRecordId } from "../../../ids";
import type { ProductAssetSet } from "../../../support/runtime-support/product-assets";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { CatalogItemCommand } from "../../catalog-items/domain/domain";
import type { ProductContentServices } from "../../product-contents/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import {
  isLorcanaCatalogItemSourceObservationNormalized,
  isMagicCatalogItemSourceObservationNormalized,
  isOnePieceCatalogItemSourceObservationNormalized,
  isPokemonCatalogItemSourceObservationNormalized,
  isYugiohCatalogItemSourceObservationNormalized,
  type SourceObservationLorcanaSetReferenceNormalized,
  type SourceObservationMagicSetReferenceNormalized,
  type SourceObservationNormalized,
  type SourceObservationOnePieceSetReferenceNormalized,
  type SourceObservationPromotionProfileEvidence,
} from "../domain/domain";
import { normalizeTcgdexImageAsset } from "./tcgdex-client";
import {
  extractApprovedLorcanaImageEvidence,
  normalizeLorcanaImageAsset,
  normalizeProductAssetSet,
} from "./product-asset-normalization";
import { type PromotionAliasServices } from "./provider-promotion-alias-writer";
import { createPromotionAliasReader } from "./provider-promotion-alias-reader";
import {
  buildTcgplayerAutomationSourceObservationPayload,
  type TcgplayerAutomationProductDetail,
} from "./tcgplayer-automation-catalog-client";
import {
  type CatalogProviderIntegrationProfile,
  type CatalogProviderIntegrationProfileVersionRecord,
  type CatalogProviderProfileVersionSelector,
} from "./provider-integration-profiles";
import {
  catalogProviderSourceMappingFingerprint,
  type CatalogProviderSourceObservationMappingContract,
} from "./provider-source-observation-normalizer";
import {
  planCatalogProviderPromotionCommands,
  type CatalogProviderPromotionResolvedCatalogMapping,
  type CatalogProviderPromotionCommandPlanResult,
} from "./provider-promotion-command-planner";
import type {
  CatalogProviderIntegrationProfileVersionReader,
  SourceObservationAliasPromotion,
  RepresentativeCatalogProductAssetSource,
  SourceObservationReapplyProfileMode,
} from "./source-observation-runtime-contracts";
import { defaultSourceObservationImportProviderKeyFromVersions } from "./provider-option-queries";
import {
  isActiveSourceObservationImportProfileVersion,
  createCatalogIntegrationProfileVersionResolvers,
} from "./catalog-integration-control-plane-readiness";
import {
  resolvePromotionReferenceHierarchy,
  type CatalogItemPromotableSourceObservationNormalized,
} from "./source-observation-promotion-reference-hierarchy";

/**
 * Promotion evidence plus the resolved reference-record ids keyed by reference
 * type key, so promotion alias planning can resolve set/series-equivalent
 * Reference Record targets before writing alias facts.
 */
type CatalogItemPromotionResult = SourceObservationPromotionProfileEvidence &
  Readonly<{ referenceRecordIdsByTypeKey: Readonly<Record<string, string>> }>;

export async function createCatalogDraftFromObservation(input: {
  items: CatalogItemServices;
  referenceData: ReferenceDataServices;
  productContents: ProductContentServices | null;
  deps: CatalogRuntimeDeps;
  catalogItemId: CatalogItemId;
  normalized: CatalogItemPromotableSourceObservationNormalized;
  providerKey: string;
  externalKey: string;
  providerProfile: CatalogProviderIntegrationProfile;
  providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
  catalogMapping: CatalogProviderPromotionResolvedCatalogMapping;
  sourceUpdatedAt: string | null;
  observedAt: string;
  productAssetSource?: RepresentativeCatalogProductAssetSource | null;
  context: EventStoreContext;
  executeCommands?: boolean;
}): Promise<CatalogItemPromotionResult> {
  const streamId = `catalog.item-${input.catalogItemId}`;
  const { targetReferenceRecordId, referenceRecordIdsByTypeKey } = await resolvePromotionReferenceHierarchy({
    deps: input.deps,
    referenceData: input.referenceData,
    profile: input.providerProfile,
    normalized: input.normalized,
    context: input.context,
  });
  const metadata = await formatCatalogItemPromotionMetadata({
    deps: input.deps,
    normalized: input.normalized,
    targetReferenceRecordId,
  });
  const productAssetSet = await normalizePromotionProductAssetSet(input);
  const setReferenceId =
    input.normalized.kind === "magic-card-print" ||
    input.normalized.kind === "magic-sealed-product" ||
    input.normalized.kind === "lorcana-card-print" ||
    input.normalized.kind === "lorcana-sealed-product" ||
    input.normalized.kind === "one-piece-card-print" ||
    input.normalized.kind === "one-piece-sealed-product" ||
    input.normalized.kind === "yugioh-sealed-product"
      ? targetReferenceRecordId
      : undefined;
  const plan = planCatalogProviderPromotionCommands({
    profile: input.providerProfile,
    profileKey: input.providerProfileVersion.profileKey,
    profileVersion: input.providerProfileVersion.profileVersion,
    providerKey: input.providerKey,
    externalKey: input.externalKey,
    mode: "create",
    catalogItemId: input.catalogItemId,
    normalized: input.normalized,
    catalog: {
      blueprintId: input.catalogMapping.blueprintId,
      categoryId: input.catalogMapping.categoryId,
      fieldIds: input.catalogMapping.fieldIds,
    },
    expansionReferenceId:
      input.normalized.kind === "pokemon-card" || input.normalized.kind === "pokemon-sealed-product"
        ? targetReferenceRecordId
        : undefined,
    setReferenceId,
    metadata,
    productAssetSet,
    preflight: { status: "ready" },
  });

  if (input.executeCommands !== false) {
    await executeCatalogItemPromotionCommandPlan({
      items: input.items,
      productContents: input.productContents,
      streamId,
      plan,
      context: input.context,
    });
  }

  return { ...promotionEvidenceFromPlan(plan), referenceRecordIdsByTypeKey };
}

export async function refreshCatalogItemFromObservation(input: {
  items: CatalogItemServices;
  referenceData: ReferenceDataServices;
  productContents: ProductContentServices | null;
  deps: CatalogRuntimeDeps;
  catalogItemId: CatalogItemId;
  normalized: CatalogItemPromotableSourceObservationNormalized;
  providerKey: string;
  externalKey: string;
  providerProfile: CatalogProviderIntegrationProfile;
  providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
  catalogMapping: CatalogProviderPromotionResolvedCatalogMapping;
  sourceUpdatedAt: string | null;
  observedAt: string;
  productAssetSource?: RepresentativeCatalogProductAssetSource | null;
  context: EventStoreContext;
  executeCommands?: boolean;
}): Promise<CatalogItemPromotionResult> {
  const streamId = `catalog.item-${input.catalogItemId}`;
  const { targetReferenceRecordId, referenceRecordIdsByTypeKey } = await resolvePromotionReferenceHierarchy({
    deps: input.deps,
    referenceData: input.referenceData,
    profile: input.providerProfile,
    normalized: input.normalized,
    context: input.context,
  });
  const metadata = await formatCatalogItemPromotionMetadata({
    deps: input.deps,
    normalized: input.normalized,
    targetReferenceRecordId,
  });
  const productAssetSet = await normalizePromotionProductAssetSet(input);
  const setReferenceId =
    input.normalized.kind === "magic-card-print" ||
    input.normalized.kind === "magic-sealed-product" ||
    input.normalized.kind === "lorcana-card-print" ||
    input.normalized.kind === "lorcana-sealed-product" ||
    input.normalized.kind === "one-piece-card-print" ||
    input.normalized.kind === "one-piece-sealed-product" ||
    input.normalized.kind === "yugioh-sealed-product"
      ? targetReferenceRecordId
      : undefined;
  const plan = planCatalogProviderPromotionCommands({
    profile: input.providerProfile,
    profileKey: input.providerProfileVersion.profileKey,
    profileVersion: input.providerProfileVersion.profileVersion,
    providerKey: input.providerKey,
    externalKey: input.externalKey,
    mode: "refresh",
    catalogItemId: input.catalogItemId,
    normalized: input.normalized,
    catalog: {
      blueprintId: input.catalogMapping.blueprintId,
      categoryId: input.catalogMapping.categoryId,
      fieldIds: input.catalogMapping.fieldIds,
    },
    expansionReferenceId:
      input.normalized.kind === "pokemon-card" || input.normalized.kind === "pokemon-sealed-product"
        ? targetReferenceRecordId
        : undefined,
    setReferenceId,
    metadata,
    productAssetSet,
    preflight: { status: "ready" },
  });

  if (input.executeCommands !== false) {
    await executeCatalogItemPromotionCommandPlan({
      items: input.items,
      productContents: input.productContents,
      streamId,
      plan,
      context: input.context,
    });
  }

  return { ...promotionEvidenceFromPlan(plan), referenceRecordIdsByTypeKey };
}

/**
 * Build the full promotion alias services from whatever the composition root
 * injected. Only the alias command handler is required; the read side defaults
 * to the read-model over the shared `deps.db`. Returns null when alias
 * promotion was not wired so promotion writes no alias facts.
 */
export function resolveAliasPromotionServices(
  deps: CatalogRuntimeDeps,
  aliasPromotion: SourceObservationAliasPromotion | null,
): PromotionAliasServices | null {
  if (!aliasPromotion) {
    return null;
  }
  if (
    "listCandidatesForObservation" in aliasPromotion &&
    "listPublishedCatalogItemAliases" in aliasPromotion &&
    "listPublishedReferenceRecordAliases" in aliasPromotion
  ) {
    return aliasPromotion;
  }
  return {
    ...createPromotionAliasReader(deps.db),
    catalogAliasCommandHandler: aliasPromotion.catalogAliasCommandHandler,
  };
}

function promotionEvidenceFromPlan(
  plan: CatalogProviderPromotionCommandPlanResult,
): SourceObservationPromotionProfileEvidence {
  if (plan.status === "blocked") {
    throw new Error(plan.diagnostics.map((diagnostic) => diagnostic.diagnosticText).join(" "));
  }

  return {
    promotionProfileKey: plan.plan.profileKey,
    promotionProfileVersion: plan.plan.profileVersion,
    promotionPlanFingerprint: plan.plan.planFingerprint,
  };
}

export function referenceDataPromotionEvidence(input: {
  providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
  normalized:
    | SourceObservationMagicSetReferenceNormalized
    | SourceObservationLorcanaSetReferenceNormalized
    | SourceObservationOnePieceSetReferenceNormalized;
  referenceRecordId: ReferenceRecordId;
}): SourceObservationPromotionProfileEvidence {
  return {
    promotionProfileKey: input.providerProfileVersion.profileKey,
    promotionProfileVersion: input.providerProfileVersion.profileVersion,
    promotionPlanFingerprint: referenceDataPromotionPlanFingerprint(input),
  };
}

function referenceDataPromotionPlanFingerprint(input: {
  providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
  normalized:
    | SourceObservationMagicSetReferenceNormalized
    | SourceObservationLorcanaSetReferenceNormalized
    | SourceObservationOnePieceSetReferenceNormalized;
  referenceRecordId: ReferenceRecordId;
}): string {
  const payload = {
    providerKey: input.providerProfileVersion.providerKey,
    profileKey: input.providerProfileVersion.profileKey,
    profileVersion: input.providerProfileVersion.profileVersion,
    normalizedKind: input.normalized.kind,
    referenceRecordId: input.referenceRecordId,
    setCode: input.normalized.setCode,
    setName: input.normalized.setName,
    releaseDate: input.normalized.releaseDate,
    cardCount: input.normalized.cardCount,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

async function executeCatalogItemPromotionCommandPlan(input: {
  items: CatalogItemServices;
  productContents: ProductContentServices | null;
  streamId: string;
  plan: CatalogProviderPromotionCommandPlanResult;
  context: EventStoreContext;
}) {
  if (input.plan.status === "blocked") {
    throw new Error(input.plan.diagnostics.map((diagnostic) => diagnostic.diagnosticText).join(" "));
  }

  for (const command of input.plan.plan.commands) {
    await executeCatalogItemPromotionCommand({
      items: input.items,
      streamId: input.streamId,
      command,
      context: input.context,
    });
  }

  if (input.plan.plan.productContents) {
    if (!input.productContents) {
      throw new Error("Product Contents services are required to promote reviewed Product Contents evidence.");
    }
    await input.productContents.replaceProductContents(input.plan.plan.productContents.replacement, input.context);
  }
}

async function executeCatalogItemPromotionCommand(input: {
  items: CatalogItemServices;
  streamId: string;
  command: CatalogItemCommand;
  context: EventStoreContext;
}) {
  await input.items.commandHandler({
    streamId: input.streamId,
    command: input.command,
    context: input.context,
  });
}

async function formatCatalogItemPromotionMetadata(input: {
  deps: CatalogRuntimeDeps;
  normalized: CatalogItemPromotableSourceObservationNormalized;
  targetReferenceRecordId: ReferenceRecordId;
}): Promise<{ title: string; subtitle: string }> {
  void input.deps;
  void input.targetReferenceRecordId;
  return {
    title: input.normalized.name,
    subtitle: "",
  };
}

export function isPromotableObservationStatus(status: string): boolean {
  return status === "observed" || status === "changed" || status === "promoted";
}

export function isReviewableObservationStatus(status: string): boolean {
  return status === "observed" || status === "changed";
}

export function requirePromotionAssetPorts(input: {
  deps: CatalogRuntimeDeps;
  normalized: CatalogItemPromotableSourceObservationNormalized;
  productAssetSource?: RepresentativeCatalogProductAssetSource | null;
}) {
  if (input.productAssetSource || (input.normalized.kind === "pokemon-card" && input.normalized.imageBaseUrl)) {
    requireCatalogAssetStorage(input.deps.assetStorage);
  }
}

async function normalizePromotionProductAssetSet(input: {
  deps: CatalogRuntimeDeps;
  catalogItemId: CatalogItemId;
  normalized: CatalogItemPromotableSourceObservationNormalized;
  providerKey: string;
  providerProfile: CatalogProviderIntegrationProfile;
  sourceUpdatedAt: string | null;
  observedAt: string;
  productAssetSource?: RepresentativeCatalogProductAssetSource | null;
}): Promise<ProductAssetSet | null> {
  if (input.productAssetSource) {
    const existing = await findStoredProductAssetSetBySourceHash(
      input.deps.db,
      input.catalogItemId,
      input.productAssetSource.sourceHash,
    );
    if (existing) {
      return existing;
    }

    return normalizeProductAssetSet({
      sourceBody: input.productAssetSource.body,
      sourceContentType: input.productAssetSource.contentType,
      sourceProviderKey: input.providerKey,
      sourceUrl: input.productAssetSource.sourceUrl,
      storageBaseKey: catalogItemAssetObjectBaseKey(input.catalogItemId),
      generatedAt: input.observedAt,
      assetStorage: requireCatalogAssetStorage(input.deps.assetStorage),
    });
  }

  if (input.normalized.kind === "pokemon-card" && input.normalized.imageBaseUrl) {
    return normalizeTcgdexImageAsset({
      profile: input.providerProfile,
      imageBaseUrl: input.normalized.imageBaseUrl,
      storageBaseKey: catalogItemAssetObjectBaseKey(input.catalogItemId),
      observedAt: input.observedAt,
      fetcher: globalThis.fetch,
      assetStorage: requireCatalogAssetStorage(input.deps.assetStorage),
    });
  }

  if (input.normalized.kind === "lorcana-card-print" || input.normalized.kind === "lorcana-sealed-product") {
    const evidence = extractApprovedLorcanaImageEvidence({
      providerKey: input.providerKey,
      imageUrls: input.normalized.imageUrls,
      sourceUpdatedAt: input.sourceUpdatedAt,
      observedAt: input.observedAt,
    });
    if (evidence.status !== "current") {
      return null;
    }

    return normalizeLorcanaImageAsset({
      providerKey: input.providerKey,
      imageUrls: evidence.imageUrls,
      sourceUpdatedAt: input.sourceUpdatedAt,
      observedAt: input.observedAt,
      storageBaseKey: catalogItemAssetObjectBaseKey(input.catalogItemId),
      fetcher: globalThis.fetch,
      assetStorage: requireCatalogAssetStorage(input.deps.assetStorage),
    });
  }

  return null;
}

async function findStoredProductAssetSetBySourceHash(
  db: PgQueryable,
  catalogItemId: CatalogItemId,
  sourceHash: string,
): Promise<ProductAssetSet | null> {
  const result = await db.query<Readonly<{ product_asset_sets: unknown }>>(
    "SELECT product_asset_sets FROM catalog_items WHERE catalog_item_id = $1",
    [catalogItemId],
  );
  const productAssetSets = result.rows[0]?.product_asset_sets;
  if (!Array.isArray(productAssetSets)) {
    return null;
  }

  const normalizedSourceHash = sourceHash.replace(/^sha256:/, "");
  return (
    productAssetSets.find(
      (candidate): candidate is ProductAssetSet =>
        isJsonRecord(candidate) && candidate.kind === "product-image" && candidate.sourceHash === normalizedSourceHash,
    ) ?? null
  );
}

export function requireCatalogItemPromotionObservation(
  normalized: SourceObservationNormalized,
  providerKey: string,
): CatalogItemPromotableSourceObservationNormalized {
  if (
    !isPokemonCatalogItemSourceObservationNormalized(normalized) &&
    !isMagicCatalogItemSourceObservationNormalized(normalized) &&
    !isLorcanaCatalogItemSourceObservationNormalized(normalized) &&
    !isOnePieceCatalogItemSourceObservationNormalized(normalized) &&
    !isYugiohCatalogItemSourceObservationNormalized(normalized)
  ) {
    throw new Error(
      `Catalog promotion for provider '${providerKey}' requires a Catalog Item source observation. Normalized kind '${normalized.kind}' is not promotable.`,
    );
  }

  return normalized;
}

export function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function requireCatalogAssetStorage(assetStorage: CatalogRuntimeDeps["assetStorage"]) {
  if (!assetStorage) {
    throw new Error("Catalog asset storage is required to promote source observation image assets.");
  }

  return assetStorage;
}

function catalogItemAssetObjectBaseKey(catalogItemId: CatalogItemId): string {
  return `catalog/items/${catalogItemId}/product-image`;
}

export async function loadCatalogItemPromotionProfile(
  deps: CatalogRuntimeDeps,
  profile: CatalogProviderIntegrationProfile,
): Promise<CatalogProviderPromotionResolvedCatalogMapping> {
  const mapping = profile.catalogFieldMapping;
  const [blueprintId, categoryId, cardNumber, cardName, expansion, rarity, cardVariant, cardIllustrator, releaseYear] =
    await Promise.all([
      requireCatalogIdByKey<BlueprintId>(deps, profile, "catalog_blueprints", "blueprint_id", mapping.blueprintKey),
      requireCatalogIdByKey<CategoryId>(deps, profile, "catalog_categories", "category_id", mapping.categoryKey),
      requireCatalogIdByKey<FieldId>(deps, profile, "catalog_fields", "field_id", mapping.fieldKeys.cardNumber),
      requireCatalogIdByKey<FieldId>(deps, profile, "catalog_fields", "field_id", mapping.fieldKeys.cardName),
      requireCatalogIdByKey<FieldId>(deps, profile, "catalog_fields", "field_id", mapping.fieldKeys.expansion),
      requireCatalogIdByKey<FieldId>(deps, profile, "catalog_fields", "field_id", mapping.fieldKeys.rarity),
      requireCatalogIdByKey<FieldId>(deps, profile, "catalog_fields", "field_id", mapping.fieldKeys.cardVariant),
      requireCatalogIdByKey<FieldId>(deps, profile, "catalog_fields", "field_id", mapping.fieldKeys.cardIllustrator),
      requireCatalogIdByKey<FieldId>(deps, profile, "catalog_fields", "field_id", mapping.fieldKeys.releaseYear),
    ]);

  return {
    blueprintId,
    categoryId,
    fieldIds: {
      cardNumber,
      cardName,
      expansion,
      rarity,
      cardVariant,
      cardIllustrator,
      releaseYear,
      ...(mapping.fieldKeys.set
        ? {
            set: await requireCatalogIdByKey<FieldId>(
              deps,
              profile,
              "catalog_fields",
              "field_id",
              mapping.fieldKeys.set,
            ),
          }
        : {}),
      ...(mapping.fieldKeys.packCount
        ? {
            packCount: await requireCatalogIdByKey<FieldId>(
              deps,
              profile,
              "catalog_fields",
              "field_id",
              mapping.fieldKeys.packCount,
            ),
          }
        : {}),
    },
  };
}

async function requireCatalogIdByKey<TId extends string>(
  deps: CatalogRuntimeDeps,
  profile: CatalogProviderIntegrationProfile,
  tableName: "catalog_blueprints" | "catalog_categories" | "catalog_fields",
  idColumnName: "blueprint_id" | "category_id" | "field_id",
  key: string,
): Promise<TId> {
  const existing = await deps.db.query<Record<string, string>>(
    `SELECT ${idColumnName} AS id FROM ${tableName} WHERE key = $1 AND status = 'active' LIMIT 1`,
    [key],
  );
  const id = existing.rows[0]?.id;
  if (!id) {
    throw new Error(
      `${profile.displayName} promotion requires active Catalog ${tableName} key '${key}'. Run the Catalog integration bootstrap first.`,
    );
  }

  return id as TId;
}

export async function requireCatalogPromotionProfileVersion(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
  providerKey: string,
  normalized: SourceObservationNormalized,
  selector?: CatalogProviderProfileVersionSelector | null,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const profile = selector
    ? await profileVersions.getActiveProfileVersion(providerKey, selector)
    : selectPromotionProfileVersionForNormalizedKind(await profileVersions.listProfileVersions(providerKey), {
        providerKey,
        normalizedKind: normalized.kind,
      });
  if (
    profile &&
    isActivePromotionProfileVersion(profile) &&
    profile.profile.normalizedObservationMapping.kind === normalized.kind
  ) {
    return profile;
  }

  if (profile && profile.profile.normalizedObservationMapping.kind !== normalized.kind) {
    throw new Error(
      `Provider '${providerKey}' promotion mapping '${profile.profile.normalizedObservationMapping.kind}' is not compatible with '${normalized.kind}' observations.`,
    );
  }

  throw new Error(`Provider '${providerKey}' does not support Catalog Item promotion.`);
}

export async function requireReferenceDataPromotionProfileVersion(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
  providerKey: string,
  normalized:
    | SourceObservationMagicSetReferenceNormalized
    | SourceObservationLorcanaSetReferenceNormalized
    | SourceObservationOnePieceSetReferenceNormalized,
  selector?: CatalogProviderProfileVersionSelector | null,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const profile = selector
    ? await profileVersions.getActiveProfileVersion(providerKey, selector)
    : selectReferenceDataPromotionProfileVersionForNormalizedKind(
        await profileVersions.listProfileVersions(providerKey),
        {
          providerKey,
          normalizedKind: normalized.kind,
        },
      );
  if (
    profile &&
    isActiveReferenceDataPromotionProfileVersion(profile) &&
    profile.profile.normalizedObservationMapping.kind === normalized.kind
  ) {
    return profile;
  }

  if (profile && profile.profile.normalizedObservationMapping.kind !== normalized.kind) {
    throw new Error(
      `Provider '${providerKey}' reference promotion mapping '${profile.profile.normalizedObservationMapping.kind}' is not compatible with '${normalized.kind}' observations.`,
    );
  }

  throw new Error(`Provider '${providerKey}' does not support Reference Data promotion.`);
}

function selectPromotionProfileVersionForNormalizedKind(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
  input: Readonly<{ providerKey: string; normalizedKind: SourceObservationNormalized["kind"] }>,
): CatalogProviderIntegrationProfileVersionRecord | null {
  const matching = versions.filter(
    (version) =>
      version.providerKey.trim().toLowerCase() === input.providerKey.trim().toLowerCase() &&
      isActivePromotionProfileVersion(version) &&
      version.profile.normalizedObservationMapping.kind === input.normalizedKind,
  );
  if (matching.length === 0) {
    return null;
  }
  if (matching.length === 1) {
    return matching[0] ?? null;
  }

  throw new Error(
    `Catalog provider '${input.providerKey}' has multiple active promotion profile units for '${input.normalizedKind}' observations. Select a profileKey or ingestionUnitKey.`,
  );
}

function selectReferenceDataPromotionProfileVersionForNormalizedKind(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
  input: Readonly<{ providerKey: string; normalizedKind: SourceObservationNormalized["kind"] }>,
): CatalogProviderIntegrationProfileVersionRecord | null {
  const matching = versions.filter(
    (version) =>
      version.providerKey.trim().toLowerCase() === input.providerKey.trim().toLowerCase() &&
      isActiveReferenceDataPromotionProfileVersion(version) &&
      version.profile.normalizedObservationMapping.kind === input.normalizedKind,
  );
  if (matching.length === 0) {
    return null;
  }
  if (matching.length === 1) {
    return matching[0] ?? null;
  }

  throw new Error(
    `Catalog provider '${input.providerKey}' has multiple active reference promotion profile units for '${input.normalizedKind}' observations. Select a profileKey or ingestionUnitKey.`,
  );
}

function requireOriginalSourceProfileMarker(
  value: string | null | undefined,
  label: string,
  observationId: string,
): string {
  const marker = value?.trim();
  if (!marker || marker.toLowerCase() === "legacy") {
    throw new Error(
      `Source Observation ${observationId} is missing original ${label} and cannot be reapplied with original-source-profile mode.`,
    );
  }
  return marker;
}

export function requireIntegrationJobReapplyProfileMode(
  mode: SourceObservationReapplyProfileMode | null | undefined,
  jobId: string,
): SourceObservationReapplyProfileMode {
  if (mode === "current-active-profile" || mode === "original-source-profile") {
    return mode;
  }
  throw new Error(`Source Observation reapply job ${jobId} is missing reapply profile mode.`);
}

export function requireBulkJobReapplyProfileMode(
  mode: SourceObservationReapplyProfileMode | null | undefined,
  jobId: string,
): SourceObservationReapplyProfileMode {
  if (mode === "current-active-profile" || mode === "original-source-profile") {
    return mode;
  }
  throw new Error(`Source Observation bulk reapply job ${jobId} is missing reapply profile mode.`);
}

function isActivePromotionProfileVersion(version: CatalogProviderIntegrationProfileVersionRecord): boolean {
  return (
    version.active &&
    version.lifecycle === "active" &&
    version.profile.status === "active" &&
    version.profile.capabilities.includes("catalog-item-promotion")
  );
}

function isActiveReferenceDataPromotionProfileVersion(
  version: CatalogProviderIntegrationProfileVersionRecord,
): boolean {
  return (
    version.active &&
    version.lifecycle === "active" &&
    version.profile.status === "active" &&
    version.profile.capabilities.includes("reference-data-promotion")
  );
}

export function requireSourceObservationMappingContract(
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogProviderSourceObservationMappingContract {
  const contract = version.executableMappingContract;
  if (!contract?.sourceObservation) {
    throw new Error(
      `Catalog provider '${version.providerKey}' profile version '${version.profileVersion}' does not have a Source Observation mapping contract.`,
    );
  }

  return contract as CatalogProviderSourceObservationMappingContract;
}

export function prepareProviderAdapterSourceObservationPayload(input: {
  payload: JsonValue;
  providerProfile: CatalogProviderIntegrationProfile;
}): Readonly<{ kind: "payload"; payload: JsonValue }> | Readonly<{ kind: "failure"; reason: string }> {
  if (input.providerProfile.connector.kind === "tcgdex-json") {
    return {
      kind: "payload",
      payload:
        isJsonRecord(input.payload) && isJsonRecord(input.payload.payload) ? input.payload.payload : input.payload,
    };
  }

  if (input.providerProfile.connector.kind !== "tcgplayer-automation-client") {
    return { kind: "payload", payload: input.payload };
  }

  if (!isJsonRecord(input.payload)) {
    return { kind: "failure", reason: "TCGplayer adapter returned an invalid product detail payload." };
  }

  if (input.payload.kind === "product-detail-failure") {
    return {
      kind: "failure",
      reason: typeof input.payload.reason === "string" ? input.payload.reason : "TCGplayer product detail failed.",
    };
  }

  if (input.payload.kind !== "product-detail" || !isJsonRecord(input.payload.detail)) {
    return { kind: "failure", reason: "TCGplayer adapter returned an unsupported product payload." };
  }

  const selectedOptionMapping = input.providerProfile.selectedOptionMapping;
  if (!selectedOptionMapping) {
    return { kind: "failure", reason: "TCGplayer import profile must define selected option mapping." };
  }

  return {
    kind: "payload",
    payload: buildTcgplayerAutomationSourceObservationPayload({
      detail: input.payload.detail as TcgplayerAutomationProductDetail,
      selectedOptionMapping,
      externalReferenceRules: input.providerProfile.externalReferenceExtractionRules.rules,
    }),
  };
}

export async function defaultSourceObservationImportProviderKey(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
): Promise<string> {
  const activeImportProfiles = (await profileVersions.listProfileVersions()).filter(
    isActiveSourceObservationImportProfileVersion,
  );
  if (activeImportProfiles.length === 0) {
    throw new Error("No active Catalog source observation import provider is configured.");
  }

  return defaultSourceObservationImportProviderKeyFromVersions(activeImportProfiles);
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Profile-version resolvers shared by every Source Observation sub-runtime.
 * Bound here because each one closes over the promotion-profile selection and
 * mapping-contract helpers declared above.
 */
export const {
  requireCatalogImportProfileVersion,
  requireCatalogImportProfileVersionForJob,
  requireCatalogReapplyActiveProfileVersion,
  requireCatalogPromotionProfileVersionForReapply,
  requireReferenceDataPromotionProfileVersionForReapply,
  snapshotCatalogProfileVersion,
  snapshotCatalogReapplyProfileVersion,
  integrationProfileSnapshotKey,
  commonProfileSnapshot,
} = createCatalogIntegrationProfileVersionResolvers({
  defaultSourceObservationImportProviderKey,
  isActivePromotionProfileVersion,
  requireCatalogPromotionProfileVersion,
  requireReferenceDataPromotionProfileVersion,
  requireOriginalSourceProfileMarker,
  sourceMappingFingerprintForProfileVersion: (version) =>
    catalogProviderSourceMappingFingerprint(requireSourceObservationMappingContract(version)),
});
