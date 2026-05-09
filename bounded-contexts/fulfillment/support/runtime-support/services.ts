import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import type { PostageLabelProvider } from "@chase-sets/postage-labels";
import type { TransactionalEmailOutbox } from "@chase-sets/communications-email";
import { createPostgresTransactionalEmailOutbox } from "@chase-sets/transactional-email-outbox";
import { createFulfillmentShipmentRuntime } from "../../features/shipments/api/runtime";

export type FulfillmentServices = Readonly<{
  shipments: ReturnType<typeof createFulfillmentShipmentRuntime>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export type FulfillmentHostPorts = Readonly<{
  postageLabelProvider?: PostageLabelProvider;
  transactionalEmailOutbox?: TransactionalEmailOutbox;
}>;

export function createFulfillmentServices(
  pool: PgTransactionalPool,
  ports?: FulfillmentHostPorts,
): FulfillmentServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const transactionalEmailOutbox =
    ports?.transactionalEmailOutbox ??
    createPostgresTransactionalEmailOutbox({ db });
  const shipments = createFulfillmentShipmentRuntime({
    eventStore,
    checkpointStore,
    db,
    postageLabelProvider: ports?.postageLabelProvider,
    transactionalEmailOutbox,
  });

  return {
    shipments,
    projectors: [...shipments.projectors],
    pool,
    db,
  };
}
