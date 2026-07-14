import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildSavedListCatalogProjectionHandlers } from "../integrations/catalog/projection";
import type { SavedListDetailQuery, SavedListSummaryQuery } from "./contracts";
import { buildSavedListProjectionHandlers } from "./projection";
import { listSavedListSummaries, loadMyCollectionSavedListsModule, loadSavedListDetail } from "./queries";

export type SavedListReadModelServices = Readonly<{
  listSummaries: (input: SavedListSummaryQuery) => ReturnType<typeof listSavedListSummaries>;
  loadDetail: (input: SavedListDetailQuery) => ReturnType<typeof loadSavedListDetail>;
  loadMyCollectionModule: (input: SavedListSummaryQuery) => ReturnType<typeof loadMyCollectionSavedListsModule>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createSavedListReadModelRuntime(db: PgQueryable): SavedListReadModelServices {
  return {
    listSummaries: (input) => listSavedListSummaries(db, input),
    loadDetail: (input) => loadSavedListDetail(db, input),
    loadMyCollectionModule: (input) => loadMyCollectionSavedListsModule(db, input),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "collections-saved-list-projection",
        handlers: buildSavedListProjectionHandlers(db),
      }),
      createProjectionHandlerSet({
        projectionName: "collections-catalog-product-projection",
        handlers: buildSavedListCatalogProjectionHandlers(db),
      }),
    ],
  };
}
