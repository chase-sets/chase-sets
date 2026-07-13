import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import {
  decideProviderScopeMapping,
  evolveProviderScopeMapping,
  initialProviderScopeMappingState,
  type ProviderScopeMappingCommand,
  type ProviderScopeMappingEvent,
  type ProviderScopeMappingState,
} from "../domain/domain";
import { buildProviderScopeMappingProjectionHandlers } from "../read-model/projection";
import {
  getProviderScopeMapping,
  listAcceptedProviderScopeMappingsByProviderUnit,
  listAcceptedProviderScopeMappingsByScopeRecord,
  listProviderScopeMappingsByScopeRecord,
} from "../read-model/queries";
import {
  getScopeObservationSyncStatus,
  getScopeRecordSummary,
  listUnmappedScopeInboxRows,
} from "../read-model/scope-coverage-queries";
import {
  buildScopeCoverageMatrix,
  buildUnmappedScopeInboxReadModel,
  type ScopeCoverageMatrix,
  type UnmappedScopeInboxReadModel,
} from "./scope-coverage-admin-contracts";

export type ProviderScopeMappingServices = Readonly<{
  commandHandler: CommandHandler<ProviderScopeMappingCommand, ProviderScopeMappingState, ProviderScopeMappingEvent>;
  listAcceptedMappingsByScopeRecord: (
    scopeRecordId: string,
  ) => ReturnType<typeof listAcceptedProviderScopeMappingsByScopeRecord>;
  listAcceptedMappingsByProviderUnit: (
    input: Parameters<typeof listAcceptedProviderScopeMappingsByProviderUnit>[1],
  ) => ReturnType<typeof listAcceptedProviderScopeMappingsByProviderUnit>;
  getMapping: (mappingId: string) => ReturnType<typeof getProviderScopeMapping>;
  /** The unmapped-scope inbox: every `proposed` mapping, grouped by canonical scope record. */
  getUnmappedScopeInbox: (input?: { limit?: number }) => Promise<UnmappedScopeInboxReadModel>;
  /** The per-provider coverage ladder for one canonical scope record; null if the scope record does not exist. */
  getScopeCoverageMatrix: (scopeRecordId: string) => Promise<ScopeCoverageMatrix | null>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createProviderScopeMappingRuntime(deps: CatalogRuntimeDeps): ProviderScopeMappingServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<ProviderScopeMappingEvent>(),
    initialState: () => initialProviderScopeMappingState,
    evolve: evolveProviderScopeMapping,
    decide: decideProviderScopeMapping,
  });

  return {
    commandHandler,
    listAcceptedMappingsByScopeRecord: (scopeRecordId) =>
      listAcceptedProviderScopeMappingsByScopeRecord(deps.db, scopeRecordId),
    listAcceptedMappingsByProviderUnit: (input) => listAcceptedProviderScopeMappingsByProviderUnit(deps.db, input),
    getMapping: (mappingId) => getProviderScopeMapping(deps.db, mappingId),
    getUnmappedScopeInbox: async (input) => {
      const rows = await listUnmappedScopeInboxRows(deps.db, { limit: input?.limit });
      return buildUnmappedScopeInboxReadModel({ generatedAt: new Date().toISOString(), rows });
    },
    getScopeCoverageMatrix: async (scopeRecordId) => {
      const scope = await getScopeRecordSummary(deps.db, scopeRecordId);
      if (!scope) {
        return null;
      }
      const mappingRows = await listProviderScopeMappingsByScopeRecord(deps.db, scopeRecordId);
      return buildScopeCoverageMatrix({
        generatedAt: new Date().toISOString(),
        scope,
        mappingRows,
        loadSyncStatus: (row) =>
          getScopeObservationSyncStatus(deps.db, {
            providerKey: row.provider_key,
            productLineId: row.product_line_id,
            seriesId: row.series_id,
            setIdOrName: row.set_id ?? row.set_name,
          }),
      });
    },
    projectors: [
      {
        projectionName: "catalog-provider-scope-mapping-projection",
        handlers: buildProviderScopeMappingProjectionHandlers(deps.db),
      },
    ] satisfies readonly ProjectionHandlerSet[],
  };
}
