import { createPassthroughDomainEventCodec } from "../../../../contracts/event-core/codec";
import { createAggregateRepository } from "../../../../contracts/event-core/aggregate-repository";
import {
  createCommandHandler,
  type CommandHandler,
} from "../../../../contracts/event-core/command-handler";
import { createProjector, type Projector } from "../../../../contracts/event-core/projector";
import type { CatalogRuntimeDeps } from "../runtime-support";
import {
  type CatalogItemState,
  type CatalogItemCommand,
  type CatalogItemEvent,
  initialCatalogItemState,
  decideCatalogItem,
  evolveCatalogItem,
} from "./domain";
import { buildCatalogAdminCatalogItemProjectionHandlers } from "./admin-projection";
import { buildCatalogItemProjectionHandlers } from "./projection";

export type CatalogItemRuntime = Readonly<{
  catalogItemHandler: CommandHandler<
    CatalogItemCommand,
    CatalogItemState,
    CatalogItemEvent
  >;
  projectors: readonly Projector[];
}>;

export function createCatalogItemRuntime(
  deps: CatalogRuntimeDeps,
): CatalogItemRuntime {
  const catalogItemHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<CatalogItemEvent>(),
      initialState: () => initialCatalogItemState,
      evolve: evolveCatalogItem,
    }),
    evolve: evolveCatalogItem,
    decide: decideCatalogItem,
  });

  return {
    catalogItemHandler,
    projectors: [
      createProjector({
        projectorName: "catalog-item-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildCatalogItemProjectionHandlers(deps.db),
      }),
      createProjector({
        projectorName: "catalog-admin-catalog-item-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildCatalogAdminCatalogItemProjectionHandlers(deps.db),
      }),
    ],
  };
}
