import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../runtime-support";
import {
  type CategoryState,
  type CategoryCommand,
  type CategoryEvent,
  initialCategoryState,
  decideCategory,
  evolveCategory,
} from "./domain";
import { getCategoryDetail, listCategories } from "./queries";
import { buildCatalogAdminCategoryProjectionHandlers } from "./admin-projection";
import { buildCategoryProjectionHandlers } from "./projection";

export type CategoryServices = Readonly<{
  commandHandler: CommandHandler<CategoryCommand, CategoryState, CategoryEvent>;
  listCategories: (
    params?: Parameters<typeof listCategories>[1],
  ) => ReturnType<typeof listCategories>;
  getCategoryDetail: (
    categoryId: string,
  ) => ReturnType<typeof getCategoryDetail>;
  projectors: readonly Projector[];
}>;

export function createCategoryRuntime(
  deps: CatalogRuntimeDeps,
): CategoryServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<CategoryEvent>(),
      initialState: () => initialCategoryState,
      evolve: evolveCategory,
    }),
    evolve: evolveCategory,
    decide: decideCategory,
  });

  return {
    commandHandler,
    listCategories: (params) => listCategories(deps.db, params),
    getCategoryDetail: (categoryId) => getCategoryDetail(deps.db, categoryId),
    projectors: [
      createProjector({
        projectorName: "catalog-category-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildCategoryProjectionHandlers(deps.db),
      }),
      createProjector({
        projectorName: "catalog-admin-category-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildCatalogAdminCategoryProjectionHandlers(deps.db),
      }),
    ],
  };
}