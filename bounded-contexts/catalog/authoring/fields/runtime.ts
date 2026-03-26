import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../runtime-support";
import {
  type FieldState,
  type FieldCommand,
  type FieldEvent,
  initialFieldState,
  decideField,
  evolveField,
} from "./domain";
import { buildFieldProjectionHandlers } from "./projection";

export type FieldRuntime = Readonly<{
  fieldHandler: CommandHandler<FieldCommand, FieldState, FieldEvent>;
  projectors: readonly Projector[];
}>;

export function createFieldRuntime(deps: CatalogRuntimeDeps): FieldRuntime {
  const fieldHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<FieldEvent>(),
      initialState: () => initialFieldState,
      evolve: evolveField,
    }),
    evolve: evolveField,
    decide: decideField,
  });

  return {
    fieldHandler,
    projectors: [
      createProjector({
        projectorName: "catalog-field-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildFieldProjectionHandlers(deps.db),
      }),
    ],
  };
}

