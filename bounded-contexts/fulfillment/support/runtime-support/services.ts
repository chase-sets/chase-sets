import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import type { PostageLabelProvider } from "@chase-sets/postage-labels";
import type { TransactionalEmailGateway } from "@chase-sets/communications-email";
import { createFulfillmentShipmentRuntime } from "../../features/shipments/api/runtime";

export type FulfillmentServices = Readonly<{
  shipments: ReturnType<typeof createFulfillmentShipmentRuntime>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export type FulfillmentHostPorts = Readonly<{
  postageLabelProvider?: PostageLabelProvider;
  transactionalEmailGateway?: TransactionalEmailGateway;
}>;

export function createFulfillmentServices(
  pool: PgTransactionalPool,
  ports?: FulfillmentHostPorts,
): FulfillmentServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const shipments = createFulfillmentShipmentRuntime({
    eventStore,
    checkpointStore,
    db,
    postageLabelProvider: ports?.postageLabelProvider,
    transactionalEmailGateway: ports?.transactionalEmailGateway,
  });

  return {
    shipments,
    projectors: [...shipments.projectors],
    pool,
    db,
  };
}
