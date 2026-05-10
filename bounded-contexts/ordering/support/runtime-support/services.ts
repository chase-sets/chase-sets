import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import type { NotificationOutbox } from "@chase-sets/notifications";
import { createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import { createPostgresWebNotificationFeed } from "@chase-sets/web-notifications";
import { createOrderingAccountRuntime } from "../account-support/runtime";
import { createOrderingOrderRuntime } from "../../features/orders/api/runtime";
import type { TaxQuoteResolver } from "../../features/orders/api/runtime";
import {
  defaultShippingQuotePolicy,
  type ShippingQuotePolicy,
} from "../../features/orders/domain/policies";

export type OrderingServiceOptions = Readonly<{
  shippingQuotePolicy?: ShippingQuotePolicy;
  taxQuoteResolver?: TaxQuoteResolver;
  notificationOutbox?: NotificationOutbox;
}>;

export type OrderingServices = Readonly<{
  orders: ReturnType<typeof createOrderingOrderRuntime>;
  notifications: ReturnType<typeof createPostgresWebNotificationFeed>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createOrderingServices(
  pool: PgTransactionalPool,
  options: OrderingServiceOptions = {},
): OrderingServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const notificationOutbox =
    options.notificationOutbox ??
    createPostgresNotificationOutbox({ db });
  const accounts = createOrderingAccountRuntime({ eventStore, checkpointStore, db });
  const notifications = createPostgresWebNotificationFeed({ db });
  const orders = createOrderingOrderRuntime({
    eventStore,
    checkpointStore,
    db,
    shippingQuotePolicy:
      options.shippingQuotePolicy ?? defaultShippingQuotePolicy,
    taxQuoteResolver: options.taxQuoteResolver,
    notificationOutbox,
  });

  return {
    orders,
    notifications,
    projectors: [...accounts.projectors, ...orders.projectors],
    pool,
    db,
  };
}
