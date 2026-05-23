import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { withCatalogAdminRealtimeInvalidation } from "../../../support/projection-support/realtime-invalidation";
import { catalogSeedIds } from "../../../support/seed-support/ids";
import type { CatalogItemId, BlueprintId, CategoryId, FieldId, ReferenceRecordId, ReferenceTypeId } from "../../../ids";
import type { LocalizedTextMap } from "../../../support/runtime-support/common";
import { productAssetSetCompatibilityImageUrls } from "../../../support/runtime-support/product-assets";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import type { ReferenceRelationship } from "../../reference-data/domain/domain";
import {
  decideSourceObservation,
  evolveSourceObservation,
  initialSourceObservationState,
  type SourceObservationCommand,
  type SourceObservationEvent,
  type SourceObservationNormalized,
  type SourceObservationState,
} from "../domain/domain";
import { buildSourceObservationProjectionHandlers } from "../read-model/projection";
import {
  getSourceObservationDetail,
  listSourceObservationIdsForReapply,
  listSourceObservationIdsForPromotion,
  listSourceObservationIntegrationScopes,
  listSourceObservations,
  previewSourceObservationReapplyScope,
  previewSourceObservationPromotionScope,
  type SourceObservationDetailRow,
  type SourceObservationFilterScope,
  type SourceObservationIntegrationScopeRow,
  type SourceObservationPromotionPreview,
  type SourceObservationReapplyPreview,
} from "../read-model/queries";
import {
  fetchTcgdexExpansionOptions,
  fetchTcgdexSeriesOptions,
  fetchTcgdexSetObservations,
  listTcgdexLanguageOptions,
  normalizeTcgdexImageAsset,
  type TcgdexExpansionOption,
  type TcgdexLanguageOption,
  type TcgdexSeriesOption,
  type TcgdexSetImportProgress,
  type TcgdexSetImportResult,
} from "./tcgdex-client";

const PRINTED_CARD_COUNT_ATTRIBUTE = "printed-card-count";

export type BulkSourceObservationPromotionOutcome = Readonly<{
  observationId: string;
  status: "promoted" | "rejected" | "skipped" | "failed";
  catalogItemId: CatalogItemId | null;
  reason: string | null;
}>;

export type BulkSourceObservationPromotionResult = Readonly<{
  requested: number;
  promoted: number;
  rejected?: number;
  skipped: number;
  failed: number;
  outcomes: readonly BulkSourceObservationPromotionOutcome[];
}>;

export type BulkSourceObservationReapplyOutcome = Readonly<{
  observationId: string;
  status: "reapplied" | "skipped" | "failed";
  catalogItemId: CatalogItemId | null;
  reason: string | null;
}>;

export type BulkSourceObservationReapplyResult = Readonly<{
  requested: number;
  reapplied: number;
  skipped: number;
  failed: number;
  outcomes: readonly BulkSourceObservationReapplyOutcome[];
}>;

export type BulkSourceObservationProgress = Readonly<{
  phase: "queued" | "processing" | "completed" | "failed";
  completed: number;
  total: number;
  currentName: string | null;
  status:
    | BulkSourceObservationPromotionOutcome["status"]
    | BulkSourceObservationReapplyOutcome["status"]
    | "imported"
    | null;
}>;

export type SourceObservationBulkJobAction = "promote" | "reject";

export type SourceObservationBulkJobStatus = "queued" | "running" | "completed" | "failed";

export type SourceObservationBulkJob = Readonly<{
  jobId: string;
  action: SourceObservationBulkJobAction;
  selectionMode: "ids" | "filter";
  observationIds: readonly string[];
  scope: SourceObservationFilterScope;
  reason: string | null;
  status: SourceObservationBulkJobStatus;
  progress: BulkSourceObservationProgress;
  result: BulkSourceObservationPromotionResult | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}>;

export type SourceObservationIntegrationJobAction = "import" | "reapply";

export type SourceObservationIntegrationJobScope = Readonly<{
  provider?: string;
  language?: string;
  seriesId?: string;
  setId?: string;
}>;

export type SourceObservationIntegrationJobOutcome = Readonly<{
  providerKey: string;
  languageCode: string;
  expansionId: string | null;
  status: "imported" | "reapplied" | "skipped" | "failed";
  observed: number;
  reapplied: number;
  reason: string | null;
}>;

export type SourceObservationIntegrationJobResult = Readonly<{
  requested: number;
  imported: number;
  observed: number;
  reapplied: number;
  skipped: number;
  failed: number;
  outcomes: readonly SourceObservationIntegrationJobOutcome[];
}>;

export type SourceObservationIntegrationJob = Readonly<{
  jobId: string;
  action: SourceObservationIntegrationJobAction;
  scope: SourceObservationIntegrationJobScope;
  status: SourceObservationBulkJobStatus;
  progress: BulkSourceObservationProgress;
  result: SourceObservationIntegrationJobResult | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}>;

export type SourceObservationIntegrationOption = Readonly<{
  providerKey: string;
  queryKind: string;
  value: string;
  label: string;
  description: string | null;
  parentValue: string | null;
  imageUrl: string | null;
  metadata: Readonly<Record<string, JsonValue>>;
}>;

export type SourceObservationServices = Readonly<{
  commandHandler: CommandHandler<SourceObservationCommand, SourceObservationState, SourceObservationEvent>;
  importTcgdexSet: (input: {
    languageCode: string;
    setId: string;
    context: EventStoreContext;
    onProgress?: (progress: TcgdexSetImportProgress) => void;
  }) => Promise<TcgdexSetImportResult>;
  listTcgdexLanguages: () => Promise<readonly TcgdexLanguageOption[]>;
  listTcgdexSeries: (input: { languageCode: string }) => Promise<readonly TcgdexSeriesOption[]>;
  listTcgdexExpansions: (input: {
    languageCode: string;
    seriesId?: string | null;
  }) => Promise<readonly TcgdexExpansionOption[]>;
  listIntegrationOptions: (input: {
    providerKey: string;
    queryKind: string;
    languageCode?: string | null;
    parentValue?: string | null;
  }) => Promise<readonly SourceObservationIntegrationOption[]>;
  promoteObservation: (input: {
    observationId: string;
    context: EventStoreContext;
  }) => Promise<{ observationId: string; catalogItemId: CatalogItemId }>;
  promoteObservations: (input: {
    observationIds: readonly string[];
    context: EventStoreContext;
    onProgress?: (progress: BulkSourceObservationProgress) => void;
  }) => Promise<BulkSourceObservationPromotionResult>;
  previewPromoteObservationScope: (input: {
    scope: SourceObservationFilterScope;
  }) => Promise<SourceObservationPromotionPreview>;
  promoteObservationScope: (input: {
    scope: SourceObservationFilterScope;
    context: EventStoreContext;
    onProgress?: (progress: BulkSourceObservationProgress) => void;
  }) => Promise<BulkSourceObservationPromotionResult>;
  previewReapplyObservationScope: (input: {
    scope: SourceObservationFilterScope;
  }) => Promise<SourceObservationReapplyPreview>;
  reapplyObservations: (input: {
    observationIds: readonly string[];
    context: EventStoreContext;
    onProgress?: (progress: BulkSourceObservationProgress) => void;
  }) => Promise<BulkSourceObservationReapplyResult>;
  reapplyObservationScope: (input: {
    scope: SourceObservationFilterScope;
    context: EventStoreContext;
    onProgress?: (progress: BulkSourceObservationProgress) => void;
  }) => Promise<BulkSourceObservationReapplyResult>;
  rejectObservations: (input: {
    observationIds: readonly string[];
    reason: string;
    context: EventStoreContext;
    onProgress?: (progress: BulkSourceObservationProgress) => void;
  }) => Promise<BulkSourceObservationPromotionResult>;
  rejectObservationScope: (input: {
    scope: SourceObservationFilterScope;
    reason: string;
    context: EventStoreContext;
    onProgress?: (progress: BulkSourceObservationProgress) => void;
  }) => Promise<BulkSourceObservationPromotionResult>;
  rejectObservation: (input: {
    observationId: string;
    reason: string;
    context: EventStoreContext;
  }) => Promise<{ observationId: string; status: "rejected" }>;
  enqueueBulkReviewJob: (input: {
    action: SourceObservationBulkJobAction;
    observationIds?: readonly string[];
    scope?: SourceObservationFilterScope;
    reason?: string | null;
    context: EventStoreContext;
  }) => Promise<SourceObservationBulkJob>;
  getBulkReviewJob: (jobId: string) => Promise<SourceObservationBulkJob | null>;
  listActiveBulkReviewJobs: (input: { context: EventStoreContext }) => Promise<readonly SourceObservationBulkJob[]>;
  processNextBulkReviewJob: (input: { claimOwnerId: string; claimTtlMs: number }) => Promise<number>;
  enqueueIntegrationJob: (input: {
    action: SourceObservationIntegrationJobAction;
    scope: SourceObservationIntegrationJobScope;
    context: EventStoreContext;
  }) => Promise<SourceObservationIntegrationJob>;
  getIntegrationJob: (jobId: string) => Promise<SourceObservationIntegrationJob | null>;
  listActiveIntegrationJobs: (input: {
    context: EventStoreContext;
  }) => Promise<readonly SourceObservationIntegrationJob[]>;
  processNextIntegrationJob: (input: { claimOwnerId: string; claimTtlMs: number }) => Promise<number>;
  listSourceObservations: (
    params?: Parameters<typeof listSourceObservations>[1],
  ) => ReturnType<typeof listSourceObservations>;
  listIntegrationScopes: (params?: {
    provider?: string;
    language?: string;
    setId?: string;
  }) => Promise<readonly SourceObservationIntegrationScopeRow[]>;
  getSourceObservationDetail: (observationId: string) => ReturnType<typeof getSourceObservationDetail>;
  projectors: readonly Projector[];
}>;

