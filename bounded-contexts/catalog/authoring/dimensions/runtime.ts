import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../runtime-support";
import {
  type DimensionState,
  type DimensionCommand,
  type DimensionEvent,
  initialDimensionState,
  decideDimension,
  evolveDimension,
} from "./domain";
import { buildDimensionProjectionHandlers } from "./projection";

export type DimensionRuntime = Readonly<{
  dimensionHandler: CommandHandler<DimensionCommand, DimensionState, DimensionEvent>;
  projectors: readonly Projector[];
}>;

export function createDimensionRuntime(
  deps: CatalogRuntimeDeps,
): DimensionRuntime {
  const dimensionHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<DimensionEvent>(),
      initialState: () => initialDimensionState,
      evolve: evolveDimension,
    }),
    evolve: evolveDimension,
    decide: decideDimension,
  });

  return {
    dimensionHandler,
    projectors: [
      createProjector({
        projectorName: "catalog-dimension-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildDimensionProjectionHandlers(deps.db),
      }),
    ],
  };
}

