import { createPostgresEventStore, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { createSavedListRuntime } from "../../features/saved-lists/api/runtime";
import type { SavedListProductCatalog } from "../../features/saved-lists/domain/contracts";

export type CollectionsHostPorts = Readonly<{
  savedListProductCatalog?: SavedListProductCatalog;
}>;

export type CollectionsServices = Readonly<{
  savedLists: ReturnType<typeof createSavedListRuntime>;
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

const unavailableProductCatalog: SavedListProductCatalog = {
  resolveProduct: async () => ({ availability: "unavailable", product: null }),
};

export function createCollectionsServices(
  pool: PgTransactionalPool,
  ports: CollectionsHostPorts = {},
): CollectionsServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "collections" }),
  });
  return {
    savedLists: createSavedListRuntime({
      eventStore,
      productCatalog: ports.savedListProductCatalog ?? unavailableProductCatalog,
    }),
    pool,
    db: pool as PgQueryable,
  };
}