export function createSourceObservationRuntime(
  deps: CatalogRuntimeDeps,
  items: CatalogItemServices,
  referenceData: ReferenceDataServices,
): SourceObservationServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<SourceObservationEvent>(),
      initialState: () => initialSourceObservationState,
      evolve: evolveSourceObservation,
    }),
    evolve: evolveSourceObservation,
    decide: decideSourceObservation,
  });
  const projectors = [
    createProjector({
      projectorName: "catalog-source-observation-projection",
      eventStore: deps.eventStore,
      checkpointStore: deps.checkpointStore,
      handlers: withCatalogAdminRealtimeInvalidation(buildSourceObservationProjectionHandlers(deps.db), deps.db, {
        projectionName: "catalog-source-observation-projection",
        surface: "source-observations",
      }),
    }),
  ];

  async function recordObservation(
    observation: Awaited<ReturnType<typeof fetchTcgdexSetObservations>>[number],
    context: EventStoreContext,
  ) {
    await commandHandler({
      streamId: sourceObservationStreamId(observation.observationId),
      command: {
        type: "RecordSourceObservation",
        ...observation,
      },
      context,
    });
  }

  async function promoteObservationFromRow(input: {
    observation: SourceObservationDetailRow;
    context: EventStoreContext;
  }): Promise<{ observationId: string; catalogItemId: CatalogItemId }> {
    const existingCatalogItemId =
      input.observation.status === "changed" || input.observation.status === "promoted"
        ? (input.observation.promoted_catalog_item_id as CatalogItemId | null)
        : null;
    if ((input.observation.status === "changed" || input.observation.status === "promoted") && !existingCatalogItemId) {
      throw new Error(
        `${capitalize(input.observation.status)} source observation is missing its promoted Catalog Item.`,
      );
    }

    const sourceReferenceExternalKey = formatSourceReferenceExternalKey(input.observation);
    const referencedCatalogItemId =
      existingCatalogItemId ??
      (await findReusableCatalogItemIdForSourceReference({
        deps,
        providerKey: input.observation.provider_key,
        externalKey: sourceReferenceExternalKey,
      }));
    const catalogItemId = referencedCatalogItemId ?? (createId("cat") as CatalogItemId);

    if (referencedCatalogItemId) {
      await refreshCatalogItemFromObservation({
        items,
        referenceData,
        deps,
        catalogItemId: referencedCatalogItemId,
        normalized: input.observation.normalized,
        providerKey: input.observation.provider_key,
        externalKey: input.observation.external_key,
        context: input.context,
      });
    } else {
      await createCatalogDraftFromObservation({
        items,
        referenceData,
        deps,
        catalogItemId,
        normalized: input.observation.normalized,
        providerKey: input.observation.provider_key,
        externalKey: input.observation.external_key,
        context: input.context,
      });
    }

    if (input.observation.status !== "promoted") {
      const promotedAt = new Date().toISOString();
      await commandHandler({
        streamId: sourceObservationStreamId(input.observation.observation_id),
        command: {
          type: "PromoteSourceObservation",
          catalogItemId,
          promotedAt,
        },
        context: input.context,
      });
    }

    return {
      observationId: input.observation.observation_id,
      catalogItemId,
    };
  }

  async function promoteObservationIds(input: {
    observationIds: readonly string[];
    context: EventStoreContext;
    onProgress?: (progress: BulkSourceObservationProgress) => void;
  }): Promise<BulkSourceObservationPromotionResult> {
    const requestedIds = uniqueObservationIds(input.observationIds);
    const outcomes: BulkSourceObservationPromotionOutcome[] = [];
    input.onProgress?.(bulkProgress(0, requestedIds.length));

    for (const observationId of requestedIds) {
      let currentName: string | null = null;
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

        if (!isPromotableObservationStatus(observation.status)) {
          outcomes.push({
            observationId,
            status: "skipped",
            catalogItemId: observation.promoted_catalog_item_id as CatalogItemId | null,
            reason: `Source observation is ${observation.status}.`,
          });
          continue;
        }

        const promoted = await promoteObservationFromRow({
          observation,
          context: input.context,
        });
        outcomes.push({
          observationId,
          status: "promoted",
          catalogItemId: promoted.catalogItemId,
          reason: null,
        });
      } catch (error) {
        outcomes.push({
          observationId,
          status: "failed",
          catalogItemId: null,
          reason: error instanceof Error ? error.message : "Promotion failed.",
        });
      } finally {
        const outcome = outcomes[outcomes.length - 1];
        input.onProgress?.(bulkProgress(outcomes.length, requestedIds.length, currentName, outcome?.status ?? null));
      }
    }

    await drainRuntimeProjectors([...items.projectors, ...projectors]);
    input.onProgress?.(bulkProgress(requestedIds.length, requestedIds.length, null, null, "completed"));

    return summarizePromotionOutcomes(requestedIds.length, outcomes);
  }

  async function reapplyObservationFromRow(input: {
    observation: SourceObservationDetailRow;
    context: EventStoreContext;
  }): Promise<{ observationId: string; catalogItemId: CatalogItemId }> {
    if (input.observation.status !== "promoted") {
      throw new Error("Only promoted source observations can be reapplied.");
    }

    const catalogItemId = input.observation.promoted_catalog_item_id as CatalogItemId | null;
    if (!catalogItemId) {
      throw new Error("Promoted source observation is missing its Catalog Item.");
    }

    await refreshCatalogItemFromObservation({
      items,
      referenceData,
      deps,
      catalogItemId,
      normalized: input.observation.normalized,
      providerKey: input.observation.provider_key,
      externalKey: input.observation.external_key,
      context: input.context,
    });

    return {
      observationId: input.observation.observation_id,
      catalogItemId,
    };
  }

  async function reapplyObservationIds(input: {
    observationIds: readonly string[];
    context: EventStoreContext;
    onProgress?: (progress: BulkSourceObservationProgress) => void;
  }): Promise<BulkSourceObservationReapplyResult> {
    const requestedIds = uniqueObservationIds(input.observationIds);
    const outcomes: BulkSourceObservationReapplyOutcome[] = [];
    input.onProgress?.(bulkProgress(0, requestedIds.length));

    for (const observationId of requestedIds) {
      let currentName: string | null = null;
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

        if (observation.status !== "promoted") {
          outcomes.push({
            observationId,
            status: "skipped",
            catalogItemId: observation.promoted_catalog_item_id as CatalogItemId | null,
            reason: `Source observation is ${observation.status}.`,
          });
          continue;
        }

        const reapplied = await reapplyObservationFromRow({
          observation,
          context: input.context,
        });
        outcomes.push({
          observationId,
          status: "reapplied",
          catalogItemId: reapplied.catalogItemId,
          reason: null,
        });
      } catch (error) {
        outcomes.push({
          observationId,
          status: "failed",
          catalogItemId: null,
          reason: error instanceof Error ? error.message : "Reapply failed.",
        });
      } finally {
        const outcome = outcomes[outcomes.length - 1];
        input.onProgress?.(bulkProgress(outcomes.length, requestedIds.length, currentName, outcome?.status ?? null));
      }
    }

    await drainRuntimeProjectors(items.projectors);
    input.onProgress?.(bulkProgress(requestedIds.length, requestedIds.length, null, null, "completed"));

    return summarizeReapplyOutcomes(requestedIds.length, outcomes);
  }

  async function rejectObservationIds(input: {
    observationIds: readonly string[];
    reason: string;
    context: EventStoreContext;
    onProgress?: (progress: BulkSourceObservationProgress) => void;
  }): Promise<BulkSourceObservationPromotionResult> {
    const requestedIds = uniqueObservationIds(input.observationIds);
    const outcomes: BulkSourceObservationPromotionOutcome[] = [];
    input.onProgress?.(bulkProgress(0, requestedIds.length));

    for (const observationId of requestedIds) {
      let currentName: string | null = null;
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

        await commandHandler({
          streamId: sourceObservationStreamId(observationId),
          command: {
            type: "RejectSourceObservation",
            reason: input.reason,
          },
          context: input.context,
        });
        outcomes.push({
          observationId,
          status: "rejected",
          catalogItemId: null,
          reason: null,
        });
      } catch (error) {
        outcomes.push({
          observationId,
          status: "failed",
          catalogItemId: null,
          reason: error instanceof Error ? error.message : "Rejection failed.",
        });
      } finally {
        const outcome = outcomes[outcomes.length - 1];
        input.onProgress?.(bulkProgress(outcomes.length, requestedIds.length, currentName, outcome?.status ?? null));
      }
    }

    await drainRuntimeProjectors(projectors);
    input.onProgress?.(bulkProgress(requestedIds.length, requestedIds.length, null, null, "completed"));

    return summarizePromotionOutcomes(requestedIds.length, outcomes);
  }

  async function importTcgdexSetScope(input: {
    languageCode: string;
    setId: string;
    context: EventStoreContext;
    onProgress?: (progress: TcgdexSetImportProgress) => void;
  }): Promise<TcgdexSetImportResult> {
    const observations = await fetchTcgdexSetObservations({
      languageCode: input.languageCode,
      setId: input.setId,
      onProgress: input.onProgress,
    });

    if (observations[0]) {
      await ensurePokemonReferenceHierarchy({
        deps,
        referenceData,
        normalized: observations[0].normalized,
        context: input.context,
      });
    }

    for (const [index, observation] of observations.entries()) {
      await recordObservation(observation, input.context);
      input.onProgress?.({
        phase: "recording",
        completed: index + 1,
        total: observations.length,
        currentName: observation.normalized.name,
      });
    }
    await drainRuntimeProjectors(projectors);
    input.onProgress?.({
      phase: "completed",
      completed: observations.length,
      total: observations.length,
      currentName: null,
    });

    return {
      setId: input.setId,
      expansionId: input.setId,
      languageCode: input.languageCode,
      observed: observations.length,
      observationIds: observations.map((observation) => observation.observationId),
    };
  }

  async function enqueueBulkReviewJob(input: {
    action: SourceObservationBulkJobAction;
    observationIds?: readonly string[];
    scope?: SourceObservationFilterScope;
    reason?: string | null;
    context: EventStoreContext;
  }): Promise<SourceObservationBulkJob> {
    const observationIds = uniqueObservationIds(input.observationIds ?? []);
    const selectionMode = observationIds.length > 0 ? "ids" : "filter";
    const scope = selectionMode === "filter" ? normalizeBulkJobScope(input.scope ?? {}) : {};
    const jobId = createId("job");
    const progress = bulkProgress(0, 0, null, null, "queued");

    await deps.db.query(
      `INSERT INTO catalog_source_observation_bulk_jobs (
         job_id,
         action,
         selection_mode,
         observation_ids,
         scope,
         reason,
         event_context,
         status,
         progress,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, 'queued', $8::jsonb, now(), now())`,
      [
        jobId,
        input.action,
        selectionMode,
        JSON.stringify(observationIds),
        JSON.stringify(scope),
        input.reason?.trim() || null,
        JSON.stringify(input.context),
        JSON.stringify(progress),
      ],
    );

    const job = await getBulkReviewJob(deps.db, jobId);
    if (!job) {
      throw new Error("Bulk review job was not created.");
    }

    return job;
  }

  async function processNextBulkReviewJob(input: { claimOwnerId: string; claimTtlMs: number }): Promise<number> {
    const claimed = await claimNextBulkReviewJob(deps.db, input);
    if (!claimed) {
      return 0;
    }

    try {
      const context = claimed.eventContext;
      let progressWrite = Promise.resolve();
      const progressHandler = (progress: BulkSourceObservationProgress) => {
        progressWrite = progressWrite.then(() =>
          updateBulkReviewJobProgress(deps.db, claimed.jobId, progress, input.claimTtlMs),
        );
      };
      const result =
        claimed.action === "promote"
          ? claimed.selectionMode === "ids"
            ? await promoteObservationIds({
                observationIds: claimed.observationIds,
                context,
                onProgress: progressHandler,
              })
            : await promoteObservationIds({
                observationIds: await listSourceObservationIdsForPromotion(deps.db, claimed.scope),
                context,
                onProgress: progressHandler,
              })
          : claimed.selectionMode === "ids"
            ? await rejectObservationIds({
                observationIds: claimed.observationIds,
                reason: claimed.reason ?? "Rejected during review.",
                context,
                onProgress: progressHandler,
              })
            : await rejectObservationIds({
                observationIds: await listSourceObservationIdsForPromotion(deps.db, claimed.scope),
                reason: claimed.reason ?? "Rejected during review.",
                context,
                onProgress: progressHandler,
              });

      await progressWrite;
      await completeBulkReviewJob(deps.db, claimed.jobId, result);
      return 1;
    } catch (error) {
      await failBulkReviewJob(
        deps.db,
        claimed.jobId,
        error instanceof Error ? error.message : "Bulk review job failed.",
      );
      return 1;
    }
  }

  async function enqueueIntegrationJob(input: {
    action: SourceObservationIntegrationJobAction;
    scope: SourceObservationIntegrationJobScope;
    context: EventStoreContext;
  }): Promise<SourceObservationIntegrationJob> {
    const scope = normalizeIntegrationJobScope(input.scope);
    const jobId = createId("job");
    const progress = bulkProgress(0, 0, null, null, "queued");

    await deps.db.query(
      `INSERT INTO catalog_source_observation_integration_jobs (
         job_id,
         action,
         scope,
         event_context,
         status,
         progress,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3::jsonb, $4::jsonb, 'queued', $5::jsonb, now(), now())`,
      [jobId, input.action, JSON.stringify(scope), JSON.stringify(input.context), JSON.stringify(progress)],
    );

    const job = await getIntegrationJob(deps.db, jobId);
    if (!job) {
      throw new Error("Integration job was not created.");
    }

    return job;
  }

  async function processNextIntegrationJob(input: { claimOwnerId: string; claimTtlMs: number }): Promise<number> {
    const claimed = await claimNextIntegrationJob(deps.db, input);
    if (!claimed) {
      return 0;
    }

    try {
      let progressWrite = Promise.resolve();
      const progressHandler = (progress: BulkSourceObservationProgress) => {
        progressWrite = progressWrite.then(() =>
          updateIntegrationJobProgress(deps.db, claimed.jobId, progress, input.claimTtlMs),
        );
      };
      const result =
        claimed.action === "import"
          ? await processIntegrationImportJob({
              scope: claimed.scope,
              context: claimed.eventContext,
              onProgress: progressHandler,
            })
          : await processIntegrationReapplyJob({
              scope: claimed.scope,
              context: claimed.eventContext,
              onProgress: progressHandler,
            });

      await progressWrite;
      await completeIntegrationJob(deps.db, claimed.jobId, result);
      return 1;
    } catch (error) {
      await failIntegrationJob(
        deps.db,
        claimed.jobId,
        error instanceof Error ? error.message : "Integration job failed.",
      );
      return 1;
    }
  }

  async function processIntegrationImportJob(input: {
    scope: SourceObservationIntegrationJobScope;
    context: EventStoreContext;
    onProgress?: (progress: BulkSourceObservationProgress) => void;
  }): Promise<SourceObservationIntegrationJobResult> {
    const scope = normalizeIntegrationJobScope(input.scope);
    if (scope.provider && scope.provider !== "tcgdex") {
      throw new Error(`Provider '${scope.provider}' does not support background import.`);
    }

    const languageCode = scope.language || "en";
    const expansions = scope.setId
      ? [
          {
            expansionId: scope.setId,
            name: scope.setId,
          },
        ]
      : await fetchTcgdexExpansionOptions({
          languageCode,
          seriesId: scope.seriesId || null,
        });
    const outcomes: SourceObservationIntegrationJobOutcome[] = [];
    input.onProgress?.(bulkProgress(0, expansions.length));

    for (const expansion of expansions) {
      try {
        const result = await importTcgdexSetScope({
          languageCode,
          setId: expansion.expansionId,
          context: input.context,
        });
        outcomes.push({
          providerKey: "tcgdex",
          languageCode,
          expansionId: expansion.expansionId,
          status: "imported",
          observed: result.observed,
          reapplied: 0,
          reason: null,
        });
      } catch (error) {
        outcomes.push({
          providerKey: "tcgdex",
          languageCode,
          expansionId: expansion.expansionId,
          status: "failed",
          observed: 0,
          reapplied: 0,
          reason: error instanceof Error ? error.message : "Import failed.",
        });
      } finally {
        const outcome = outcomes[outcomes.length - 1];
        input.onProgress?.(bulkProgress(outcomes.length, expansions.length, expansion.name, outcome?.status ?? null));
      }
    }

    input.onProgress?.(bulkProgress(expansions.length, expansions.length, null, null, "completed"));

    return summarizeIntegrationJobOutcomes(expansions.length, outcomes);
  }

  async function processIntegrationReapplyJob(input: {
    scope: SourceObservationIntegrationJobScope;
    context: EventStoreContext;
    onProgress?: (progress: BulkSourceObservationProgress) => void;
  }): Promise<SourceObservationIntegrationJobResult> {
    const scope = integrationScopeToObservationScope(input.scope);
    const result = await reapplyObservationIds({
      observationIds: await listSourceObservationIdsForReapply(deps.db, scope),
      context: input.context,
      onProgress: input.onProgress,
    });

    return {
      requested: result.requested,
      imported: 0,
      observed: 0,
      reapplied: result.reapplied,
      skipped: result.skipped,
      failed: result.failed,
      outcomes: result.outcomes.map((outcome) => ({
        providerKey: input.scope.provider || "tcgdex",
        languageCode: input.scope.language || "",
        expansionId: input.scope.setId || null,
        status: outcome.status,
        observed: 0,
        reapplied: outcome.status === "reapplied" ? 1 : 0,
        reason: outcome.reason,
      })),
    };
  }

  return {
    commandHandler,
    importTcgdexSet: importTcgdexSetScope,
    listTcgdexLanguages: async () => listTcgdexLanguageOptions(),
    listTcgdexSeries: async ({ languageCode }) => fetchTcgdexSeriesOptions({ languageCode }),
    listTcgdexExpansions: async ({ languageCode, seriesId }) => fetchTcgdexExpansionOptions({ languageCode, seriesId }),
    listIntegrationOptions: listProviderIntegrationOptions,
    promoteObservation: async ({ observationId, context }) => {
      const observation = await getSourceObservationDetail(deps.db, observationId);
      if (!observation) {
        throw new Error("Source observation was not found.");
      }

      if (!isPromotableObservationStatus(observation.status)) {
        throw new Error("Only observed or changed source observations can be promoted.");
      }

      const result = await promoteObservationFromRow({ observation, context });
      await drainRuntimeProjectors([...items.projectors, ...projectors]);

      return result;
    },
    promoteObservations: promoteObservationIds,
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
    rejectObservation: async ({ observationId, reason, context }) => {
      await commandHandler({
        streamId: sourceObservationStreamId(observationId),
        command: {
          type: "RejectSourceObservation",
          reason,
        },
        context,
      });
      await drainRuntimeProjectors(projectors);

      return { observationId, status: "rejected" };
    },
    enqueueBulkReviewJob,
    getBulkReviewJob: (jobId) => getBulkReviewJob(deps.db, jobId),
    listActiveBulkReviewJobs: ({ context }) => listActiveBulkReviewJobs(deps.db, context),
    processNextBulkReviewJob,
    enqueueIntegrationJob,
    getIntegrationJob: (jobId) => getIntegrationJob(deps.db, jobId),
    listActiveIntegrationJobs: ({ context }) => listActiveIntegrationJobs(deps.db, context),
    processNextIntegrationJob,
    listSourceObservations: (params) => listSourceObservations(deps.db, params),
    listIntegrationScopes: (params) => listSourceObservationIntegrationScopes(deps.db, params),
    getSourceObservationDetail: (observationId) => getSourceObservationDetail(deps.db, observationId),
    projectors,
  };
}

