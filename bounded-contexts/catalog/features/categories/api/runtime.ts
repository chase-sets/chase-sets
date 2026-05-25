import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { withCatalogAdminRealtimeInvalidation } from "../../../support/projection-support/realtime-invalidation";
import {
  createBulkLifecycleOperations,
  type BulkLifecycleOperations,
  type BulkSelection,
} from "../../../support/runtime-support/bulk-lifecycle";
import {
  type CategoryState,
  type CategoryCommand,
  type CategoryEvent,
  initialCategoryState,
  decideCategory,
  evolveCategory,
} from "../domain/domain";
import {
  getCategoryDetail,
  listCategories,
  listCategoryBulkRows,
  listCategoryIds,
  type CategoryListParams,
} from "../read-model/queries";
import { buildCatalogAdminCategoryProjectionHandlers } from "../read-model/admin-projection";
import { buildCategoryProjectionHandlers } from "../read-model/projection";

export type CategoryServices = Readonly<{
  commandHandler: CommandHandler<CategoryCommand, CategoryState, CategoryEvent>;
  listCategories: (params?: Parameters<typeof listCategories>[1]) => ReturnType<typeof listCategories>;
  getCategoryDetail: (categoryId: string) => ReturnType<typeof getCategoryDetail>;
  bulkLifecycle: BulkLifecycleOperations<CategoryListParams, CategoryCommand, CategoryState, CategoryEvent>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createCategoryRuntime(deps: CatalogRuntimeDeps): CategoryServices {
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

  const projectors = [
    createProjectionHandlerSet({
      projectionName: "catalog-category-projection",
      handlers: buildCategoryProjectionHandlers(deps.db),
    }),
    createProjectionHandlerSet({
      projectionName: "catalog-admin-category-projection",
      handlers: withCatalogAdminRealtimeInvalidation(buildCatalogAdminCategoryProjectionHandlers(deps.db), deps.db, {
        projectionName: "catalog-admin-category-projection",
        surface: "categories",
      }),
    }),
  ];
  const bulkLifecycle = createBulkLifecycleOperations<
    CategoryListParams,
    CategoryCommand,
    CategoryState,
    CategoryEvent
  >({
    actions: [
      {
        action: "publish",
        readyStatus: "draft",
        command: { type: "PublishCategory" },
        streamId: (id) => `catalog.category-${id}`,
        blockedReason: (status) => `Only draft Categories can be published. Current status: ${status}.`,
      },
      {
        action: "deprecate",
        readyStatus: "active",
        command: { type: "DeprecateCategory" },
        streamId: (id) => `catalog.category-${id}`,
        blockedReason: (status) => `Only active Categories can be deprecated. Current status: ${status}.`,
      },
      {
        action: "archive",
        readyStatus: "deprecated",
        command: { type: "ArchiveCategory" },
        streamId: (id) => `catalog.category-${id}`,
        blockedReason: (status) => `Only deprecated Categories can be archived. Current status: ${status}.`,
      },
    ],
    commandHandler,
    resolveIds: (selection: BulkSelection<CategoryListParams>) =>
      selection.mode === "ids" ? Promise.resolve(selection.ids) : listCategoryIds(deps.db, selection.query),
    loadRows: (ids) => listCategoryBulkRows(deps.db, ids),
  });

  return {
    commandHandler,
    listCategories: (params) => listCategories(deps.db, params),
    getCategoryDetail: (categoryId) => getCategoryDetail(deps.db, categoryId),
    bulkLifecycle,
    projectors,
  };
}
