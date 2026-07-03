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
  listAcceptedProviderScopeMappingsByProviderUnit,
  listAcceptedProviderScopeMappingsByScopeRecord,
} from "../read-model/queries";

export type ProviderScopeMappingServices = Readonly<{
  commandHandler: CommandHandler<ProviderScopeMappingCommand, ProviderScopeMappingState, ProviderScopeMappingEvent>;
  listAcceptedMappingsByScopeRecord: (
    scopeRecordId: string,
  ) => ReturnType<typeof listAcceptedProviderScopeMappingsByScopeRecord>;
  listAcceptedMappingsByProviderUnit: (
    input: Parameters<typeof listAcceptedProviderScopeMappingsByProviderUnit>[1],
  ) => ReturnType<typeof listAcceptedProviderScopeMappingsByProviderUnit>;
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
    projectors: [
      {
        projectionName: "catalog-provider-scope-mapping-projection",
        handlers: buildProviderScopeMappingProjectionHandlers(deps.db),
      },
    ] satisfies readonly ProjectionHandlerSet[],
  };
}
