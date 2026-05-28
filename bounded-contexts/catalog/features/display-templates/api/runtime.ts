import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { withCatalogAdminRealtimeInvalidation } from "../../../support/projection-support/realtime-invalidation";
import {
  decideDisplayTemplate,
  evolveDisplayTemplate,
  initialDisplayTemplateState,
  type DisplayTemplateCommand,
  type DisplayTemplateEvent,
  type DisplayTemplateState,
} from "../domain/domain";
import { buildDisplayTemplateProjectionHandlers } from "../read-model/projection";
import { getDisplayTemplateDetail, listDisplayTemplates } from "../read-model/queries";

export type DisplayTemplateServices = Readonly<{
  commandHandler: CommandHandler<DisplayTemplateCommand, DisplayTemplateState, DisplayTemplateEvent>;
  listDisplayTemplates: (
    params?: Parameters<typeof listDisplayTemplates>[1],
  ) => ReturnType<typeof listDisplayTemplates>;
  getDisplayTemplateDetail: (displayTemplateId: string) => ReturnType<typeof getDisplayTemplateDetail>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createDisplayTemplateRuntime(deps: CatalogRuntimeDeps): DisplayTemplateServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<DisplayTemplateEvent>(),
      initialState: () => initialDisplayTemplateState,
      evolve: evolveDisplayTemplate,
    }),
    evolve: evolveDisplayTemplate,
    decide: decideDisplayTemplate,
  });

  return {
    commandHandler,
    listDisplayTemplates: (params) => listDisplayTemplates(deps.db, params),
    getDisplayTemplateDetail: (displayTemplateId) => getDisplayTemplateDetail(deps.db, displayTemplateId),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "catalog-display-template-projection",
        handlers: withCatalogAdminRealtimeInvalidation(buildDisplayTemplateProjectionHandlers(deps.db), deps.db, {
          projectionName: "catalog-display-template-projection",
          surface: "display-templates",
        }),
      }),
    ],
  };
}
