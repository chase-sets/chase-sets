import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import {
  decideCatalogMergeCandidate,
  evolveCatalogMergeCandidate,
  initialCatalogMergeCandidateState,
  type CatalogMergeCandidateCommand,
  type CatalogMergeCandidateEvent,
  type CatalogMergeCandidateReviewSnapshot,
} from "../domain/catalog-merge-candidate";
import {
  listSourceObservationsForCandidateMatching,
  type SourceObservationFilterScope,
  type SourceObservationListRow,
} from "../read-model/queries";
import {
  buildCatalogMergeCandidatesFromObservations,
  type CatalogMergeCandidateMatchBatch,
} from "./promotion/catalog-merge-candidate-matcher";
import { listAcceptedProviderScopeMappingsForProviders } from "../../provider-scope-mapping/read-model/queries";
import { planCatalogMergeCandidatePromotionCommands } from "./promotion/catalog-merge-candidate-promotion-planner";
import { unitKeyForCatalogProviderProfileVersion } from "./governance/catalog-integration-impact-analysis";
import { catalogProviderProfileVersionLookupKey } from "./source-observation-runtime-contracts";
import type {
  CatalogProviderIntegrationProfileVersionReader,
  SourceObservationRecordInput,
  CatalogMergeCandidateGenerationResult,
  CatalogMergeCandidateActionResult,
  CatalogMergeCandidateServices,
} from "./source-observation-runtime-contracts";
import { normalizeOptionalKey, normalizeCandidateGenerationScope } from "./source-observation-job-serialization";
import { catalogMergeCandidateReviewActor, catalogMergeCandidateStreamId } from "./source-observation-stream-identity";

export type SourceObservationMergeCandidateRuntimeDeps = Readonly<{
  deps: CatalogRuntimeDeps;
  profileVersions: CatalogProviderIntegrationProfileVersionReader;
}>;

/**
 * Catalog Merge Candidate facet: generation from observations plus the review
 * commands (promote/split/update/ignore/defer) over the merge-candidate
 * aggregate. Owns its own aggregate command handler because no other facet
 * writes that stream; the import facet reuses the exported generation helpers.
 */
