import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import type { PostageLabelProvider } from "@chase-sets/postage-labels";
import type { NotificationOutbox } from "@chase-sets/notifications";
import { createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import { createPostgresWebNotificationFeed } from "@chase-sets/web-notifications";
import { createFulfillmentShipmentRuntime } from "../../features/shipments/api/runtime";

export type FulfillmentServices = Readonly<{
  shipments: ReturnType<typeof createFulfillmentShipmentRuntime>;
  notifications: ReturnType<typeof createPostgresWebNotificationFeed>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export type FulfillmentHostPorts = Readonly<{
  postageLabelProvider?: PostageLabelProvider;
  notificationOutbox?: NotificationOutbox;
}>;

export function createFulfillmentServices(
  pool: PgTransactionalPool,
  ports?: FulfillmentHostPorts,
): FulfillmentServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const notificationOutbox =
    ports?.notificationOutbox ??
    createPostgresNotificationOutbox({ db });
  const notifications = createPostgresWebNotificationFeed({ db });
  const shipments = createFulfillmentShipmentRuntime({
    eventStore,
    checkpointStore,
    db,
    postageLabelProvider: ports?.postageLabelProvider,
    notificationOutbox,
  });

  return {
    shipments,
    notifications,
    projectors: [...shipments.projectors],
    pool,
    db,
  };
}
