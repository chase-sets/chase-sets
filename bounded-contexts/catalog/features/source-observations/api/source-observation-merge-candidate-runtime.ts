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
  type CatalogMergeCandidateState,
} from "../domain/catalog-merge-candidate";
import {
  listSourceObservationsForCandidateMatching,
  listSourceObservationsByIds,
  listCatalogMergeCandidateIdsForScopeRecords,
  CATALOG_MERGE_CANDIDATE_MATCHING_STATUSES,
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
    const incomingScopeIds = new Set(
      generated.candidates.map((candidate) => candidate.snapshot.identity.scopeRecordId),
    );
    if (incomingScopeIds.size === 0) {
      return generated;
    }
    const discoveredCandidateIds = await listCatalogMergeCandidateIdsForScopeRecords(deps.db, [...incomingScopeIds]);
    const generatedCandidateIds = generated.candidates.map((candidate) => candidate.candidateId);
    const loaded = new Map<string, Awaited<ReturnType<typeof catalogMergeCandidateRepository.load>>>();
    for (const candidateId of [...new Set([...discoveredCandidateIds, ...generatedCandidateIds])].sort()) {
      // Loads are deliberately sequential: candidate discovery is bounded to
      // the touched scopes and never creates an unbounded Promise.all fan-out.
      loaded.set(candidateId, await catalogMergeCandidateRepository.load(catalogMergeCandidateStreamId(candidateId)));
    }

    let completeGenerated: CatalogMergeCandidateMatchBatch = generated;
    let existing: Array<Awaited<ReturnType<typeof catalogMergeCandidateRepository.load>>> = [];
    for (;;) {
      existing = [...loaded.values()].filter(
        ({ state }) =>
          state.snapshot !== null &&
          incomingScopeIds.has(state.snapshot.identity.scopeRecordId) &&
          state.status !== "promoted" &&
          state.status !== "rejected",
      );
      const existingMembers = existing.flatMap(({ state }) =>
        (state.snapshot?.membership ?? []).map((member) => member.observationId),
      );
      const priorRows = await listSourceObservationsByIds(deps.db, existingMembers);
      const priorIds = new Set(priorRows.map((row) => row.observation_id));
      const requestedIds = new Set(existingMembers);
      if (
        priorRows.length !== requestedIds.size ||
        priorIds.size !== requestedIds.size ||
        [...requestedIds].some((id) => !priorIds.has(id))
      ) {
        throw new Error(
          "Catalog Merge Candidate refresh could not prove every existing member row; import failed closed.",
        );
      }

      const eligiblePriorRows = priorRows.filter((row) =>
        (CATALOG_MERGE_CANDIDATE_MATCHING_STATUSES as readonly string[]).includes(row.status),
      );
      const allRows = new Map(eligiblePriorRows.map((row) => [row.observation_id, row]));
      for (const observation of observations) {
        allRows.set(observation.observation_id, observation);
      }
      const allProviderKeys = [
        ...new Set([...allRows.values()].map((row) => row.provider_key.trim().toLowerCase())),
      ].sort();
      const allAcceptedScopeMappings = await listAcceptedProviderScopeMappingsForProviders(deps.db, allProviderKeys);
      const allProviderVersions = (
        await Promise.all(allProviderKeys.map((providerKey) => profileVersions.listProfileVersions(providerKey)))
      ).flat();
      const allUnitKeys = new Map(
        allProviderVersions.map((version) => [
          catalogProviderProfileVersionLookupKey(version.providerKey, version.profileKey, version.profileVersion),
          unitKeyForCatalogProviderProfileVersion(version),
        ]),
      );
      const allUnitByObservationId = Object.fromEntries(
        [...allRows.values()].flatMap((observation) => {
          const unitKey = allUnitKeys.get(
            catalogProviderProfileVersionLookupKey(
              observation.provider_key,
              observation.source_profile_key,
              observation.source_profile_version,
            ),
          );
          return unitKey ? [[observation.observation_id, unitKey]] : [];
        }),
      );
      completeGenerated = buildCatalogMergeCandidatesFromObservations([...allRows.values()], {
        addedAt,
        acceptedScopeMappings: allAcceptedScopeMappings,
        providerUnitKeyByObservationId: allUnitByObservationId,
      });

      if (
        completeGenerated.candidates.some(
          (candidate) => !incomingScopeIds.has(candidate.snapshot.identity.scopeRecordId),
        )
      ) {
        throw new Error("Catalog Merge Candidate refresh crossed outside the touched scopes; import failed closed.");
      }
      const candidateIdsToLoad = completeGenerated.candidates
        .map((candidate) => candidate.candidateId)
        .filter((candidateId) => !loaded.has(candidateId));
      if (candidateIdsToLoad.length === 0) {
        break;
      }
      for (const candidateId of candidateIdsToLoad.sort()) {
        loaded.set(candidateId, await catalogMergeCandidateRepository.load(catalogMergeCandidateStreamId(candidateId)));
      }
    }

    const completeIds = new Set(completeGenerated.candidates.map((candidate) => candidate.candidateId));
    for (const { state } of existing) {
      if (state.id !== null && !completeIds.has(state.id)) {
        throw new Error(
          "Catalog Merge Candidate refresh would leave an existing candidate stale after re-keying; import failed closed.",
        );
      }
    }
    const memberOwners = new Map<string, string>();
    const reconciledAndUntouched = [
      ...completeGenerated.candidates,
      ...[...loaded.entries()].flatMap(([candidateId, { state }]) =>
        !completeIds.has(candidateId) && state.snapshot ? [{ candidateId, snapshot: state.snapshot }] : [],
      ),
    ];
    for (const candidate of reconciledAndUntouched) {
      for (const member of candidate.snapshot.membership) {
        const owner = memberOwners.get(member.observationId);
        if (owner !== undefined && owner !== candidate.candidateId) {
          throw new Error(
            "Catalog Merge Candidate refresh would place an observation in multiple candidates; import failed closed.",
          );
        }
        memberOwners.set(member.observationId, candidate.candidateId);
      }
    }

    for (const candidate of completeGenerated.candidates) {
      const streamId = catalogMergeCandidateStreamId(candidate.candidateId);
      const loadedCandidate = loaded.get(candidate.candidateId);
      if (!loadedCandidate) {
        throw new Error(
          "Catalog Merge Candidate refresh could not load its authoritative stream; import failed closed.",
        );
      }
      // Keep the bounded existence probe as a consistency check for the
      // authoritative load. It must never decide whether an append is a
      // create or refresh; the loaded aggregate state and version do that.
      // @stream-read-contract bounded-contexts/catalog/features/source-observations/api/source-observation-merge-candidate-runtime.test.ts
      const existingEvents = await deps.eventStore.readStream({ streamId, limit: 1 });
      if (existingEvents.length > 0 !== (loadedCandidate.state.id !== null)) {
        throw new Error("Catalog Merge Candidate stream changed during reconciliation; import failed closed.");
      }
      const now = new Date().toISOString();
      await catalogMergeCandidateCommandHandler({
        streamId,
        command:
          loadedCandidate.state.id !== null
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
        expectedVersion: loadedCandidate.state.id === null ? "no_stream" : loadedCandidate.version,
        context,
      });
    }

    return completeGenerated;
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

  // Scope bulk review jobs re-check one candidate's aggregate state, then apply
  // the review command only at the version they checked: a candidate that
  // changes in between fails the append instead of being acted on stale.
  async function loadCatalogMergeCandidateForReview(
    candidateId: string,
  ): Promise<Readonly<{ state: CatalogMergeCandidateState; version: number }>> {
    const loaded = await catalogMergeCandidateRepository.load(catalogMergeCandidateStreamId(candidateId));
    return { state: loaded.state, version: loaded.version };
  }

  async function applyCatalogMergeCandidateReviewAtVersion(input: {
    candidateId: string;
    command: CatalogMergeCandidateCommand;
    expectedVersion: number;
    context: EventStoreContext;
  }): Promise<CatalogMergeCandidateState> {
    const result = await catalogMergeCandidateCommandHandler({
      streamId: catalogMergeCandidateStreamId(input.candidateId),
      command: input.command,
      expectedVersion: input.expectedVersion,
      context: input.context,
    });
    return result.state;
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
      // @stream-read-contract bounded-contexts/catalog/features/source-observations/api/source-observation-merge-candidate-runtime.test.ts
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
    // Read-only validated planning: awaits the display identity resolver over
    // the shared db before exposing commands; executes nothing.
    previewCatalogMergeCandidatePromotionPlan: (input) =>
      planCatalogMergeCandidatePromotionCommands({ ...input, db: deps.db }),
  };

  return {
    services,
    persistCatalogMergeCandidatesFromObservations,
    sourceObservationRecordToCandidateRow,
    loadCatalogMergeCandidateForReview,
    applyCatalogMergeCandidateReviewAtVersion,
  };
}

export type SourceObservationMergeCandidateRuntime = ReturnType<typeof createSourceObservationMergeCandidateRuntime>;
