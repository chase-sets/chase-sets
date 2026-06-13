import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { NotificationOutbox } from "@chase-sets/notifications";
import { createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import { createDiscoveryCategoryRuntime, type DiscoveryCategoryServices } from "../../features/categories/api/runtime";
import { createProductAlertRuntime, type ProductAlertServices } from "../../features/product-alerts/api/runtime";
import { buildGoogleShoppingFeedRowProjectionHandlers } from "../google-shopping-support/projection";
import {
  createGoogleShoppingSyncRuntime,
  type GoogleShoppingSyncServices,
} from "../../features/google-shopping-operations/api/sync-job";
import { createDiscoveryItemRuntime, type DiscoveryItemsServices } from "../item-support/runtime";

export type DiscoveryHostPorts = Readonly<{
  notificationOutbox?: NotificationOutbox;
}>;

export type DiscoveryServices = Readonly<{
  categories: DiscoveryCategoryServices;
  items: DiscoveryItemsServices;
  googleShoppingSync: GoogleShoppingSyncServices;
  productAlerts: ProductAlertServices;
  notificationOutbox: NotificationOutbox;
  projectors: readonly ProjectionHandlerSet[];
  db: PgQueryable;
  pool: PgTransactionalPool;
}>;

export function createDiscoveryServices(pool: PgTransactionalPool, ports: DiscoveryHostPorts = {}): DiscoveryServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "discovery" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const deps = { eventStore, checkpointStore, db } as const;
  const notificationOutbox = ports.notificationOutbox ?? createPostgresNotificationOutbox({ db });
  const categories = createDiscoveryCategoryRuntime(deps);
  const items = createDiscoveryItemRuntime(deps);
  const googleShoppingSync = createGoogleShoppingSyncRuntime({ db });
  const googleShoppingProjectors = [
    createProjectionHandlerSet({
      projectionName: "discovery-google-shopping-feed-row-projection",
      handlers: buildGoogleShoppingFeedRowProjectionHandlers(db),
    }),
  ];
  const productAlerts = createProductAlertRuntime(deps);

  return {
    categories,
    items,
    googleShoppingSync,
    productAlerts,
    notificationOutbox,
    projectors: [
      ...items.projectors,
      ...googleShoppingProjectors,
      ...categories.projectors,
      ...productAlerts.projectors,
    ],
    db,
    pool,
  };
}
