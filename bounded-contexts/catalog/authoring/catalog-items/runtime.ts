import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../runtime-support";
import {
  type CatalogItemState,
  type CatalogItemCommand,
  type CatalogItemEvent,
  initialCatalogItemState,
  decideCatalogItem,
  evolveCatalogItem,
} from "./domain";
import { getCatalogItemDetail, listCatalogItems } from "./queries";
import { buildCatalogAdminCatalogItemProjectionHandlers } from "./admin-projection";
import { buildCatalogItemProjectionHandlers } from "./projection";

export type CatalogItemServices = Readonly<{
  commandHandler: CommandHandler<
    CatalogItemCommand,
    CatalogItemState,
    CatalogItemEvent
  >;
  listCatalogItems: (
    params?: Parameters<typeof listCatalogItems>[1],
  ) => ReturnType<typeof listCatalogItems>;
  getCatalogItemDetail: (
    itemId: string,
  ) => ReturnType<typeof getCatalogItemDetail>;
  projectors: readonly Projector[];
}>;

export function createCatalogItemRuntime(
  deps: CatalogRuntimeDeps,
): CatalogItemServices {
  const commandHandler = createCommandHandler({
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
    commandHandler,
    listCatalogItems: (params) => listCatalogItems(deps.db, params),
    getCatalogItemDetail: (itemId) => getCatalogItemDetail(deps.db, itemId),
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