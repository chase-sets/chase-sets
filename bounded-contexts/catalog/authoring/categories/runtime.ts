import { createPassthroughDomainEventCodec } from "../../../../contracts/event-core/codec";
import { createAggregateRepository } from "../../../../contracts/event-core/aggregate-repository";
import {
  createCommandHandler,
  type CommandHandler,
} from "../../../../contracts/event-core/command-handler";
import { createProjector, type Projector } from "../../../../contracts/event-core/projector";
import type { CatalogRuntimeDeps } from "../runtime-support";
import {
  type CategoryState,
  type CategoryCommand,
  type CategoryEvent,
  initialCategoryState,
  decideCategory,
  evolveCategory,
} from "./domain";
import { buildCatalogAdminCategoryProjectionHandlers } from "./admin-projection";
import { buildCategoryProjectionHandlers } from "./projection";

export type CategoryRuntime = Readonly<{
  categoryHandler: CommandHandler<CategoryCommand, CategoryState, CategoryEvent>;
  projectors: readonly Projector[];
}>;

export function createCategoryRuntime(
  deps: CatalogRuntimeDeps,
): CategoryRuntime {
  const categoryHandler = createCommandHandler({
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
    categoryHandler,
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