async function listProviderIntegrationOptions(input: {
  providerKey: string;
  queryKind: string;
  languageCode?: string | null;
  parentValue?: string | null;
}): Promise<readonly SourceObservationIntegrationOption[]> {
  const providerKey = normalizeIntegrationKey(input.providerKey || "tcgdex");
  const queryKind = normalizeIntegrationKey(input.queryKind);
  const languageCode = normalizeIntegrationKey(input.languageCode || "en");
  const parentValue = input.parentValue?.trim() || null;

  if (providerKey !== "tcgdex") {
    throw new Error(`Unsupported Catalog integration provider: ${providerKey}.`);
  }

  if (queryKind === "languages" || queryKind === "language") {
    return listTcgdexLanguageOptions().map((item) => ({
      providerKey,
      queryKind: "languages",
      value: item.languageCode,
      label: item.languageCode,
      description: null,
      parentValue: null,
      imageUrl: null,
      metadata: { languageCode: item.languageCode },
    }));
  }

  if (queryKind === "series") {
    const series = await fetchTcgdexSeriesOptions({ languageCode });
    return series.map((item) => ({
      providerKey,
      queryKind: "series",
      value: item.seriesId,
      label: item.name,
      description: null,
      parentValue: languageCode,
      imageUrl: item.logoUrl,
      metadata: {
        languageCode,
        seriesId: item.seriesId,
        logoUrl: item.logoUrl,
      },
    }));
  }

  if (queryKind === "expansions" || queryKind === "expansion") {
    const expansions = await fetchTcgdexExpansionOptions({
      languageCode,
      seriesId: parentValue,
    });
    return expansions.map((item) => ({
      providerKey,
      queryKind: "expansions",
      value: item.expansionId,
      label: item.name,
      description: formatExpansionOptionDescription(item),
      parentValue: item.seriesId ?? parentValue,
      imageUrl: item.symbolUrl ?? item.logoUrl,
      metadata: {
        languageCode,
        expansionId: item.expansionId,
        seriesId: item.seriesId,
        seriesName: item.seriesName,
        logoUrl: item.logoUrl,
        symbolUrl: item.symbolUrl,
        cardCount: item.cardCount,
        officialCardCount: item.officialCardCount,
      },
    }));
  }

  throw new Error(`Unsupported Catalog integration query: ${queryKind}.`);
}

