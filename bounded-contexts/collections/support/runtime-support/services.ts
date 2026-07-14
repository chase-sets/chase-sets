import { createPostgresEventStore, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { createSavedListRuntime } from "../../features/saved-lists/api/runtime";
import { createSavedListInventoryHandoff } from "../../features/saved-lists/integrations/inventory-handoff";
import type { SavedListInventoryImportBatchCreator } from "../../features/saved-lists/integrations/inventory-handoff";
import type { SavedListProductCatalog } from "../../features/saved-lists/domain/contracts";
import { createSavedListValuationRuntime } from "../../features/saved-list-valuation/api/runtime";

export type CollectionsHostPorts = Readonly<{
  savedListProductCatalog?: SavedListProductCatalog;
  inventorySavedListImportBatchCreator?: SavedListInventoryImportBatchCreator;
}>;

export type CollectionsServices = Readonly<{
  savedLists: ReturnType<typeof createSavedListRuntime>;
  savedListInventory: ReturnType<typeof createSavedListInventoryHandoff>;
  savedListValuation: ReturnType<typeof createSavedListValuationRuntime>;
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

const unavailableProductCatalog: SavedListProductCatalog = {
  resolveProduct: async () => ({ availability: "unavailable", product: null }),
};

const unavailableInventoryImportBatchCreator: SavedListInventoryImportBatchCreator = async () => {
  throw new Error("Inventory Saved List import is unavailable.");
};

export function createCollectionsServices(
  pool: PgTransactionalPool,
  ports: CollectionsHostPorts = {},
): CollectionsServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "collections" }),
  });
  const savedLists = createSavedListRuntime({
    eventStore,
    productCatalog: ports.savedListProductCatalog ?? unavailableProductCatalog,
  });
  return {
    savedLists,
    savedListInventory: createSavedListInventoryHandoff({
      savedLists,
      inventoryImportBatchCreator: ports.inventorySavedListImportBatchCreator ?? unavailableInventoryImportBatchCreator,
    }),
    savedListValuation: createSavedListValuationRuntime(pool),
    pool,
    db: pool as PgQueryable,
  };
}
