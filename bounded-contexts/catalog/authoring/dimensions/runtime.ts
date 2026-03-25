import { createPassthroughDomainEventCodec } from "../../../../contracts/event-core/codec";
import { createAggregateRepository } from "../../../../contracts/event-core/aggregate-repository";
import {
  createCommandHandler,
  type CommandHandler,
} from "../../../../contracts/event-core/command-handler";
import { createProjector, type Projector } from "../../../../contracts/event-core/projector";
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
