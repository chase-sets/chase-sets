import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import type { NotificationOutbox } from "@chase-sets/notifications";
import { createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import { createPostgresWebNotificationFeed } from "@chase-sets/web-notifications";
import {
  createDiscoveryCategoryRuntime,
  type DiscoveryCategoryServices,
} from "../../features/categories/api/runtime";
import {
  createProductAlertRuntime,
  type ProductAlertServices,
} from "../../features/product-alerts/api/runtime";
import { createDiscoveryItemRuntime, type DiscoveryItemsServices } from "../item-support/runtime";

export type DiscoveryHostPorts = Readonly<{
  notificationOutbox?: NotificationOutbox;
}>;

export type DiscoveryServices = Readonly<{
  categories: DiscoveryCategoryServices;
  items: DiscoveryItemsServices;
  productAlerts: ProductAlertServices;
  notifications: ReturnType<typeof createPostgresWebNotificationFeed>;
  notificationOutbox: NotificationOutbox;
  projectors: readonly Projector[];
  db: PgQueryable;
  pool: PgTransactionalPool;
}>;

export function createDiscoveryServices(
  pool: PgTransactionalPool,
  ports: DiscoveryHostPorts = {},
): DiscoveryServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const deps = { eventStore, checkpointStore, db } as const;
  const notificationOutbox =
    ports.notificationOutbox ?? createPostgresNotificationOutbox({ db });
  const notifications = createPostgresWebNotificationFeed({ db });
  const categories = createDiscoveryCategoryRuntime(deps);
  const items = createDiscoveryItemRuntime(deps);
  const productAlerts = createProductAlertRuntime(deps);

  return {
    categories,
    items,
    productAlerts,
    notifications,
    notificationOutbox,
    projectors: [...items.projectors, ...categories.projectors, ...productAlerts.projectors],
    db,
    pool,
  };
}
