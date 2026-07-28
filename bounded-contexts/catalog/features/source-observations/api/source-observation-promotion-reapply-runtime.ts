import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { isDurableJobHandoffError } from "@chase-sets/platform-runtime/durable-job-store";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { CatalogItemId, ReferenceRecordId } from "../../../ids";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ProductContentServices } from "../../product-contents/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import {
  isLorcanaSetReferenceSourceObservationNormalized,
  isMagicSetReferenceSourceObservationNormalized,
  isOnePieceSetReferenceSourceObservationNormalized,
  type SourceObservationLorcanaSetReferenceNormalized,
  type SourceObservationMagicSetReferenceNormalized,
  type SourceObservationOnePieceSetReferenceNormalized,
  type SourceObservationPromotionProfileEvidence,
} from "../domain/domain";
import {
  getSourceObservationDetail,
  listSourceObservationIdsForReapply,
  listSourceObservationIdsForPromotion,
  previewSourceObservationPromotionIds,
  previewSourceObservationReapplyScope,
  previewSourceObservationPromotionScope,
  type SourceObservationDetailRow,
} from "../read-model/queries";
import { writePromotionAliases } from "./promotion/provider-promotion-alias-writer";
import type { PromotionAliasTargetResolution } from "./promotion/provider-promotion-alias-planner";
import { type CatalogIntegrationRolloutControlPolicy } from "./governance/catalog-integration-rollout-controls";
import { resolveCatalogProviderDuplicatePrevention } from "./promotion/provider-duplicate-prevention-resolver";
import type {
  CatalogProviderIntegrationProfileVersionReader,
  SourceObservationAliasPromotion,
  RepresentativeCatalogProductAssetSource,
  SourceObservationPromotionTargetResult,
  SourceObservationProgressHandler,
  DurableSideEffectRunner,
  BulkSourceObservationPromotionResult,
  BulkSourceObservationPromotionOutcome,
  SourceObservationReapplyProfileMode,
  SourceObservationIntegrationProfileSnapshot,
  BulkSourceObservationReapplyResult,
  BulkSourceObservationReapplyOutcome,
  SourceObservationCommandServices,
  SourceObservationReviewServices,
  PromotionReapplyServices,
} from "./source-observation-runtime-contracts";
import {
  uniqueObservationIds,
  bulkProgress,
  runSourceObservationSideEffectImmediately,
  summarizePromotionOutcomes,
  summarizeReapplyOutcomes,
} from "./source-observation-job-serialization";
import {
  capitalize,
  createCatalogDraftFromObservation,
  isPromotableObservationStatus,
  isReviewableObservationStatus,
  loadCatalogItemPromotionProfile,
  referenceDataPromotionEvidence,
  refreshCatalogItemFromObservation,
  requireCatalogItemPromotionObservation,
  requireCatalogPromotionProfileVersion,
  requireCatalogPromotionProfileVersionForReapply,
  requireReferenceDataPromotionProfileVersion,
  requireReferenceDataPromotionProfileVersionForReapply,
  requirePromotionAssetPorts,
  resolveAliasPromotionServices,
} from "./source-observation-promotion-execution";
import { resolveReferenceDataPromotionHierarchy } from "./source-observation-promotion-reference-hierarchy";
import { sourceObservationStreamId } from "./source-observation-stream-identity";

export type SourceObservationPromotionReapplyRuntimeDeps = Readonly<{
  deps: CatalogRuntimeDeps;
  items: CatalogItemServices;
  referenceData: ReferenceDataServices;
  productContents: ProductContentServices | null;
  profileVersions: CatalogProviderIntegrationProfileVersionReader;
  rolloutControlPolicy: CatalogIntegrationRolloutControlPolicy;
  aliasPromotion: SourceObservationAliasPromotion | null;
  commandHandler: SourceObservationCommandServices["commandHandler"];
}>;

/**
 * Single-observation review and bulk promote/reapply/reject/defer facets. The
 * bulk id-list entry points are also the work bodies the bulk-review and
 * integration job runtimes drive, so they are returned alongside the services.
 */
