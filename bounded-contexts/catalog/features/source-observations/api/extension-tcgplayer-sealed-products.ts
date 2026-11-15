import { randomUUID } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { createPostgresEventStore, withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { TcgplayerSealedProductObservationRecorder } from "../../operator-session/api/sealed-product-observations";
import {
  decideSourceObservation,
  evolveSourceObservation,
  initialSourceObservationState,
  type SourceObservationEvent,
} from "../domain/domain";
import { buildTcgplayerAutomationSourceObservationPayload } from "./providers/tcgplayer/adapter";
import { requireCatalogProviderSourceObservation } from "./promotion/provider-source-observation-normalizer";
import { requireSourceObservationMappingContract } from "./source-observation-promotion-execution";
import { createSourceObservationMergeCandidateRuntime } from "./source-observation-merge-candidate-runtime";
import type { CatalogProviderIntegrationProfileVersionReader } from "./source-observation-runtime-contracts";
import { sourceObservationStreamId } from "./source-observation-stream-identity";

// All appends use the route's serialized backend and one transaction, including admission.
// Issue: https://github.com/chase-sets/chase-sets/issues/10040
export function createExtensionTcgplayerSealedProductRecorder(
  input: Readonly<{
    deps: CatalogRuntimeDeps;
    pool: PgTransactionalPool;
    profileVersions: CatalogProviderIntegrationProfileVersionReader;
  }>,
): TcgplayerSealedProductObservationRecorder {
  return async function recordExtensionTcgplayerSealedProducts(request, backend = input.pool) {
    const profile = await input.profileVersions.getActiveProfileVersion("tcgplayer", {
      ingestionUnitKey: request.unitKey,
    });
    if (!profile || !profile.active || profile.lifecycle !== "active") throw new Error("profile-unavailable");
    const selectedOptionMapping = profile.profile.selectedOptionMapping;
    if (!selectedOptionMapping) throw new Error("mapping-unavailable");
    const contract = requireSourceObservationMappingContract(profile);
    // Normalize the complete post before the first write; no partial admission on mapping failure.
    const observations = request.post.products.map((detail) =>
      requireCatalogProviderSourceObservation({
        contract,
        payload: buildTcgplayerAutomationSourceObservationPayload({
          detail,
          externalReferenceRules: profile.profile.externalReferenceExtractionRules.rules,
          selectedOptionMapping,
        }),
        observedAt: request.post.observedAt,
      }),
    );
    const store = createPostgresEventStore({ pool: backend });
    return withPgTransaction(backend, async (transaction) => {
      const eventStore: EventStore = {
        ...store,
        readStream: (read) => store.readStreamInTransaction(transaction, read),
        appendToStream: (append) => store.appendToStreamInTransaction(transaction, append),
        appendToStreams: (appends) => store.appendToStreamsInTransaction(transaction, appends),
      };
      const { commandHandler, repository } = createAggregateCommandHandler({
        eventStore,
        codec: createPassthroughDomainEventCodec<SourceObservationEvent>(),
        initialState: () => initialSourceObservationState,
        evolve: evolveSourceObservation,
        decide: decideSourceObservation,
      });
      const mergeCandidates: ReturnType<typeof createSourceObservationMergeCandidateRuntime> =
        createSourceObservationMergeCandidateRuntime({
          deps: { ...input.deps, db: transaction, eventStore },
          profileVersions: input.profileVersions,
          // A second post can arrive before projections catch up. Reconcile membership from
          // canonical streams on this transaction, never invent a projected row or drain a worker.
          loadObservationRows: async (ids) => {
            const rows = [];
            for (const id of ids) {
              const { state } = await repository.load(sourceObservationStreamId(id));
              if (!state.id || !state.normalized || !state.observedAt) throw new Error("observation-unavailable");
              rows.push({
                ...mergeCandidates.sourceObservationRecordToCandidateRow({
                  ...state,
                  observationId: state.id,
                  normalized: state.normalized,
                  observedAt: state.observedAt,
                }),
                status: state.status,
                status_reason: state.statusReason,
                promoted_catalog_item_id: state.promotedCatalogItemId,
                promoted_reference_record_id: state.promotedReferenceRecordId,
                promoted_at: state.promotedAt,
                promotion_profile_key: state.promotionProfileKey,
                promotion_profile_version: state.promotionProfileVersion,
                promotion_plan_fingerprint: state.promotionPlanFingerprint,
              });
            }
            return rows;
          },
        });
      let recorded = 0;
      let changed = 0;
      let unchanged = 0;
      for (const observation of observations) {
        const streamId = sourceObservationStreamId(observation.observationId);
        const prior = await repository.load(streamId);
        if (
          prior.state.id &&
          prior.state.sourceRecordHash === observation.sourceRecordHash &&
          prior.state.sourceUpdatedAt === observation.sourceUpdatedAt &&
          prior.state.sourceProfileKey === observation.sourceProfileKey &&
          prior.state.sourceProfileVersion === observation.sourceProfileVersion &&
          prior.state.sourceMappingFingerprint === observation.sourceMappingFingerprint
        ) {
          unchanged++;
          continue;
        }
        const result = await commandHandler({
          streamId,
          command: { type: "RecordSourceObservation", ...observation },
          context: request.context,
        });
        if (result.newEvents.length === 0) unchanged++;
        else if (prior.state.id) changed++;
        else recorded++;
      }
      const generated = await mergeCandidates.persistCatalogMergeCandidatesFromObservations(
        observations.map(mergeCandidates.sourceObservationRecordToCandidateRow),
        request.context,
        { preserveUnchangedTerminalCandidates: true },
      );
      const admission = await eventStore.appendToStream({
        streamId: `catalog.operator-session-sealed-product-admission-${randomUUID()}`,
        expectedVersion: "no_stream",
        context: request.context,
        events: [
          {
            eventType: "catalog.operator-session.sealed-product-observations-admitted",
            payload: {
              ...request.provenance,
              observationIds: observations.map((observation) => observation.observationId),
            },
          },
        ],
      });
      recordCommittedEvents(admission);
      const productIds = new Map(
        observations.map((observation, index) => [observation.observationId, request.post.products[index]!.productId]),
      );
      return {
        recorded,
        changed,
        unchanged,
        candidateCount: generated.candidates.length,
        exclusions: generated.exclusions.map((exclusion) => ({
          productId: productIds.get(exclusion.observationId)!,
          code: exclusion.code,
        })),
      };
    });
  };
}
