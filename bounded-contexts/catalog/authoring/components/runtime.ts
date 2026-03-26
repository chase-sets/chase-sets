import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../runtime-support";
import {
  type ComponentState,
  type ComponentCommand,
  type ComponentEvent,
  initialComponentState,
  decideComponent,
  evolveComponent,
} from "./domain";
import { buildCatalogAdminComponentProjectionHandlers } from "./admin-projection";
import { buildComponentProjectionHandlers } from "./projection";

export type ComponentRuntime = Readonly<{
  componentHandler: CommandHandler<ComponentCommand, ComponentState, ComponentEvent>;
  projectors: readonly Projector[];
}>;

export function createComponentRuntime(
  deps: CatalogRuntimeDeps,
): ComponentRuntime {
  const componentHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<ComponentEvent>(),
      initialState: () => initialComponentState,
      evolve: evolveComponent,
    }),
    evolve: evolveComponent,
    decide: decideComponent,
  });

  return {
    componentHandler,
    projectors: [
      createProjector({
        projectorName: "catalog-component-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildComponentProjectionHandlers(deps.db),
      }),
      createProjector({
        projectorName: "catalog-admin-component-detail-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildCatalogAdminComponentProjectionHandlers(deps.db),
      }),
    ],
  };
}

