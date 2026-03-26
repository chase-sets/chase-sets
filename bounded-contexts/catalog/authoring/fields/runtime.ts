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
import { getField, listFields } from "./queries";
import { buildFieldProjectionHandlers } from "./projection";

export type FieldServices = Readonly<{
  commandHandler: CommandHandler<FieldCommand, FieldState, FieldEvent>;
  listFields: (
    params?: Parameters<typeof listFields>[1],
  ) => ReturnType<typeof listFields>;
  getField: (fieldId: string) => ReturnType<typeof getField>;
  projectors: readonly Projector[];
}>;

export function createFieldRuntime(deps: CatalogRuntimeDeps): FieldServices {
  const commandHandler = createCommandHandler({
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
    commandHandler,
    listFields: (params) => listFields(deps.db, params),
    getField: (fieldId) => getField(deps.db, fieldId),
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