export function createSourceObservationPromotionReapplyRuntime({
  deps,
  items,
  referenceData,
  productContents,
  profileVersions,
  rolloutControlPolicy,
  aliasPromotion,
  commandHandler,
}: SourceObservationPromotionReapplyRuntimeDeps) {
  const aliasPromotionServices = resolveAliasPromotionServices(deps, aliasPromotion);

  /**
   * Write the accepted-alias facts and retractions for a promoted/reapplied
   * observation. The Catalog Item id and Reference Record ids are
   * already resolved here, satisfying the rule that an item-level alias
   * resolves its `catalog_item_id` before a row is written. No-op when alias
   * promotion was not wired (minimal/legacy callers).
   */
  async function promoteAliasesForObservation(input: {
    observationId: string;
    catalogItemId: CatalogItemId;
    referenceRecordIdsByTypeKey: Readonly<Record<string, string>>;
    context: EventStoreContext;
  }): Promise<void> {
    if (!aliasPromotionServices) {
      return;
    }
    const resolution: PromotionAliasTargetResolution = {
      catalogItemId: input.catalogItemId,
      referenceRecordIdsByTypeKey: input.referenceRecordIdsByTypeKey,
    };
    await writePromotionAliases({
      services: aliasPromotionServices,
      observationId: input.observationId,
      resolution,
      context: input.context,
    });
  }

  async function promoteObservationFromRow(input: {
    observation: SourceObservationDetailRow;
    context: EventStoreContext;
    productAssetSource?: RepresentativeCatalogProductAssetSource | null;
  }): Promise<SourceObservationPromotionTargetResult> {
    if (
      isMagicSetReferenceSourceObservationNormalized(input.observation.normalized) ||
      isLorcanaSetReferenceSourceObservationNormalized(input.observation.normalized) ||
      isOnePieceSetReferenceSourceObservationNormalized(input.observation.normalized)
    ) {
      return promoteReferenceObservationFromRow({
        ...input,
        normalized: input.observation.normalized,
      });
    }

    return promoteCatalogItemObservationFromRow(input);
  }

  async function promoteCatalogItemObservationFromRow(input: {
    observation: SourceObservationDetailRow;
    context: EventStoreContext;
    productAssetSource?: RepresentativeCatalogProductAssetSource | null;
  }): Promise<SourceObservationPromotionTargetResult & SourceObservationPromotionProfileEvidence> {
    const normalized = requireCatalogItemPromotionObservation(
      input.observation.normalized,
      input.observation.provider_key,
    );
    const providerProfileVersion = await requireCatalogPromotionProfileVersion(
      profileVersions,
      input.observation.provider_key,
      normalized,
    );
    const providerProfile = providerProfileVersion.profile;
    requirePromotionAssetPorts({ deps, normalized, productAssetSource: input.productAssetSource });

    const existingCatalogItemId =
      input.observation.status === "changed" || input.observation.status === "promoted"
        ? (input.observation.promoted_catalog_item_id as CatalogItemId | null)
        : null;
    if ((input.observation.status === "changed" || input.observation.status === "promoted") && !existingCatalogItemId) {
      throw new Error(
        `${capitalize(input.observation.status)} source observation is missing its promoted Catalog Item.`,
      );
    }

    const catalogMapping = await loadCatalogItemPromotionProfile(deps, providerProfile);
    const duplicatePreventionResult = !existingCatalogItemId
      ? await resolveCatalogProviderDuplicatePrevention({
          db: deps.db,
          profile: providerProfile,
          providerKey: input.observation.provider_key,
          externalKey: input.observation.external_key,
          normalized,
          catalog: {
            blueprintId: catalogMapping.blueprintId,
            categoryId: catalogMapping.categoryId,
            fieldIds: catalogMapping.fieldIds,
          },
        })
      : null;
    if (duplicatePreventionResult?.status === "blocked") {
      throw new Error(duplicatePreventionResult.diagnosticText);
    }
    const reusableCatalogItemId =
      existingCatalogItemId ??
      (duplicatePreventionResult?.status === "matched" ? duplicatePreventionResult.catalogItemId : null);
    const catalogItemId = reusableCatalogItemId ?? (createId("cat") as CatalogItemId);

    const { referenceRecordIdsByTypeKey, ...promotionEvidence } = reusableCatalogItemId
      ? await refreshCatalogItemFromObservation({
          items,
          referenceData,
          productContents,
          deps,
          catalogItemId: reusableCatalogItemId,
          normalized,
          providerKey: input.observation.provider_key,
          externalKey: input.observation.external_key,
          providerProfile,
          providerProfileVersion,
          catalogMapping,
          sourceUpdatedAt: input.observation.source_updated_at,
          observedAt: input.observation.observed_at,
          productAssetSource: input.productAssetSource,
          context: input.context,
        })
      : await createCatalogDraftFromObservation({
          items,
          referenceData,
          productContents,
          deps,
          catalogItemId,
          normalized,
          providerKey: input.observation.provider_key,
          externalKey: input.observation.external_key,
          providerProfile,
          providerProfileVersion,
          catalogMapping,
          sourceUpdatedAt: input.observation.source_updated_at,
          observedAt: input.observation.observed_at,
          productAssetSource: input.productAssetSource,
          context: input.context,
        });

    await promoteAliasesForObservation({
      observationId: input.observation.observation_id,
      catalogItemId,
      referenceRecordIdsByTypeKey,
      context: input.context,
    });

    if (input.observation.status !== "promoted") {
      const promotedAt = new Date().toISOString();
      await commandHandler({
        streamId: sourceObservationStreamId(input.observation.observation_id),
        command: {
          type: "PromoteSourceObservation",
          catalogItemId,
          promotedAt,
          ...promotionEvidence,
        },
        context: input.context,
      });
    }

    return {
      observationId: input.observation.observation_id,
      catalogItemId,
      ...promotionEvidence,
    };
  }

  async function promoteReferenceObservationFromRow(input: {
    observation: SourceObservationDetailRow;
    normalized:
      | SourceObservationMagicSetReferenceNormalized
      | SourceObservationLorcanaSetReferenceNormalized
      | SourceObservationOnePieceSetReferenceNormalized;
    context: EventStoreContext;
  }): Promise<SourceObservationPromotionTargetResult> {
    const providerProfileVersion = await requireReferenceDataPromotionProfileVersion(
      profileVersions,
      input.observation.provider_key,
      input.normalized,
    );
    const { targetReferenceRecordId } = await resolveReferenceDataPromotionHierarchy({
      deps,
      referenceData,
      profile: providerProfileVersion.profile,
      normalized: input.normalized,
      context: input.context,
    });
    const promotionEvidence = referenceDataPromotionEvidence({
      providerProfileVersion,
      normalized: input.normalized,
      referenceRecordId: targetReferenceRecordId,
    });

    if (input.observation.status !== "promoted") {
      await commandHandler({
        streamId: sourceObservationStreamId(input.observation.observation_id),
        command: {
          type: "PromoteSourceObservationReference",
          referenceRecordId: targetReferenceRecordId,
          promotedAt: new Date().toISOString(),
          ...promotionEvidence,
        },
        context: input.context,
      });
    }

    return {
      observationId: input.observation.observation_id,
      catalogItemId: null,
      referenceRecordId: targetReferenceRecordId,
    };
  }

  async function promoteObservationIds(input: {
    observationIds: readonly string[];
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
    runPromoteObservation?: DurableSideEffectRunner;
  }): Promise<BulkSourceObservationPromotionResult> {
    rolloutControlPolicy.assertAllowed({ capability: "promotion" });
    const requestedIds = uniqueObservationIds(input.observationIds);
    const outcomes: BulkSourceObservationPromotionOutcome[] = [];
    await input.onProgress?.(bulkProgress(0, requestedIds.length));

    for (const observationId of requestedIds) {
      let currentName: string | null = null;
      const outcomeCountBefore = outcomes.length;
      try {
        const observation = await getSourceObservationDetail(deps.db, observationId);
        currentName = observation?.normalized.name ?? null;

        if (!observation) {
          outcomes.push({
            observationId,
            status: "failed",
            catalogItemId: null,
            reason: "Source observation was not found.",
          });
          continue;
        }
        rolloutControlPolicy.assertAllowed({ capability: "promotion", providerKey: observation.provider_key });

        if (!isPromotableObservationStatus(observation.status)) {
          const recovered = await recoverAlreadyPromotedObservationOutcome(observationId);
          outcomes.push(
            recovered ?? {
              observationId,
              status: "skipped",
              catalogItemId: observation.promoted_catalog_item_id as CatalogItemId | null,
              referenceRecordId: observation.promoted_reference_record_id as ReferenceRecordId | null,
              reason: `Source observation is ${observation.status}.`,
            },
          );
          continue;
        }

        const promoted = await (input.runPromoteObservation ?? runSourceObservationSideEffectImmediately)(() =>
          promoteObservationFromRow({
            observation,
            context: input.context,
          }),
        );
        outcomes.push({
          observationId,
          status: "promoted",
          catalogItemId: promoted.catalogItemId,
          referenceRecordId: promoted.referenceRecordId,
          reason: null,
        });
      } catch (error) {
        if (isDurableJobHandoffError(error)) {
          throw error;
        }
        const recovered = await recoverAlreadyPromotedObservationOutcome(observationId);
        outcomes.push(
          recovered ?? {
            observationId,
            status: "failed",
            catalogItemId: null,
            reason: error instanceof Error ? error.message : "Promotion failed.",
          },
        );
      } finally {
        if (outcomes.length > outcomeCountBefore) {
          const outcome = outcomes[outcomes.length - 1];
          await input.onProgress?.(
            bulkProgress(outcomes.length, requestedIds.length, currentName, outcome?.status ?? null),
          );
        }
      }
    }

    await input.onProgress?.(bulkProgress(requestedIds.length, requestedIds.length, null, null, "completed"));

    return summarizePromotionOutcomes(requestedIds.length, outcomes);
  }

  async function recoverAlreadyPromotedObservationOutcome(
    observationId: string,
  ): Promise<BulkSourceObservationPromotionOutcome | null> {
    const latestObservation = await getSourceObservationDetail(deps.db, observationId);
    if (latestObservation?.status !== "promoted") {
      return null;
    }
    const catalogItemId = latestObservation.promoted_catalog_item_id as CatalogItemId | null;
    const referenceRecordId = latestObservation.promoted_reference_record_id as ReferenceRecordId | null;
    if (!catalogItemId && !referenceRecordId) {
      return null;
    }

    return {
      observationId,
      status: "promoted",
      catalogItemId,
      referenceRecordId,
      reason: null,
    };
  }

  async function reapplyObservationFromRow(input: {
    observation: SourceObservationDetailRow;
    context: EventStoreContext;
    reapplyProfileMode: SourceObservationReapplyProfileMode;
    profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  }): Promise<SourceObservationPromotionTargetResult> {
    if (
      isMagicSetReferenceSourceObservationNormalized(input.observation.normalized) ||
      isLorcanaSetReferenceSourceObservationNormalized(input.observation.normalized) ||
      isOnePieceSetReferenceSourceObservationNormalized(input.observation.normalized)
    ) {
      return reapplyReferenceObservationFromRow({
        ...input,
        normalized: input.observation.normalized,
      });
    }

    return reapplyCatalogItemObservationFromRow(input);
  }

  async function reapplyCatalogItemObservationFromRow(input: {
    observation: SourceObservationDetailRow;
    context: EventStoreContext;
    reapplyProfileMode: SourceObservationReapplyProfileMode;
    profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  }): Promise<SourceObservationPromotionTargetResult> {
    const normalized = requireCatalogItemPromotionObservation(
      input.observation.normalized,
      input.observation.provider_key,
    );
    const providerProfileVersion = await requireCatalogPromotionProfileVersionForReapply(
      profileVersions,
      input.observation,
      normalized,
      input.reapplyProfileMode,
      input.profileSnapshot ?? null,
    );
    const providerProfile = providerProfileVersion.profile;
    requirePromotionAssetPorts({ deps, normalized });

    if (input.observation.status !== "promoted") {
      throw new Error("Only promoted source observations can be reapplied.");
    }

    const catalogItemId = input.observation.promoted_catalog_item_id as CatalogItemId | null;
    if (!catalogItemId) {
      throw new Error("Promoted source observation is missing its Catalog Item.");
    }

    const { referenceRecordIdsByTypeKey, ...promotionEvidence } = await refreshCatalogItemFromObservation({
      items,
      referenceData,
      productContents,
      deps,
      catalogItemId,
      normalized,
      providerKey: input.observation.provider_key,
      externalKey: input.observation.external_key,
      providerProfile,
      providerProfileVersion,
      catalogMapping: await loadCatalogItemPromotionProfile(deps, providerProfile),
      sourceUpdatedAt: input.observation.source_updated_at,
      observedAt: input.observation.observed_at,
      context: input.context,
    });

    await promoteAliasesForObservation({
      observationId: input.observation.observation_id,
      catalogItemId,
      referenceRecordIdsByTypeKey,
      context: input.context,
    });

    await commandHandler({
      streamId: sourceObservationStreamId(input.observation.observation_id),
      command: {
        type: "RecordSourceObservationPromotionPlan",
        catalogItemId,
        ...promotionEvidence,
      },
      context: input.context,
    });

    return {
      observationId: input.observation.observation_id,
      catalogItemId,
    };
  }

  async function reapplyReferenceObservationFromRow(input: {
    observation: SourceObservationDetailRow;
    normalized:
      | SourceObservationMagicSetReferenceNormalized
      | SourceObservationLorcanaSetReferenceNormalized
      | SourceObservationOnePieceSetReferenceNormalized;
    context: EventStoreContext;
    reapplyProfileMode: SourceObservationReapplyProfileMode;
    profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  }): Promise<SourceObservationPromotionTargetResult> {
    const providerProfileVersion = await requireReferenceDataPromotionProfileVersionForReapply(
      profileVersions,
      input.observation,
      input.normalized,
      input.reapplyProfileMode,
      input.profileSnapshot ?? null,
    );

    if (input.observation.status !== "promoted") {
      throw new Error("Only promoted source observations can be reapplied.");
    }

    const { targetReferenceRecordId } = await resolveReferenceDataPromotionHierarchy({
      deps,
      referenceData,
      profile: providerProfileVersion.profile,
      normalized: input.normalized,
      context: input.context,
    });
    const promotionEvidence = referenceDataPromotionEvidence({
      providerProfileVersion,
      normalized: input.normalized,
      referenceRecordId: targetReferenceRecordId,
    });

    await commandHandler({
      streamId: sourceObservationStreamId(input.observation.observation_id),
      command: {
        type: "RecordSourceObservationReferencePromotionPlan",
        referenceRecordId: targetReferenceRecordId,
        ...promotionEvidence,
      },
      context: input.context,
    });

    return {
      observationId: input.observation.observation_id,
      catalogItemId: null,
      referenceRecordId: targetReferenceRecordId,
    };
  }

  async function reapplyObservationIds(input: {
    observationIds: readonly string[];
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
    runReapplyObservation?: DurableSideEffectRunner;
    reapplyProfileMode: SourceObservationReapplyProfileMode;
    profileSnapshot?: SourceObservationIntegrationProfileSnapshot | null;
  }): Promise<BulkSourceObservationReapplyResult> {
    rolloutControlPolicy.assertAllowed({ capability: "reapply" });
    const requestedIds = uniqueObservationIds(input.observationIds);
    const outcomes: BulkSourceObservationReapplyOutcome[] = [];
    await input.onProgress?.(bulkProgress(0, requestedIds.length));

    for (const observationId of requestedIds) {
      let currentName: string | null = null;
      const outcomeCountBefore = outcomes.length;
      try {
        const observation = await getSourceObservationDetail(deps.db, observationId);
        currentName = observation?.normalized.name ?? null;

        if (!observation) {
          outcomes.push({
            observationId,
            status: "failed",
            catalogItemId: null,
            reason: "Source observation was not found.",
          });
          continue;
        }
        rolloutControlPolicy.assertAllowed({ capability: "reapply", providerKey: observation.provider_key });

        if (observation.status !== "promoted") {
          outcomes.push({
            observationId,
            status: "skipped",
            catalogItemId: observation.promoted_catalog_item_id as CatalogItemId | null,
            referenceRecordId: observation.promoted_reference_record_id as ReferenceRecordId | null,
            reason: `Source observation is ${observation.status}.`,
          });
          continue;
        }

        const reapplied = await (input.runReapplyObservation ?? runSourceObservationSideEffectImmediately)(() =>
          reapplyObservationFromRow({
            observation,
            context: input.context,
            reapplyProfileMode: input.reapplyProfileMode,
            profileSnapshot: input.profileSnapshot,
          }),
        );
        outcomes.push({
          observationId,
          status: "reapplied",
          catalogItemId: reapplied.catalogItemId,
          referenceRecordId: reapplied.referenceRecordId,
          reason: null,
        });
      } catch (error) {
        if (isDurableJobHandoffError(error)) {
          throw error;
        }
        outcomes.push({
          observationId,
          status: "failed",
          catalogItemId: null,
          reason: error instanceof Error ? error.message : "Reapply failed.",
        });
      } finally {
        if (outcomes.length > outcomeCountBefore) {
          const outcome = outcomes[outcomes.length - 1];
          await input.onProgress?.(
            bulkProgress(outcomes.length, requestedIds.length, currentName, outcome?.status ?? null),
          );
        }
      }
    }

    await input.onProgress?.(bulkProgress(requestedIds.length, requestedIds.length, null, null, "completed"));

    return summarizeReapplyOutcomes(requestedIds.length, outcomes);
  }

  async function rejectObservationIds(input: {
    observationIds: readonly string[];
    reason: string;
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
    runRejectObservation?: DurableSideEffectRunner;
  }): Promise<BulkSourceObservationPromotionResult> {
    const requestedIds = uniqueObservationIds(input.observationIds);
    const outcomes: BulkSourceObservationPromotionOutcome[] = [];
    await input.onProgress?.(bulkProgress(0, requestedIds.length));

    for (const observationId of requestedIds) {
      let currentName: string | null = null;
      const outcomeCountBefore = outcomes.length;
      try {
        const observation = await getSourceObservationDetail(deps.db, observationId);
        currentName = observation?.normalized.name ?? null;

        if (!observation) {
          outcomes.push({
            observationId,
            status: "failed",
            catalogItemId: null,
            reason: "Source observation was not found.",
          });
          continue;
        }

        if (observation.status !== "observed") {
          outcomes.push({
            observationId,
            status: "skipped",
            catalogItemId: observation.promoted_catalog_item_id as CatalogItemId | null,
            reason: `Source observation is already ${observation.status}.`,
          });
          continue;
        }

        await (input.runRejectObservation ?? runSourceObservationSideEffectImmediately)(() =>
          commandHandler({
            streamId: sourceObservationStreamId(observationId),
            command: {
              type: "RejectSourceObservation",
              reason: input.reason,
            },
            context: input.context,
          }),
        );
        outcomes.push({
          observationId,
          status: "rejected",
          catalogItemId: null,
          reason: null,
        });
      } catch (error) {
        if (isDurableJobHandoffError(error)) {
          throw error;
        }
        outcomes.push({
          observationId,
          status: "failed",
          catalogItemId: null,
          reason: error instanceof Error ? error.message : "Rejection failed.",
        });
      } finally {
        if (outcomes.length > outcomeCountBefore) {
          const outcome = outcomes[outcomes.length - 1];
          await input.onProgress?.(
            bulkProgress(outcomes.length, requestedIds.length, currentName, outcome?.status ?? null),
          );
        }
      }
    }

    await input.onProgress?.(bulkProgress(requestedIds.length, requestedIds.length, null, null, "completed"));

    return summarizePromotionOutcomes(requestedIds.length, outcomes);
  }

  async function deferObservationIds(input: {
    observationIds: readonly string[];
    reason: string;
    context: EventStoreContext;
    onProgress?: SourceObservationProgressHandler;
    runDeferObservation?: DurableSideEffectRunner;
  }): Promise<BulkSourceObservationPromotionResult> {
    const requestedIds = uniqueObservationIds(input.observationIds);
    const outcomes: BulkSourceObservationPromotionOutcome[] = [];
    await input.onProgress?.(bulkProgress(0, requestedIds.length));

    for (const observationId of requestedIds) {
      let currentName: string | null = null;
      const outcomeCountBefore = outcomes.length;
      try {
        const observation = await getSourceObservationDetail(deps.db, observationId);
        currentName = observation?.normalized.name ?? null;

        if (!observation) {
          outcomes.push({
            observationId,
            status: "failed",
            catalogItemId: null,
            reason: "Source observation was not found.",
          });
          continue;
        }

        if (!isReviewableObservationStatus(observation.status)) {
          outcomes.push({
            observationId,
            status: "skipped",
            catalogItemId: observation.promoted_catalog_item_id as CatalogItemId | null,
            reason: `Source observation is ${observation.status}.`,
          });
          continue;
        }

        await (input.runDeferObservation ?? runSourceObservationSideEffectImmediately)(() =>
          commandHandler({
            streamId: sourceObservationStreamId(observationId),
            command: {
              type: "DeferSourceObservation",
              reason: input.reason,
              deferredAt: new Date().toISOString(),
            },
            context: input.context,
          }),
        );
        outcomes.push({
          observationId,
          status: "deferred",
          catalogItemId: observation.promoted_catalog_item_id as CatalogItemId | null,
          reason: null,
        });
      } catch (error) {
        if (isDurableJobHandoffError(error)) {
          throw error;
        }
        outcomes.push({
          observationId,
          status: "failed",
          catalogItemId: null,
          reason: error instanceof Error ? error.message : "Deferral failed.",
        });
      } finally {
        if (outcomes.length > outcomeCountBefore) {
          const outcome = outcomes[outcomes.length - 1];
          await input.onProgress?.(
            bulkProgress(outcomes.length, requestedIds.length, currentName, outcome?.status ?? null),
          );
        }
      }
    }

    await input.onProgress?.(bulkProgress(requestedIds.length, requestedIds.length, null, null, "completed"));

    return summarizePromotionOutcomes(requestedIds.length, outcomes);
  }

  const services: SourceObservationReviewServices & PromotionReapplyServices = {
    promoteObservation: async ({ observationId, context, productAssetSource }) => {
      const observation = await getSourceObservationDetail(deps.db, observationId);
      if (!observation) {
        throw new Error("Source observation was not found.");
      }
      rolloutControlPolicy.assertAllowed({ capability: "promotion", providerKey: observation.provider_key });

      if (!isPromotableObservationStatus(observation.status)) {
        const recovered = await recoverAlreadyPromotedObservationOutcome(observationId);
        if (recovered?.catalogItemId) {
          return {
            observationId,
            catalogItemId: recovered.catalogItemId as CatalogItemId,
          };
        }
        throw new Error("Only observed or changed source observations can be promoted.");
      }

      try {
        const promoted = await promoteObservationFromRow({ observation, context, productAssetSource });
        return {
          observationId: promoted.observationId,
          catalogItemId: promoted.catalogItemId,
          ...(promoted.referenceRecordId ? { referenceRecordId: promoted.referenceRecordId } : {}),
        };
      } catch (error) {
        const recovered = await recoverAlreadyPromotedObservationOutcome(observationId);
        if (recovered?.catalogItemId) {
          return {
            observationId,
            catalogItemId: recovered.catalogItemId as CatalogItemId,
          };
        }
        throw error;
      }
    },
    promoteObservations: promoteObservationIds,
    previewPromoteObservations: async ({ observationIds }) =>
      previewSourceObservationPromotionIds(deps.db, observationIds),
    previewPromoteObservationScope: async ({ scope }) => previewSourceObservationPromotionScope(deps.db, scope),
    promoteObservationScope: async ({ scope, context, onProgress }) => {
      const observationIds = await listSourceObservationIdsForPromotion(deps.db, scope);
      return promoteObservationIds({
        observationIds,
        context,
        onProgress,
      });
    },
    previewReapplyObservationScope: async ({ scope }) => previewSourceObservationReapplyScope(deps.db, scope),
    reapplyObservations: reapplyObservationIds,
    reapplyObservationScope: async ({ scope, context, onProgress }) => {
      const observationIds = await listSourceObservationIdsForReapply(deps.db, scope);
      return reapplyObservationIds({
        observationIds,
        context,
        onProgress,
        reapplyProfileMode: "current-active-profile",
      });
    },
    rejectObservations: rejectObservationIds,
    rejectObservationScope: async ({ scope, reason, context, onProgress }) => {
      const observationIds = await listSourceObservationIdsForPromotion(deps.db, scope);
      return rejectObservationIds({
        observationIds,
        reason,
        context,
        onProgress,
      });
    },
    deferObservations: deferObservationIds,
    deferObservationScope: async ({ scope, reason, context, onProgress }) => {
      const observationIds = await listSourceObservationIdsForPromotion(deps.db, scope);
      return deferObservationIds({
        observationIds,
        reason,
        context,
        onProgress,
      });
    },
    rejectObservation: async ({ observationId, reason, context }) => {
      await commandHandler({
        streamId: sourceObservationStreamId(observationId),
        command: {
          type: "RejectSourceObservation",
          reason,
        },
        context,
      });
      return { observationId, status: "rejected" };
    },
  };

  return {
    services,
    promoteObservationIds,
    reapplyObservationIds,
    rejectObservationIds,
    deferObservationIds,
  };
}

export type SourceObservationPromotionReapplyRuntime = ReturnType<
  typeof createSourceObservationPromotionReapplyRuntime
>;