function formatExpansionOptionDescription(item: TcgdexExpansionOption): string | null {
  if (item.officialCardCount === null && item.cardCount === null) {
    return item.seriesName;
  }

  const count =
    item.officialCardCount !== null ? `${item.officialCardCount} official cards` : `${item.cardCount} cards`;

  return item.seriesName ? `${item.seriesName} - ${count}` : count;
}

function normalizeIntegrationKey(value: string): string {
  return value.trim().toLowerCase();
}

async function drainRuntimeProjectors(projectors: readonly Projector[]) {
  for (;;) {
    let processed = 0;
    for (const projector of projectors) {
      processed += (await projector.runOnce()).processed;
    }

    if (processed === 0) {
      return;
    }
  }
}

async function createCatalogDraftFromObservation(input: {
  items: CatalogItemServices;
  referenceData: ReferenceDataServices;
  deps: CatalogRuntimeDeps;
  catalogItemId: CatalogItemId;
  normalized: SourceObservationNormalized;
  providerKey: string;
  externalKey: string;
  context: EventStoreContext;
}) {
  const streamId = `catalog.item-${input.catalogItemId}`;
  const profile = await loadPokemonTcgPromotionProfile(input.deps);
  const expansionReferenceId = await ensurePokemonReferenceHierarchy({
    deps: input.deps,
    referenceData: input.referenceData,
    normalized: input.normalized,
    context: input.context,
  });
  const metadata = await formatPokemonCardPromotionMetadata({
    deps: input.deps,
    normalized: input.normalized,
    expansionReferenceId,
  });

  await input.items.commandHandler({
    streamId,
    command: {
      type: "CreateCatalogItem",
      itemId: input.catalogItemId,
      languageCode: input.normalized.languageCode,
      title: localizedText(metadata.title),
      subtitle: localizedText(metadata.subtitle),
      description: localizedText(input.normalized.imageDisclaimer ?? ""),
    },
    context: input.context,
  });
  await input.items.commandHandler({
    streamId,
    command: {
      type: "AssignBlueprintToCatalogItem",
      blueprintId: profile.blueprintId,
    },
    context: input.context,
  });
  await setFieldValue(input, profile.fieldIds.cardNumber, input.normalized.cardNumber);
  await setFieldValue(input, profile.fieldIds.cardName, localizedJsonText(input.normalized.name));
  await setFieldValue(input, profile.fieldIds.expansion, { referenceId: expansionReferenceId });
  await setFieldValue(input, profile.fieldIds.cardVariant, input.normalized.cardVariantLabel);

  if (input.normalized.rarity) {
    await setFieldValue(input, profile.fieldIds.rarity, input.normalized.rarity);
  }

  if (input.normalized.illustrator) {
    await setFieldValue(input, profile.fieldIds.cardIllustrator, input.normalized.illustrator);
  }

  if (input.normalized.releaseYear !== null) {
    await setFieldValue(input, profile.fieldIds.releaseYear, input.normalized.releaseYear);
  }

  await input.items.commandHandler({
    streamId,
    command: {
      type: "AssignCatalogItemToCategory",
      categoryId: profile.singlesCategoryId,
    },
    context: input.context,
  });
  await input.items.commandHandler({
    streamId,
    command: {
      type: "SetCatalogItemTags",
      tags: pokemonCatalogItemTags(input.normalized),
    },
    context: input.context,
  });
  const productAssetSet = input.normalized.imageBaseUrl
    ? await normalizeTcgdexImageAsset({
        imageBaseUrl: input.normalized.imageBaseUrl,
        storageBaseKey: catalogItemAssetObjectBaseKey(input.catalogItemId),
        observedAt: new Date().toISOString(),
        fetcher: globalThis.fetch,
        assetStorage: requireCatalogAssetStorage(input.deps.assetStorage),
      })
    : null;
  await input.items.commandHandler({
    streamId,
    command: {
      type: "SetCatalogItemImageUrls",
      imageUrls: productAssetSet
        ? productAssetSetCompatibilityImageUrls(productAssetSet)
        : [...input.normalized.imageUrls],
    },
    context: input.context,
  });
  if (productAssetSet) {
    await input.items.commandHandler({
      streamId,
      command: {
        type: "SetCatalogItemProductAssetSets",
        productAssetSets: [productAssetSet],
      },
      context: input.context,
    });
  }
  await input.items.commandHandler({
    streamId,
    command: {
      type: "LinkExternalProductReference",
      providerKey: input.providerKey,
      externalKey: `${input.normalized.languageCode}:${input.externalKey}`,
    },
    context: input.context,
  });
}

