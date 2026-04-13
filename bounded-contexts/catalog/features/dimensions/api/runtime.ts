import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import {
  type DimensionState,
  type DimensionCommand,
  type DimensionEvent,
  initialDimensionState,
  decideDimension,
  evolveDimension,
} from "../domain/domain";
import { getDimension, listDimensions } from "../read-model/queries";
import { buildDimensionProjectionHandlers } from "../read-model/projection";

export type DimensionServices = Readonly<{
  commandHandler: CommandHandler<DimensionCommand, DimensionState, DimensionEvent>;
  listDimensions: (
    params?: Parameters<typeof listDimensions>[1],
  ) => ReturnType<typeof listDimensions>;
  getDimension: (dimensionId: string) => ReturnType<typeof getDimension>;
  projectors: readonly Projector[];
}>;

export function createDimensionRuntime(
  deps: CatalogRuntimeDeps,
): DimensionServices {
  const commandHandler = createCommandHandler({
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
    commandHandler,
    listDimensions: (params) => listDimensions(deps.db, params),
    getDimension: (dimensionId) => getDimension(deps.db, dimensionId),
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