export function createSourceObservationMergeCandidateRuntime({
  deps,
  profileVersions,
}: SourceObservationMergeCandidateRuntimeDeps) {
  const { commandHandler: catalogMergeCandidateCommandHandler, repository: catalogMergeCandidateRepository } =
    createAggregateCommandHandler({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<CatalogMergeCandidateEvent>(),
      initialState: () => initialCatalogMergeCandidateState,
      evolve: evolveCatalogMergeCandidate,
      decide: decideCatalogMergeCandidate,
    });

  async function generateCatalogMergeCandidates(input: {
    syncRunId?: string | null;
    scope?: SourceObservationFilterScope;
    context: EventStoreContext;
  }): Promise<CatalogMergeCandidateGenerationResult> {
    const syncRunId = normalizeOptionalKey(input.syncRunId);
    const scope = normalizeCandidateGenerationScope(input.scope ?? {}, syncRunId);
    const observations = await listSourceObservationsForCandidateMatching(deps.db, scope);
    const generated = await persistCatalogMergeCandidatesFromObservations(observations, input.context);

    return {
      syncRunId,
      scope,
      observationCount: observations.length,
      matchedObservationCount: observations.length - generated.exclusions.length,
      excludedObservationCount: generated.exclusions.length,
      candidateCount: generated.candidates.length,
      candidates: generated.candidates,
      exclusions: generated.exclusions,
    };
  }

  async function persistCatalogMergeCandidatesFromObservations(
    observations: readonly SourceObservationListRow[],
    context: EventStoreContext,
  ): Promise<CatalogMergeCandidateMatchBatch> {
    const addedAt = new Date().toISOString();
    const providerKeys = [
      ...new Set(observations.map((observation) => observation.provider_key.trim().toLowerCase())),
    ].sort();
    const providerProfileVersions = (
      await Promise.all(providerKeys.map((providerKey) => profileVersions.listProfileVersions(providerKey)))
    ).flat();
    const unitKeyByProfileVersion = new Map(
      providerProfileVersions.map((version) => [
        catalogProviderProfileVersionLookupKey(version.providerKey, version.profileKey, version.profileVersion),
        unitKeyForCatalogProviderProfileVersion(version),
      ]),
    );
    const providerUnitKeyByObservationId = Object.fromEntries(
      observations.flatMap((observation) => {
        const unitKey = unitKeyByProfileVersion.get(
          catalogProviderProfileVersionLookupKey(
            observation.provider_key,
            observation.source_profile_key,
            observation.source_profile_version,
          ),
        );
        return unitKey ? [[observation.observation_id, unitKey]] : [];
      }),
    );
    const acceptedScopeMappings = await listAcceptedProviderScopeMappingsForProviders(deps.db, providerKeys);
    const generated = buildCatalogMergeCandidatesFromObservations(observations, {
      addedAt,
      acceptedScopeMappings,
      providerUnitKeyByObservationId,
    });

    for (const candidate of generated.candidates) {
      const streamId = catalogMergeCandidateStreamId(candidate.candidateId);
      // event-stream-read: bounded-prefix -- limit 1. Only the create-versus-refresh
      // branch depends on this, and any single event proves the candidate exists;
      // the command itself replays the aggregate through its repository.
      const existingEvents = await deps.eventStore.readStream({ streamId, limit: 1 });
      const now = new Date().toISOString();
      await catalogMergeCandidateCommandHandler({
        streamId,
        command:
          existingEvents.length > 0
            ? {
                type: "RefreshCatalogMergeCandidate",
                snapshot: candidate.snapshot,
                refreshedAt: now,
              }
            : {
                type: "CreateCatalogMergeCandidate",
                candidateId: candidate.candidateId,
                snapshot: candidate.snapshot,
                createdAt: now,
              },
        context,
      });
    }

    return generated;
  }

  function sourceObservationRecordToCandidateRow(observation: SourceObservationRecordInput): SourceObservationListRow {
    return {
      observation_id: observation.observationId,
      sync_run_id: observation.syncRunId?.trim() || null,
      provider_key: observation.providerKey,
      external_key: observation.externalKey,
      source_url: observation.sourceUrl,
      language_code: observation.languageCode,
      source_record_hash: observation.sourceRecordHash,
      source_updated_at: observation.sourceUpdatedAt ?? null,
      observed_at: observation.observedAt,
      source_profile_key: observation.sourceProfileKey,
      source_profile_version: observation.sourceProfileVersion,
      source_mapping_fingerprint: observation.sourceMappingFingerprint,
      normalized: observation.normalized,
      status: "observed",
      status_reason: null,
      promoted_catalog_item_id: null,
      promoted_reference_record_id: null,
      promoted_at: null,
      promotion_profile_key: null,
      promotion_profile_version: null,
      promotion_plan_fingerprint: null,
      updated_at: observation.observedAt,
    };
  }

  async function dispatchCatalogMergeCandidateCommand(input: {
    candidateId: string;
    action: CatalogMergeCandidateActionResult["action"];
    command: CatalogMergeCandidateCommand;
    context: EventStoreContext;
  }): Promise<CatalogMergeCandidateActionResult> {
    const result = await catalogMergeCandidateCommandHandler({
      streamId: catalogMergeCandidateStreamId(input.candidateId),
      command: input.command,
      context: input.context,
    });

    return {
      candidateId: input.candidateId,
      action: input.action,
      version: result.version,
      status: result.state.status,
      statusReason: result.state.statusReason,
      snapshot: result.state.snapshot,
    };
  }

  async function createSplitCatalogMergeCandidate(input: {
    candidateId: string;
    snapshot: CatalogMergeCandidateReviewSnapshot;
    createdAt: string;
    context: EventStoreContext;
  }): Promise<NonNullable<CatalogMergeCandidateActionResult["splitCandidate"]>> {
    const result = await catalogMergeCandidateCommandHandler({
      streamId: catalogMergeCandidateStreamId(input.candidateId),
      command: {
        type: "CreateCatalogMergeCandidate",
        candidateId: input.candidateId,
        snapshot: input.snapshot,
        createdAt: input.createdAt,
      },
      context: input.context,
    });

    return {
      candidateId: input.candidateId,
      version: result.version,
      status: result.state.status,
      statusReason: result.state.statusReason,
      snapshot: result.state.snapshot,
    };
  }

  const services: CatalogMergeCandidateServices = {
    generateCatalogMergeCandidates,
    promoteCatalogMergeCandidate: (input) =>
      dispatchCatalogMergeCandidateCommand({
        candidateId: input.candidateId,
        action: "promote",
        command: {
          type: "PromoteCatalogMergeCandidate",
          reason: input.reason,
          actor: catalogMergeCandidateReviewActor(input.context),
          promotedAt: new Date().toISOString(),
          conflictResolutions: input.conflictResolutions,
        },
        context: input.context,
      }),
    splitCatalogMergeCandidate: async (input) => {
      const splitAt = new Date().toISOString();
      const splitCommand: CatalogMergeCandidateCommand = {
        type: "SplitCatalogMergeCandidate",
        remainingSnapshot: input.remainingSnapshot,
        splitCandidateId: input.splitCandidateId,
        splitSnapshot: input.splitSnapshot,
        reason: input.reason,
        actor: catalogMergeCandidateReviewActor(input.context),
        splitAt,
        conflictResolutions: input.conflictResolutions,
      };
      const originalCandidate = await catalogMergeCandidateRepository.load(
        catalogMergeCandidateStreamId(input.candidateId),
      );
      decideCatalogMergeCandidate(originalCandidate.state, splitCommand);
      // event-stream-read: bounded-prefix -- limit 1. This rejects a split whose
      // target candidate already exists; one event proves existence, and a longer
      // history could only make the same rejection more certain.
      const existingSplitEvents = await deps.eventStore.readStream({
        streamId: catalogMergeCandidateStreamId(input.splitCandidateId),
        limit: 1,
      });
      if (existingSplitEvents.length > 0) {
        throw new Error("Split Catalog Merge Candidate already exists.");
      }

      const splitCandidate = await createSplitCatalogMergeCandidate({
        candidateId: input.splitCandidateId,
        snapshot: input.splitSnapshot,
        createdAt: splitAt,
        context: input.context,
      });
      const original = await dispatchCatalogMergeCandidateCommand({
        candidateId: input.candidateId,
        action: "split",
        command: splitCommand,
        context: input.context,
      });

      return {
        ...original,
        splitCandidate,
      };
    },
    updateCatalogMergeCandidate: (input) =>
      dispatchCatalogMergeCandidateCommand({
        candidateId: input.candidateId,
        action: "update",
        command: {
          type: "UpdateCatalogMergeCandidate",
          snapshot: input.snapshot,
          reason: input.reason,
          actor: catalogMergeCandidateReviewActor(input.context),
          updatedAt: new Date().toISOString(),
          conflictResolutions: input.conflictResolutions,
        },
        context: input.context,
      }),
    ignoreCatalogMergeCandidate: (input) =>
      dispatchCatalogMergeCandidateCommand({
        candidateId: input.candidateId,
        action: "ignore",
        command: {
          type: "IgnoreCatalogMergeCandidate",
          reason: input.reason,
          actor: catalogMergeCandidateReviewActor(input.context),
          ignoredAt: new Date().toISOString(),
          conflictResolutions: input.conflictResolutions,
        },
        context: input.context,
      }),
    deferCatalogMergeCandidate: (input) =>
      dispatchCatalogMergeCandidateCommand({
        candidateId: input.candidateId,
        action: "defer",
        command: {
          type: "DeferCatalogMergeCandidate",
          reason: input.reason,
          actor: catalogMergeCandidateReviewActor(input.context),
          deferredAt: new Date().toISOString(),
          conflictResolutions: input.conflictResolutions,
        },
        context: input.context,
      }),
    previewCatalogMergeCandidatePromotionPlan: (input) => planCatalogMergeCandidatePromotionCommands(input),
  };

  return {
    services,
    persistCatalogMergeCandidatesFromObservations,
    sourceObservationRecordToCandidateRow,
  };
}

export type SourceObservationMergeCandidateRuntime = ReturnType<typeof createSourceObservationMergeCandidateRuntime>;