async function refreshCatalogItemFromObservation(input: {
  items: CatalogItemServices;
  referenceData: ReferenceDataServices;
  deps: CatalogRuntimeDeps;
  catalogItemId: CatalogItemId;
  normalized: SourceObservationNormalized;
  providerKey: string;
  externalKey: string;
  context: EventStoreContext;
}) {
  const streamId = `catalog.item-${input.catalogItemId}`;
  const profile = await loadPokemonTcgPromotionProfile(input.deps);
  const expansionReferenceId = await ensurePokemonReferenceHierarchy({
    deps: input.deps,
    referenceData: input.referenceData,
    normalized: input.normalized,
    context: input.context,
  });
  const metadata = await formatPokemonCardPromotionMetadata({
    deps: input.deps,
    normalized: input.normalized,
    expansionReferenceId,
  });

  await input.items.commandHandler({
    streamId,
    command: {
      type: "ReviseCatalogItemMetadata",
      languageCode: input.normalized.languageCode,
      title: localizedText(metadata.title),
      subtitle: localizedText(metadata.subtitle),
      description: localizedText(input.normalized.imageDisclaimer ?? ""),
    },
    context: input.context,
  });
  await setFieldValue(input, profile.fieldIds.cardNumber, input.normalized.cardNumber);
  await setFieldValue(input, profile.fieldIds.cardName, localizedJsonText(input.normalized.name));
  await setFieldValue(input, profile.fieldIds.expansion, { referenceId: expansionReferenceId });
  await setFieldValue(input, profile.fieldIds.cardVariant, input.normalized.cardVariantLabel);

  if (input.normalized.rarity) {
    await setFieldValue(input, profile.fieldIds.rarity, input.normalized.rarity);
  }

  if (input.normalized.illustrator) {
    await setFieldValue(input, profile.fieldIds.cardIllustrator, input.normalized.illustrator);
  }

  if (input.normalized.releaseYear !== null) {
    await setFieldValue(input, profile.fieldIds.releaseYear, input.normalized.releaseYear);
  }

  await input.items.commandHandler({
    streamId,
    command: {
      type: "SetCatalogItemTags",
      tags: pokemonCatalogItemTags(input.normalized),
    },
    context: input.context,
  });
  const productAssetSet = input.normalized.imageBaseUrl
    ? await normalizeTcgdexImageAsset({
        imageBaseUrl: input.normalized.imageBaseUrl,
        storageBaseKey: catalogItemAssetObjectBaseKey(input.catalogItemId),
        observedAt: new Date().toISOString(),
        fetcher: globalThis.fetch,
        assetStorage: requireCatalogAssetStorage(input.deps.assetStorage),
      })
    : null;
  await input.items.commandHandler({
    streamId,
    command: {
      type: "SetCatalogItemImageUrls",
      imageUrls: productAssetSet
        ? productAssetSetCompatibilityImageUrls(productAssetSet)
        : [...input.normalized.imageUrls],
    },
    context: input.context,
  });
  await input.items.commandHandler({
    streamId,
    command: {
      type: "SetCatalogItemProductAssetSets",
      productAssetSets: productAssetSet ? [productAssetSet] : [],
    },
    context: input.context,
  });
  await input.items.commandHandler({
    streamId,
    command: {
      type: "LinkExternalProductReference",
      providerKey: input.providerKey,
      externalKey: `${input.normalized.languageCode}:${input.externalKey}`,
    },
    context: input.context,
  });
}

async function formatPokemonCardPromotionMetadata(input: {
  deps: CatalogRuntimeDeps;
  normalized: SourceObservationNormalized;
  expansionReferenceId: ReferenceRecordId;
}): Promise<{ title: string; subtitle: string }> {
  const printedCardCount = await loadExpansionPrintedCardCountOverride(input.deps, input.expansionReferenceId);
  const cardNumber = formatPokemonCardNumber(input.normalized, printedCardCount);
  const title = [input.normalized.name, cardNumber].filter((part) => part.trim().length > 0).join(" ");

  return {
    title,
    subtitle: formatPokemonCardSubtitle(input.normalized),
  };
}

async function loadExpansionPrintedCardCountOverride(
  deps: CatalogRuntimeDeps,
  expansionReferenceId: ReferenceRecordId,
): Promise<string | null | undefined> {
  const result = await deps.db.query<{ attributes: unknown }>(
    `SELECT attributes
     FROM catalog_reference_records
     WHERE reference_record_id = $1
     LIMIT 1`,
    [expansionReferenceId],
  );
  const attributes = result.rows[0]?.attributes;
  if (!isJsonRecord(attributes) || !(PRINTED_CARD_COUNT_ATTRIBUTE in attributes)) {
    return undefined;
  }

  const value = attributes[PRINTED_CARD_COUNT_ATTRIBUTE];
  if (value === null) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  return undefined;
}

function formatPokemonCardNumber(
  normalized: SourceObservationNormalized,
  printedCardCountOverride: string | null | undefined,
): string {
  const denominator =
    printedCardCountOverride === undefined
      ? countToDisplayValue(normalized.expansionCardCount)
      : printedCardCountOverride;

  return denominator ? `${normalized.cardNumber}/${denominator}` : normalized.cardNumber;
}

