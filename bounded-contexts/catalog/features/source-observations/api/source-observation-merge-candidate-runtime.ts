import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { applyEvents } from "@chase-sets/event-core/domain";
import { createEventStoreError } from "@chase-sets/event-core/event-store";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import {
  catalogMergeCandidateEditableFactKeys,
  decideCatalogMergeCandidate,
  evolveCatalogMergeCandidate,
  initialCatalogMergeCandidateState,
  type CatalogMergeCandidateCommand,
  type CatalogMergeCandidateEvent,
  type CatalogMergeCandidateFieldProvenance,
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
import { CatalogMergeCandidateReviewCommandError } from "./source-observation-runtime-contracts";
import type {
  CatalogMergeCandidateEditInput,
  CatalogMergeCandidateEditRequest,
} from "./promotion/catalog-merge-candidate-edit";
import {
  planCatalogMergeCandidateSplit,
  type CatalogMergeCandidateSplitBlocker,
} from "./promotion/catalog-merge-candidate-review-command-payloads";

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
  const codec = createPassthroughDomainEventCodec<CatalogMergeCandidateEvent>();
  const { commandHandler: catalogMergeCandidateCommandHandler, repository: catalogMergeCandidateRepository } =
    createAggregateCommandHandler({
      eventStore: deps.eventStore,
      codec,
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
    return actionResult(input.candidateId, input.action, result);
  }

  // The candidate as the operator read it: a candidate that has moved on since (a sync refreshed
  // it, an observation joined, another review acted) is refused as stale.
  async function loadCatalogMergeCandidateAtVersion(
    candidateId: string,
    expectedVersion: number,
  ): Promise<LoadedCatalogMergeCandidate & Readonly<{ snapshot: CatalogMergeCandidateReviewSnapshot }>> {
    const loaded = await catalogMergeCandidateRepository.load(catalogMergeCandidateStreamId(candidateId));
    if (loaded.state.snapshot === null) {
      throw new Error("Catalog Merge Candidate must be created first.");
    }
    if (loaded.version !== expectedVersion) {
      throw staleCandidateError();
    }
    return { state: loaded.state, version: loaded.version, snapshot: loaded.state.snapshot };
  }

  // Appends each candidate's decided events only at the version its state was read at, every
  // candidate in one transaction. The events were decided on that state, so a write in between,
  // before the decision or before the append, refuses the whole commit with a concurrency conflict
  // and nothing is saved.
  async function commitAtReadVersions(
    commits: readonly Readonly<{
      candidateId: string;
      read: LoadedCatalogMergeCandidate;
      events: readonly CatalogMergeCandidateEvent[];
    }>[],
    context: EventStoreContext,
  ): Promise<readonly LoadedCatalogMergeCandidate[]> {
    const inputs = commits.map(({ candidateId, read, events }) => ({
      streamId: catalogMergeCandidateStreamId(candidateId),
      expectedVersion: read.version === 0 ? ("no_stream" as const) : read.version,
      context,
      events: events.map(codec.encode),
    }));
    let stored: readonly (readonly StoredEvent[])[];
    if (inputs.length === 1) {
      stored = [await deps.eventStore.appendToStream(inputs[0]!)];
    } else {
      if (!deps.eventStore.appendToStreams) {
        throw new Error("Catalog Merge Candidate split requires atomic multi-stream appends.");
      }
      stored = (await deps.eventStore.appendToStreams(inputs)).map((result) => result.storedEvents);
    }
    recordCommittedEvents(stored.flat());
    return commits.map(({ read, events }, index) => ({
      state: applyEvents(read.state, evolveCatalogMergeCandidate, events),
      version: stored[index]!.at(-1)?.streamVersion ?? read.version,
    }));
  }

  // Scope bulk review jobs re-check one candidate's aggregate state, then apply
  // the review command only at the version they checked: a candidate that
  // changes in between fails with a concurrency conflict instead of being acted on stale.
  async function loadCatalogMergeCandidateForReview(candidateId: string): Promise<LoadedCatalogMergeCandidate> {
    const loaded = await catalogMergeCandidateRepository.load(catalogMergeCandidateStreamId(candidateId));
    return { state: loaded.state, version: loaded.version };
  }

  async function applyCatalogMergeCandidateReviewAtVersion(input: {
    candidateId: string;
    command: CatalogMergeCandidateCommand;
    expectedVersion: number;
    context: EventStoreContext;
  }): Promise<CatalogMergeCandidateState> {
    const streamId = catalogMergeCandidateStreamId(input.candidateId);
    const loaded = await catalogMergeCandidateRepository.load(streamId);
    if (loaded.version !== input.expectedVersion) {
      throw createEventStoreError("concurrency_conflict", "Catalog Merge Candidate changed after it was read.", {
        streamId,
        expectedVersion: input.expectedVersion,
        actualVersion: loaded.version,
      });
    }
    const read = { state: loaded.state, version: loaded.version };
    const [applied] = await commitAtReadVersions(
      [{ candidateId: input.candidateId, read, events: decideCatalogMergeCandidate(read.state, input.command) }],
      input.context,
    );
    return applied!.state;
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
      const original = await loadCatalogMergeCandidateAtVersion(input.candidateId, input.expectedVersion);
      const planned = planCatalogMergeCandidateSplit(input.candidateId, original.snapshot, input.splitObservationIds);
      if (!planned.ok) {
        throw splitRefusal(planned.blocker);
      }
      const { remainingSnapshot, splitCandidateId, splitSnapshot } = planned.plan;
      const splitEvents = decideCatalogMergeCandidate(original.state, {
        type: "SplitCatalogMergeCandidate",
        remainingSnapshot,
        splitCandidateId,
        splitSnapshot,
        reason: input.reason,
        actor: catalogMergeCandidateReviewActor(input.context),
        splitAt,
        conflictResolutions: input.conflictResolutions,
      });
      // @stream-read-contract bounded-contexts/catalog/features/source-observations/api/source-observation-merge-candidate-runtime.test.ts
      const existingSplitEvents = await deps.eventStore.readStream({
        streamId: catalogMergeCandidateStreamId(splitCandidateId),
        limit: 1,
      });
      if (existingSplitEvents.length > 0) {
        // A split that read the candidate before another split committed finds that split's
        // candidate: the candidate has moved on, so this read is stale. Only at the version read
        // does an existing split candidate refuse the split.
        await loadCatalogMergeCandidateAtVersion(input.candidateId, input.expectedVersion);
        throw new Error("Split Catalog Merge Candidate already exists.");
      }
      const unsplit = { state: initialCatalogMergeCandidateState, version: 0 };
      const createEvents = decideCatalogMergeCandidate(unsplit.state, {
        type: "CreateCatalogMergeCandidate",
        candidateId: splitCandidateId,
        snapshot: splitSnapshot,
        createdAt: splitAt,
      });

      // The split and the split candidate it creates commit together, at the version the operator
      // read, or neither does.
      const [split, created] = await commitAtReadVersions(
        [
          { candidateId: input.candidateId, read: original, events: splitEvents },
          { candidateId: splitCandidateId, read: unsplit, events: createEvents },
        ],
        input.context,
      ).catch(staleOnConcurrencyConflict);
      const { action: _action, ...splitCandidate } = actionResult(splitCandidateId, "split", created!);

      return { ...actionResult(input.candidateId, "split", split!), splitCandidate };
    },
    updateCatalogMergeCandidate: async (input) => {
      const read = await loadCatalogMergeCandidateAtVersion(input.candidateId, input.expectedVersion);
      const events = decideCatalogMergeCandidate(read.state, {
        type: "UpdateCatalogMergeCandidate",
        snapshot: editedCatalogMergeCandidateSnapshot(read.snapshot, input.edit),
        reason: input.reason,
        actor: catalogMergeCandidateReviewActor(input.context),
        updatedAt: new Date().toISOString(),
        conflictResolutions: input.conflictResolutions,
      });
      const [updated] = await commitAtReadVersions(
        [{ candidateId: input.candidateId, read, events }],
        input.context,
      ).catch(staleOnConcurrencyConflict);

      return actionResult(input.candidateId, "update", updated!);
    },
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

type LoadedCatalogMergeCandidate = Readonly<{ state: CatalogMergeCandidateState; version: number }>;

function actionResult(
  candidateId: string,
  action: CatalogMergeCandidateActionResult["action"],
  result: LoadedCatalogMergeCandidate,
): CatalogMergeCandidateActionResult {
  return {
    candidateId,
    action,
    version: result.version,
    status: result.state.status,
    statusReason: result.state.statusReason,
    snapshot: result.state.snapshot,
  };
}

// An update or split names the version the operator read: losing the race to another write is a
// stale read, which the page can say so for.
function staleOnConcurrencyConflict(error: unknown): never {
  throw isConcurrencyConflict(error) ? staleCandidateError() : error;
}

// The candidate's stored snapshot with the operator's edit applied. A field the edit leaves out
// keeps its stored value, and only the candidate's text facts can be corrected.
function editedCatalogMergeCandidateSnapshot(
  stored: CatalogMergeCandidateReviewSnapshot,
  request: CatalogMergeCandidateEditRequest,
): CatalogMergeCandidateReviewSnapshot {
  const edit: CatalogMergeCandidateEditInput = {
    promotionIntent: request.promotionIntent ?? stored.promotionIntent,
    catalogItemId: request.catalogItemId === undefined ? stored.matches.catalogItemId : request.catalogItemId,
    productIds: request.productIds ?? stored.matches.productIds,
    factOverrides: request.factOverrides ?? [],
    droppedExternalCatalogItemReferenceIndexes: request.droppedExternalCatalogItemReferenceIndexes ?? [],
    droppedExternalProductReferenceIndexes: request.droppedExternalProductReferenceIndexes ?? [],
  };
  const editable = new Set(catalogMergeCandidateEditableFactKeys(stored.proposedCatalogItemFacts));
  if (edit.factOverrides.some((override) => !editable.has(override.key.trim()))) {
    throw new CatalogMergeCandidateReviewCommandError(
      "edit_fact_not_editable",
      "A Catalog Merge Candidate edit can correct only the candidate's text facts.",
    );
  }
  return applyCatalogMergeCandidateEdit(stored, edit);
}

// A fact correction is recorded as `manual` provenance anchored to the first member, so the
// domain's provenance invariant (every entry names a concrete source) holds, promotion carries
// the corrected value, and the trail shows an operator correction.
function applyCatalogMergeCandidateEdit(
  base: CatalogMergeCandidateReviewSnapshot,
  edit: CatalogMergeCandidateEditInput,
): CatalogMergeCandidateReviewSnapshot {
  const anchor = base.membership[0];
  if (!anchor) {
    throw new Error("Catalog Merge Candidate edit requires at least one Source Observation.");
  }

  const droppedCatalogItemRefs = new Set(edit.droppedExternalCatalogItemReferenceIndexes);
  const droppedProductRefs = new Set(edit.droppedExternalProductReferenceIndexes);

  let proposedCatalogItemFacts: JsonObject = { ...base.proposedCatalogItemFacts };
  let fieldProvenance: readonly CatalogMergeCandidateFieldProvenance[] = base.fieldProvenance;

  for (const override of edit.factOverrides) {
    const key = override.key.trim();
    if (!key) {
      continue;
    }
    const fieldPath = `catalogItem.${key}`;
    proposedCatalogItemFacts = { ...proposedCatalogItemFacts, [key]: override.value };
    fieldProvenance = [
      ...fieldProvenance.filter((entry) => entry.fieldPath !== fieldPath),
      {
        fieldPath,
        value: override.value,
        observationId: anchor.observationId,
        providerKey: anchor.providerKey,
        sourceProfileKey: anchor.sourceProfileKey,
        sourceProfileVersion: anchor.sourceProfileVersion,
        confidence: "manual",
        evidence: { operatorCorrection: true },
      },
    ];
  }

  return {
    ...base,
    matches: {
      catalogItemId: edit.catalogItemId?.trim() || null,
      productIds: uniqueTrimmedIds(edit.productIds),
    },
    proposedCatalogItemFacts,
    proposedExternalCatalogItemReferences: base.proposedExternalCatalogItemReferences.filter(
      (_reference, index) => !droppedCatalogItemRefs.has(index),
    ),
    proposedExternalProductReferences: base.proposedExternalProductReferences.filter(
      (_reference, index) => !droppedProductRefs.has(index),
    ),
    fieldProvenance,
    promotionIntent: edit.promotionIntent,
  };
}

function uniqueTrimmedIds(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function staleCandidateError(): CatalogMergeCandidateReviewCommandError {
  return new CatalogMergeCandidateReviewCommandError(
    "stale_merge_candidate",
    "The Catalog Merge Candidate changed after it was read; read it again before acting on it.",
  );
}

function splitRefusal(
  blocker: CatalogMergeCandidateSplitBlocker | "split-selection-invalid",
): CatalogMergeCandidateReviewCommandError {
  switch (blocker) {
    case "split-selection-invalid":
      return new CatalogMergeCandidateReviewCommandError(
        "split_selection_invalid",
        "A split names one or more of the candidate's own Source Observations.",
      );
    case "split-requires-two-members":
      return new CatalogMergeCandidateReviewCommandError(
        "split_requires_two_members",
        "A split must leave at least one Source Observation on the candidate.",
      );
    case "split-requires-separable-reference-provenance":
      return new CatalogMergeCandidateReviewCommandError(
        "split_requires_separable_reference_provenance",
        "Each side of a split needs an external reference of its own.",
      );
  }
}

function isConcurrencyConflict(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "concurrency_conflict";
}
