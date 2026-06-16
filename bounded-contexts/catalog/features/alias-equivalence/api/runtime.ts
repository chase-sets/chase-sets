import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { withCatalogAdminRealtimeInvalidation } from "../../../support/projection-support/realtime-invalidation";
import {
  decideCatalogAlias,
  evolveCatalogAlias,
  initialCatalogAliasState,
  type CatalogAliasCommand,
  type CatalogAliasEvent,
  type CatalogAliasState,
} from "../domain/domain";
import { buildCatalogAliasProjectionHandlers, upsertSourceObservationAliasCandidates } from "../read-model/projection";
import {
  countCatalogItemsForAliasText,
  countSourceObservationAliasCandidatesByProfileVersion,
  getCatalogItemAlias,
  getReferenceRecordAlias,
  getSourceObservationAliasCandidate,
  listCatalogItemAliases,
  listPublishableCatalogItemAliases,
  listPublishableReferenceRecordAliases,
  listReferenceRecordAliases,
  listSourceObservationAliasCandidates,
} from "../read-model/queries";
import {
  assembleCatalogAliasReviewReadModel,
  type CatalogAliasReviewFilter,
  type CatalogAliasReviewReadModel,
} from "./alias-review-admin-contracts";

export type CatalogAliasServices = Readonly<{
  catalogAliasCommandHandler: CommandHandler<CatalogAliasCommand, CatalogAliasState, CatalogAliasEvent>;
  /** Idempotently persist Source Observation alias candidates into the queryable table. */
  upsertSourceObservationAliasCandidates: (
    candidates: Parameters<typeof upsertSourceObservationAliasCandidates>[1],
    observedAt: string,
  ) => Promise<void>;
  listSourceObservationAliasCandidates: (
    filter?: Parameters<typeof listSourceObservationAliasCandidates>[1],
  ) => ReturnType<typeof listSourceObservationAliasCandidates>;
  getSourceObservationAliasCandidate: (aliasHash: string) => ReturnType<typeof getSourceObservationAliasCandidate>;
  countSourceObservationAliasCandidatesByProfileVersion: (
    providerKey: string,
    sourceProfileVersion: string,
  ) => Promise<number>;
  listCatalogItemAliases: (
    catalogItemId: string,
    options?: Parameters<typeof listCatalogItemAliases>[2],
  ) => ReturnType<typeof listCatalogItemAliases>;
  listPublishableCatalogItemAliases: (catalogItemId: string) => ReturnType<typeof listPublishableCatalogItemAliases>;
  getCatalogItemAlias: (aliasHash: string) => ReturnType<typeof getCatalogItemAlias>;
  countCatalogItemsForAliasText: (normalizedAliasText: string, aliasLanguageCode: string) => Promise<number>;
  listReferenceRecordAliases: (
    referenceRecordId: string,
    options?: Parameters<typeof listReferenceRecordAliases>[2],
  ) => ReturnType<typeof listReferenceRecordAliases>;
  listPublishableReferenceRecordAliases: (
    referenceRecordId: string,
  ) => ReturnType<typeof listPublishableReferenceRecordAliases>;
  getReferenceRecordAlias: (aliasHash: string) => ReturnType<typeof getReferenceRecordAlias>;
  /**
   * Admin alias review read model (#1908): candidate summaries by scope, coverage
   * counters, and auto-accept eligibility for the operator review workspace.
   */
  getCatalogAliasReviewReadModel: (input: {
    generatedAt: string;
    filter?: Partial<CatalogAliasReviewFilter>;
    candidateLimit?: number;
  }) => Promise<CatalogAliasReviewReadModel>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createCatalogAliasRuntime(deps: CatalogRuntimeDeps): CatalogAliasServices {
  const { commandHandler: catalogAliasCommandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<CatalogAliasEvent>(),
    initialState: () => initialCatalogAliasState,
    evolve: evolveCatalogAlias,
    decide: decideCatalogAlias,
  });

  const projectors = [
    createProjectionHandlerSet({
      projectionName: "catalog-alias-projection",
      handlers: withCatalogAdminRealtimeInvalidation(buildCatalogAliasProjectionHandlers(deps.db), deps.db, {
        projectionName: "catalog-alias-projection",
        surface: "catalog-aliases",
      }),
    }),
  ];

  return {
    catalogAliasCommandHandler,
    upsertSourceObservationAliasCandidates: (candidates, observedAt) =>
      upsertSourceObservationAliasCandidates(deps.db, candidates, observedAt),
    listSourceObservationAliasCandidates: (filter) => listSourceObservationAliasCandidates(deps.db, filter),
    getSourceObservationAliasCandidate: (aliasHash) => getSourceObservationAliasCandidate(deps.db, aliasHash),
    countSourceObservationAliasCandidatesByProfileVersion: (providerKey, sourceProfileVersion) =>
      countSourceObservationAliasCandidatesByProfileVersion(deps.db, providerKey, sourceProfileVersion),
    listCatalogItemAliases: (catalogItemId, options) => listCatalogItemAliases(deps.db, catalogItemId, options),
    listPublishableCatalogItemAliases: (catalogItemId) => listPublishableCatalogItemAliases(deps.db, catalogItemId),
    getCatalogItemAlias: (aliasHash) => getCatalogItemAlias(deps.db, aliasHash),
    countCatalogItemsForAliasText: (normalizedAliasText, aliasLanguageCode) =>
      countCatalogItemsForAliasText(deps.db, normalizedAliasText, aliasLanguageCode),
    listReferenceRecordAliases: (referenceRecordId, options) =>
      listReferenceRecordAliases(deps.db, referenceRecordId, options),
    listPublishableReferenceRecordAliases: (referenceRecordId) =>
      listPublishableReferenceRecordAliases(deps.db, referenceRecordId),
    getReferenceRecordAlias: (aliasHash) => getReferenceRecordAlias(deps.db, aliasHash),
    getCatalogAliasReviewReadModel: (input) =>
      assembleCatalogAliasReviewReadModel(
        {
          listSourceObservationAliasCandidates: (filter) => listSourceObservationAliasCandidates(deps.db, filter),
          listCatalogItemAliases: (catalogItemId, options) => listCatalogItemAliases(deps.db, catalogItemId, options),
          listReferenceRecordAliases: (referenceRecordId, options) =>
            listReferenceRecordAliases(deps.db, referenceRecordId, options),
        },
        input,
      ),
    projectors,
  };
}