function countToDisplayValue(value: number | null): string | null {
  return value === null ? null : String(value);
}

function formatPokemonCardSubtitle(normalized: SourceObservationNormalized): string {
  return [
    normalized.expansionName,
    shouldIncludeCardVariantInSubtitle(normalized.cardVariantLabel) ? normalized.cardVariantLabel : null,
    normalized.rarity,
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" • ");
}

function shouldIncludeCardVariantInSubtitle(cardVariantLabel: string): boolean {
  return cardVariantLabel.trim() !== "Standard Set";
}

function pokemonCatalogItemTags(normalized: SourceObservationNormalized): string[] {
  return [
    "pokemon",
    "tcgdex",
    `expansion:${normalized.expansionId}`,
    `category:${normalized.category.toLowerCase()}`,
    `variant:${normalized.cardVariantKey}`,
    ...(normalized.imageDisclaimer ? ["image-note:variant-reference"] : []),
  ];
}

function isPromotableObservationStatus(status: string): boolean {
  return status === "observed" || status === "changed" || status === "promoted";
}

function formatSourceReferenceExternalKey(
  observation: Pick<SourceObservationDetailRow, "normalized" | "external_key">,
) {
  return `${observation.normalized.languageCode}:${observation.external_key}`;
}

async function findReusableCatalogItemIdForSourceReference(input: {
  deps: CatalogRuntimeDeps;
  providerKey: string;
  externalKey: string;
}): Promise<CatalogItemId | null> {
  const result = await input.deps.db.query<{ catalog_item_id: string }>(
    `SELECT reference.catalog_item_id
     FROM catalog_external_product_references AS reference
     JOIN catalog_items AS item
       ON item.catalog_item_id = reference.catalog_item_id
     WHERE reference.provider_key = $1
       AND reference.external_key = $2
       AND item.status NOT IN ('archived', 'removed')
     LIMIT 1`,
    [input.providerKey, input.externalKey],
  );

  return (result.rows[0]?.catalog_item_id as CatalogItemId | undefined) ?? null;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function requireCatalogAssetStorage(assetStorage: CatalogRuntimeDeps["assetStorage"]) {
  if (!assetStorage) {
    throw new Error("Catalog asset storage is required to promote TCGDex image assets.");
  }

  return assetStorage;
}

function catalogItemAssetObjectBaseKey(catalogItemId: CatalogItemId): string {
  return `catalog/items/${catalogItemId}/product-image`;
}

async function setFieldValue(
  input: {
    items: CatalogItemServices;
    catalogItemId: CatalogItemId;
    context: EventStoreContext;
  },
  fieldId: FieldId,
  value: JsonValue,
) {
  await input.items.commandHandler({
    streamId: `catalog.item-${input.catalogItemId}`,
    command: {
      type: "SetCatalogItemFieldValue",
      fieldId,
      value,
    },
    context: input.context,
  });
}

export async function ensurePokemonReferenceHierarchy(input: {
  deps: CatalogRuntimeDeps;
  referenceData: ReferenceDataServices;
  normalized: SourceObservationNormalized;
  context: EventStoreContext;
}): Promise<ReferenceRecordId> {
  await ensureReferenceType(input, {
    referenceTypeId: catalogSeedIds.referenceTypes.manufacturer as ReferenceTypeId,
    key: "manufacturer",
    name: "Manufacturer",
    description: "A company responsible for publishing or manufacturing catalog products.",
    attributeKeys: ["homepage-url"],
  });
  await ensureReferenceType(input, {
    referenceTypeId: catalogSeedIds.referenceTypes.productLine as ReferenceTypeId,
    key: "product-line",
    name: "Product Line",
    description: "A branded collectible product line.",
    attributeKeys: ["official-name", "short-name"],
  });
  await ensureReferenceType(input, {
    referenceTypeId: catalogSeedIds.referenceTypes.series as ReferenceTypeId,
    key: "series",
    name: "Series",
    description: "An official Pokemon TCG series that groups expansions.",
    attributeKeys: ["tcgdex-series-id"],
  });
  await ensureReferenceType(input, {
    referenceTypeId: catalogSeedIds.referenceTypes.expansion as ReferenceTypeId,
    key: "expansion",
    name: "Expansion",
    description: "An official Pokemon TCG card expansion.",
    attributeKeys: [
      "abbreviation",
      "card-count",
      "parallel-set-card-count",
      "printed-card-count",
      "release-date",
      "tcgdex-set-id",
    ],
  });

  const manufacturerId = await ensureReferenceRecord(input, {
    referenceRecordId: catalogSeedIds.referenceRecords.manufacturers.thePokemonCompanyInternational,
    typeKey: "manufacturer",
    key: "the-pokemon-company-international",
    name: "The Pokemon Company International",
    description: "Publisher of the English Pokemon Trading Card Game.",
    attributes: { "homepage-url": "https://www.pokemon.com/us" },
  });
  const productLineId = await ensureReferenceRecord(input, {
    referenceRecordId: catalogSeedIds.referenceRecords.productLines.pokemonTradingCardGame,
    typeKey: "product-line",
    key: "pokemon-trading-card-game",
    name: "Pokemon Trading Card Game",
    description: "The Pokemon Trading Card Game product line.",
    attributes: {
      "official-name": "Pokemon Trading Card Game",
      "short-name": "Pokemon TCG",
    },
    relationships: [{ relationshipType: "published-by", referenceId: manufacturerId }],
  });
  const seriesReferenceId = input.normalized.seriesName
    ? await ensureReferenceRecord(input, {
        referenceRecordId: createId("ref") as ReferenceRecordId,
        typeKey: "series",
        key: normalizeReferenceKey(input.normalized.seriesName),
        name: input.normalized.seriesName,
        description: `${input.normalized.seriesName} Pokemon TCG series.`,
        attributes: input.normalized.seriesId ? { "tcgdex-series-id": input.normalized.seriesId } : {},
        relationships: [{ relationshipType: "part-of", referenceId: productLineId }],
      })
    : productLineId;

  const expansionAttributes: Record<string, JsonValue> = {
    "tcgdex-set-id": input.normalized.expansionId,
  };

  if (input.normalized.releaseDate) {
    expansionAttributes["release-date"] = input.normalized.releaseDate;
  }

  if (input.normalized.expansionAbbreviation) {
    expansionAttributes.abbreviation = input.normalized.expansionAbbreviation;
  }

  if (input.normalized.expansionCardCount !== null) {
    expansionAttributes["card-count"] = input.normalized.expansionCardCount;
  }

  if (input.normalized.expansionParallelSetCardCount !== null) {
    expansionAttributes["parallel-set-card-count"] = input.normalized.expansionParallelSetCardCount;
  }

  return ensureReferenceRecord(input, {
    referenceRecordId: createId("ref") as ReferenceRecordId,
    typeKey: "expansion",
    key: normalizeReferenceKey(input.normalized.expansionName),
    name: input.normalized.expansionName,
    description: `${input.normalized.expansionName} Pokemon TCG expansion.`,
    attributes: expansionAttributes,
    relationships: [{ relationshipType: "part-of", referenceId: seriesReferenceId }],
  });
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
  await input.referenceData.referenceTypeCommandHandler({
    streamId,
    command: { type: "PublishReferenceType" },
    context: input.context,
  });
  await drainRuntimeProjectors(input.referenceData.projectors);
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
  await input.referenceData.referenceRecordCommandHandler({
    streamId,
    command: { type: "PublishReferenceRecord" },
    context: input.context,
  });
  await drainRuntimeProjectors(input.referenceData.projectors);

  return def.referenceRecordId;
}

async function findReferenceRecordByProviderAttribute(
  deps: CatalogRuntimeDeps,
  def: {
    typeKey: string;
    attributes?: Readonly<Record<string, JsonValue>>;
  },
): Promise<ReferenceRecordId | null> {
  const providerAttributeKey =
    def.typeKey === "series" ? "tcgdex-series-id" : def.typeKey === "expansion" ? "tcgdex-set-id" : null;
  const providerAttributeValue = providerAttributeKey ? def.attributes?.[providerAttributeKey] : null;

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

async function loadPokemonTcgPromotionProfile(deps: CatalogRuntimeDeps): Promise<{
  blueprintId: BlueprintId;
  singlesCategoryId: CategoryId;
  fieldIds: {
    cardNumber: FieldId;
    cardName: FieldId;
    expansion: FieldId;
    rarity: FieldId;
    cardVariant: FieldId;
    cardIllustrator: FieldId;
    releaseYear: FieldId;
  };
}> {
  const [
    blueprintId,
    singlesCategoryId,
    cardNumber,
    cardName,
    expansion,
    rarity,
    cardVariant,
    cardIllustrator,
    releaseYear,
  ] = await Promise.all([
    requireCatalogIdByKey<BlueprintId>(deps, "catalog_blueprints", "blueprint_id", "pokemon-card-single"),
    requireCatalogIdByKey<CategoryId>(deps, "catalog_categories", "category_id", "singles"),
    requireCatalogIdByKey<FieldId>(deps, "catalog_fields", "field_id", "card-number"),
    requireCatalogIdByKey<FieldId>(deps, "catalog_fields", "field_id", "card-name"),
    requireCatalogIdByKey<FieldId>(deps, "catalog_fields", "field_id", "expansion"),
    requireCatalogIdByKey<FieldId>(deps, "catalog_fields", "field_id", "rarity"),
    requireCatalogIdByKey<FieldId>(deps, "catalog_fields", "field_id", "card-variant"),
    requireCatalogIdByKey<FieldId>(deps, "catalog_fields", "field_id", "card-illustrator"),
    requireCatalogIdByKey<FieldId>(deps, "catalog_fields", "field_id", "release-year"),
  ]);

  return {
    blueprintId,
    singlesCategoryId,
    fieldIds: {
      cardNumber,
      cardName,
      expansion,
      rarity,
      cardVariant,
      cardIllustrator,
      releaseYear,
    },
  };
}

async function requireCatalogIdByKey<TId extends string>(
  deps: CatalogRuntimeDeps,
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
      `TCGdex promotion requires active Catalog ${tableName} key '${key}'. Run the Catalog integration bootstrap first.`,
    );
  }

  return id as TId;
}

