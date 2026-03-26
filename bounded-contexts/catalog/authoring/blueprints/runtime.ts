import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../runtime-support";
import {
  type BlueprintState,
  type BlueprintCommand,
  type BlueprintEvent,
  initialBlueprintState,
  decideBlueprint,
  evolveBlueprint,
} from "./domain";
import { buildCatalogAdminBlueprintProjectionHandlers } from "./admin-projection";
import { buildBlueprintProjectionHandlers } from "./projection";

export type BlueprintRuntime = Readonly<{
  blueprintHandler: CommandHandler<BlueprintCommand, BlueprintState, BlueprintEvent>;
  projectors: readonly Projector[];
}>;

export function createBlueprintRuntime(
  deps: CatalogRuntimeDeps,
): BlueprintRuntime {
  const blueprintHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<BlueprintEvent>(),
      initialState: () => initialBlueprintState,
      evolve: evolveBlueprint,
    }),
    evolve: evolveBlueprint,
    decide: decideBlueprint,
  });

  return {
    blueprintHandler,
    projectors: [
      createProjector({
        projectorName: "catalog-blueprint-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildBlueprintProjectionHandlers(deps.db),
      }),
      createProjector({
        projectorName: "catalog-admin-blueprint-detail-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildCatalogAdminBlueprintProjectionHandlers(deps.db),
      }),
    ],
  };
}

