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
import { getComponentDetail, listComponents } from "./queries";
import { buildCatalogAdminComponentProjectionHandlers } from "./admin-projection";
import { buildComponentProjectionHandlers } from "./projection";

export type ComponentServices = Readonly<{
  commandHandler: CommandHandler<ComponentCommand, ComponentState, ComponentEvent>;
  listComponents: (
    params?: Parameters<typeof listComponents>[1],
  ) => ReturnType<typeof listComponents>;
  getComponentDetail: (
    componentId: string,
  ) => ReturnType<typeof getComponentDetail>;
  projectors: readonly Projector[];
}>;

export function createComponentRuntime(
  deps: CatalogRuntimeDeps,
): ComponentServices {
  const commandHandler = createCommandHandler({
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
    commandHandler,
    listComponents: (params) => listComponents(deps.db, params),
    getComponentDetail: (componentId) => getComponentDetail(deps.db, componentId),
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