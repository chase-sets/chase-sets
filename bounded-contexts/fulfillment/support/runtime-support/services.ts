import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import { createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import type { PostageLabelProvider, PostageProviderWebhookGateway } from "@chase-sets/postage-labels";
import { createFulfillmentShipmentRuntime } from "../../features/shipments/api/runtime";
import { createFulfillmentReturnShipmentRuntime } from "../../features/return-shipments/api/runtime";

export type FulfillmentServices = Readonly<{
  shipments: ReturnType<typeof createFulfillmentShipmentRuntime>;
  returnShipments: ReturnType<typeof createFulfillmentReturnShipmentRuntime>;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export type FulfillmentHostPorts = Readonly<{
  postageLabelProvider?: PostageLabelProvider;
  postageWebhookGateway?: PostageProviderWebhookGateway;
  notificationOutbox?: NotificationOutbox;
}>;

export function createFulfillmentServices(
  pool: PgTransactionalPool,
  ports?: FulfillmentHostPorts,
): FulfillmentServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "fulfillment" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const notificationOutbox = ports?.notificationOutbox ?? createPostgresNotificationOutbox({ db });
  const shipments = createFulfillmentShipmentRuntime({
    eventStore,
    checkpointStore,
    db,
    postageLabelProvider: ports?.postageLabelProvider,
    postageWebhookGateway: ports?.postageWebhookGateway,
    notificationOutbox,
  });
  const returnShipments = createFulfillmentReturnShipmentRuntime({ eventStore, db });

  return {
    shipments,
    returnShipments,
    projectors: [...shipments.projectors, ...returnShipments.projectors],
    pool,
    db,
  };
}