function localizedText(value: string): LocalizedTextMap {
  return {
    defaultLocale: "en" as const,
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

function localizedJsonText(value: string): JsonObject {
  return {
    defaultLocale: "en",
    values: {
      en: value,
    },
  };
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceObservationStreamId(observationId: string): string {
  return `catalog.source-observation-${observationId}`;
}

type SourceObservationBulkJobRow = Readonly<{
  job_id: string;
  action: SourceObservationBulkJobAction;
  selection_mode: "ids" | "filter";
  observation_ids: unknown;
  scope: unknown;
  reason: string | null;
  event_context: unknown;
  status: SourceObservationBulkJobStatus;
  progress: unknown;
  result: unknown;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}>;

type ClaimedSourceObservationBulkJob = SourceObservationBulkJob &
  Readonly<{
    eventContext: EventStoreContext;
  }>;

type SourceObservationIntegrationJobRow = Readonly<{
  job_id: string;
  action: SourceObservationIntegrationJobAction;
  scope: unknown;
  event_context: unknown;
  status: SourceObservationBulkJobStatus;
  progress: unknown;
  result: unknown;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}>;

type ClaimedSourceObservationIntegrationJob = SourceObservationIntegrationJob &
  Readonly<{
    eventContext: EventStoreContext;
  }>;

async function getBulkReviewJob(db: CatalogRuntimeDeps["db"], jobId: string): Promise<SourceObservationBulkJob | null> {
  const result = await db.query<SourceObservationBulkJobRow>(
    `SELECT
       job_id,
       action,
       selection_mode,
       observation_ids,
       scope,
       reason,
       event_context,
       status,
       progress,
       result,
       error_message,
       created_at::text,
       started_at::text,
       completed_at::text,
       updated_at::text
     FROM catalog_source_observation_bulk_jobs
     WHERE job_id = $1`,
    [jobId],
  );

  return result.rows[0] ? mapBulkReviewJobRow(result.rows[0]) : null;
}

async function listActiveBulkReviewJobs(
  db: CatalogRuntimeDeps["db"],
  context: EventStoreContext,
): Promise<readonly SourceObservationBulkJob[]> {
  const result = await db.query<SourceObservationBulkJobRow>(
    `SELECT
       job_id,
       action,
       selection_mode,
       observation_ids,
       scope,
       reason,
       event_context,
       status,
       progress,
       result,
       error_message,
       created_at::text,
       started_at::text,
       completed_at::text,
       updated_at::text
     FROM catalog_source_observation_bulk_jobs
     WHERE status IN ('queued', 'running')
       AND event_context ->> 'tenantId' = $1
       AND event_context #>> '{audit,performedByUserId}' = $2
     ORDER BY created_at ASC`,
    [context.tenantId, context.audit.performedByUserId],
  );

  return result.rows.map(mapBulkReviewJobRow);
}

async function claimNextBulkReviewJob(
  db: CatalogRuntimeDeps["db"],
  input: { claimOwnerId: string; claimTtlMs: number },
): Promise<ClaimedSourceObservationBulkJob | null> {
  const result = await db.query<SourceObservationBulkJobRow>(
    `WITH next_job AS (
       SELECT job_id
       FROM catalog_source_observation_bulk_jobs
       WHERE status = 'queued'
          OR (status = 'running' AND claim_expires_at < now())
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE catalog_source_observation_bulk_jobs AS job
     SET
       status = 'running',
       claim_owner_id = $1,
       claim_expires_at = now() + ($2::integer * interval '1 millisecond'),
       started_at = coalesce(job.started_at, now()),
       updated_at = now()
     FROM next_job
     WHERE job.job_id = next_job.job_id
     RETURNING
       job.job_id,
       job.action,
       job.selection_mode,
       job.observation_ids,
       job.scope,
       job.reason,
       job.event_context,
       job.status,
       job.progress,
       job.result,
       job.error_message,
       job.created_at::text,
       job.started_at::text,
       job.completed_at::text,
       job.updated_at::text`,
    [input.claimOwnerId, Math.max(1_000, Math.floor(input.claimTtlMs))],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    ...mapBulkReviewJobRow(row),
    eventContext: parseJsonField<EventStoreContext>(row.event_context, "event_context"),
  };
}

async function updateBulkReviewJobProgress(
  db: CatalogRuntimeDeps["db"],
  jobId: string,
  progress: BulkSourceObservationProgress,
  claimTtlMs: number,
): Promise<void> {
  await db.query(
    `UPDATE catalog_source_observation_bulk_jobs
     SET
       progress = $2::jsonb,
       claim_expires_at = now() + ($3::integer * interval '1 millisecond'),
       updated_at = now()
     WHERE job_id = $1
       AND status = 'running'`,
    [jobId, JSON.stringify(progress), Math.max(1_000, Math.floor(claimTtlMs))],
  );
}

async function completeBulkReviewJob(
  db: CatalogRuntimeDeps["db"],
  jobId: string,
  result: BulkSourceObservationPromotionResult,
): Promise<void> {
  await db.query(
    `UPDATE catalog_source_observation_bulk_jobs
     SET
       status = 'completed',
       progress = $2::jsonb,
       result = $3::jsonb,
       error_message = NULL,
       claim_owner_id = NULL,
       claim_expires_at = NULL,
       completed_at = now(),
       updated_at = now()
     WHERE job_id = $1`,
    [
      jobId,
      JSON.stringify(bulkProgress(result.requested, result.requested, null, null, "completed")),
      JSON.stringify(result),
    ],
  );
}

async function failBulkReviewJob(db: CatalogRuntimeDeps["db"], jobId: string, message: string): Promise<void> {
  const current = await getBulkReviewJob(db, jobId);
  const progress = {
    ...(current?.progress ?? bulkProgress(0, 0)),
    phase: "failed" as const,
  };
  await db.query(
    `UPDATE catalog_source_observation_bulk_jobs
     SET
       status = 'failed',
       progress = $2::jsonb,
       error_message = $3,
       claim_owner_id = NULL,
       claim_expires_at = NULL,
       completed_at = now(),
       updated_at = now()
     WHERE job_id = $1`,
    [jobId, JSON.stringify(progress), message],
  );
}

function mapBulkReviewJobRow(row: SourceObservationBulkJobRow): SourceObservationBulkJob {
  return {
    jobId: row.job_id,
    action: row.action,
    selectionMode: row.selection_mode,
    observationIds: parseJsonField<string[]>(row.observation_ids, "observation_ids"),
    scope: normalizeBulkJobScope(parseJsonField<SourceObservationFilterScope>(row.scope, "scope")),
    reason: row.reason,
    status: row.status,
    progress: parseJsonField<BulkSourceObservationProgress>(row.progress, "progress"),
    result: row.result ? parseJsonField<BulkSourceObservationPromotionResult>(row.result, "result") : null,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

async function getIntegrationJob(
  db: CatalogRuntimeDeps["db"],
  jobId: string,
): Promise<SourceObservationIntegrationJob | null> {
  const result = await db.query<SourceObservationIntegrationJobRow>(
    `SELECT
       job_id,
       action,
       scope,
       event_context,
       status,
       progress,
       result,
       error_message,
       created_at::text,
       started_at::text,
       completed_at::text,
       updated_at::text
     FROM catalog_source_observation_integration_jobs
     WHERE job_id = $1`,
    [jobId],
  );

  return result.rows[0] ? mapIntegrationJobRow(result.rows[0]) : null;
}

async function listActiveIntegrationJobs(
  db: CatalogRuntimeDeps["db"],
  context: EventStoreContext,
): Promise<readonly SourceObservationIntegrationJob[]> {
  const result = await db.query<SourceObservationIntegrationJobRow>(
    `SELECT
       job_id,
       action,
       scope,
       event_context,
       status,
       progress,
       result,
       error_message,
       created_at::text,
       started_at::text,
       completed_at::text,
       updated_at::text
     FROM catalog_source_observation_integration_jobs
     WHERE status IN ('queued', 'running')
       AND event_context ->> 'tenantId' = $1
       AND event_context #>> '{audit,performedByUserId}' = $2
     ORDER BY created_at ASC`,
    [context.tenantId, context.audit.performedByUserId],
  );

  return result.rows.map(mapIntegrationJobRow);
}

async function claimNextIntegrationJob(
  db: CatalogRuntimeDeps["db"],
  input: { claimOwnerId: string; claimTtlMs: number },
): Promise<ClaimedSourceObservationIntegrationJob | null> {
  const result = await db.query<SourceObservationIntegrationJobRow>(
    `WITH next_job AS (
       SELECT job_id
       FROM catalog_source_observation_integration_jobs
       WHERE status = 'queued'
          OR (status = 'running' AND claim_expires_at < now())
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE catalog_source_observation_integration_jobs AS job
     SET
       status = 'running',
       claim_owner_id = $1,
       claim_expires_at = now() + ($2::integer * interval '1 millisecond'),
       started_at = coalesce(job.started_at, now()),
       updated_at = now()
     FROM next_job
     WHERE job.job_id = next_job.job_id
     RETURNING
       job.job_id,
       job.action,
       job.scope,
       job.event_context,
       job.status,
       job.progress,
       job.result,
       job.error_message,
       job.created_at::text,
       job.started_at::text,
       job.completed_at::text,
       job.updated_at::text`,
    [input.claimOwnerId, Math.max(1_000, Math.floor(input.claimTtlMs))],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    ...mapIntegrationJobRow(row),
    eventContext: parseJsonField<EventStoreContext>(row.event_context, "event_context"),
  };
}

async function updateIntegrationJobProgress(
  db: CatalogRuntimeDeps["db"],
  jobId: string,
  progress: BulkSourceObservationProgress,
  claimTtlMs: number,
): Promise<void> {
  await db.query(
    `UPDATE catalog_source_observation_integration_jobs
     SET
       progress = $2::jsonb,
       claim_expires_at = now() + ($3::integer * interval '1 millisecond'),
       updated_at = now()
     WHERE job_id = $1
       AND status = 'running'`,
    [jobId, JSON.stringify(progress), Math.max(1_000, Math.floor(claimTtlMs))],
  );
}

async function completeIntegrationJob(
  db: CatalogRuntimeDeps["db"],
  jobId: string,
  result: SourceObservationIntegrationJobResult,
): Promise<void> {
  await db.query(
    `UPDATE catalog_source_observation_integration_jobs
     SET
       status = 'completed',
       progress = $2::jsonb,
       result = $3::jsonb,
       error_message = NULL,
       claim_owner_id = NULL,
       claim_expires_at = NULL,
       completed_at = now(),
       updated_at = now()
     WHERE job_id = $1`,
    [
      jobId,
      JSON.stringify(bulkProgress(result.requested, result.requested, null, null, "completed")),
      JSON.stringify(result),
    ],
  );
}

async function failIntegrationJob(db: CatalogRuntimeDeps["db"], jobId: string, message: string): Promise<void> {
  const current = await getIntegrationJob(db, jobId);
  const progress = {
    ...(current?.progress ?? bulkProgress(0, 0)),
    phase: "failed" as const,
  };
  await db.query(
    `UPDATE catalog_source_observation_integration_jobs
     SET
       status = 'failed',
       progress = $2::jsonb,
       error_message = $3,
       claim_owner_id = NULL,
       claim_expires_at = NULL,
       completed_at = now(),
       updated_at = now()
     WHERE job_id = $1`,
    [jobId, JSON.stringify(progress), message],
  );
}

function mapIntegrationJobRow(row: SourceObservationIntegrationJobRow): SourceObservationIntegrationJob {
  return {
    jobId: row.job_id,
    action: row.action,
    scope: normalizeIntegrationJobScope(parseJsonField<SourceObservationIntegrationJobScope>(row.scope, "scope")),
    status: row.status,
    progress: parseJsonField<BulkSourceObservationProgress>(row.progress, "progress"),
    result: row.result ? parseJsonField<SourceObservationIntegrationJobResult>(row.result, "result") : null,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonField<T>(value: unknown, fieldName: string): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }

  if (value && typeof value === "object") {
    return value as T;
  }

  throw new Error(`Bulk review job ${fieldName} is not valid JSON.`);
}

function normalizeBulkJobScope(scope: SourceObservationFilterScope): SourceObservationFilterScope {
  return {
    search: scope.search?.trim() || undefined,
    status: scope.status?.trim() || undefined,
    provider: scope.provider?.trim() || undefined,
    language: scope.language?.trim() || undefined,
    setId: scope.setId?.trim() || undefined,
  };
}

function normalizeIntegrationJobScope(
  scope: SourceObservationIntegrationJobScope,
): SourceObservationIntegrationJobScope {
  return {
    provider: scope.provider?.trim() || undefined,
    language: scope.language?.trim() || undefined,
    seriesId: scope.seriesId?.trim() || undefined,
    setId: scope.setId?.trim() || undefined,
  };
}

function integrationScopeToObservationScope(scope: SourceObservationIntegrationJobScope): SourceObservationFilterScope {
  return {
    provider: scope.provider?.trim() || undefined,
    language: scope.language?.trim() || undefined,
    setId: scope.setId?.trim() || undefined,
  };
}

function uniqueObservationIds(observationIds: readonly string[]): string[] {
  return Array.from(
    new Set(
      observationIds.map((observationId) => observationId.trim()).filter((observationId) => observationId.length > 0),
    ),
  );
}

function summarizePromotionOutcomes(
  requested: number,
  outcomes: readonly BulkSourceObservationPromotionOutcome[],
): BulkSourceObservationPromotionResult {
  return {
    requested,
    promoted: outcomes.filter((outcome) => outcome.status === "promoted").length,
    rejected: outcomes.filter((outcome) => outcome.status === "rejected").length,
    skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    outcomes,
  };
}

function summarizeReapplyOutcomes(
  requested: number,
  outcomes: readonly BulkSourceObservationReapplyOutcome[],
): BulkSourceObservationReapplyResult {
  return {
    requested,
    reapplied: outcomes.filter((outcome) => outcome.status === "reapplied").length,
    skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    outcomes,
  };
}

function summarizeIntegrationJobOutcomes(
  requested: number,
  outcomes: readonly SourceObservationIntegrationJobOutcome[],
): SourceObservationIntegrationJobResult {
  return {
    requested,
    imported: outcomes.filter((outcome) => outcome.status === "imported").length,
    observed: outcomes.reduce((total, outcome) => total + outcome.observed, 0),
    reapplied: outcomes.reduce((total, outcome) => total + outcome.reapplied, 0),
    skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    outcomes,
  };
}

function bulkProgress(
  completed: number,
  total: number,
  currentName: string | null = null,
  status: BulkSourceObservationProgress["status"] = null,
  phase: BulkSourceObservationProgress["phase"] = "processing",
): BulkSourceObservationProgress {
  return {
    phase,
    completed,
    total,
    currentName,
    status,
  };
}
