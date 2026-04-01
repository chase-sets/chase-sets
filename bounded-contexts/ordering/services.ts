import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { createOrderingCartRuntime } from "./cart/runtime";
import { createOrderingOrderRuntime } from "./orders/runtime";
import {
  createDatabaseMarketplaceSupplyResolver,
  defaultShippingQuotePolicy,
  type InventoryReservationGateway,
  type MarketplaceSupplyResolver,
  type ShippingQuotePolicy,
} from "./policies";

export type OrderingServiceOptions = Readonly<{
  inventoryReservations?: InventoryReservationGateway;
  supplyResolver?: MarketplaceSupplyResolver;
  shippingQuotePolicy?: ShippingQuotePolicy;
}>;

export type OrderingServices = Readonly<{
  cart: ReturnType<typeof createOrderingCartRuntime>;
  orders: ReturnType<typeof createOrderingOrderRuntime>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

function createMissingInventoryReservationGateway(): InventoryReservationGateway {
  const fail = () => {
    throw new Error(
      "Ordering requires an inventory reservation gateway for checkout and cancellation flows.",
    );
  };

  return {
    createReservation: async () => fail(),
    releaseReservation: async () => fail(),
  };
}

export function createOrderingServices(
  pool: PgTransactionalPool,
  options: OrderingServiceOptions = {},
): OrderingServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const cart = createOrderingCartRuntime({ eventStore, checkpointStore, db });
  const orders = createOrderingOrderRuntime({
    eventStore,
    checkpointStore,
    db,
    carts: cart,
    supplyResolver:
      options.supplyResolver ?? createDatabaseMarketplaceSupplyResolver(db),
    shippingQuotePolicy:
      options.shippingQuotePolicy ?? defaultShippingQuotePolicy,
    inventoryReservations:
      options.inventoryReservations ?? createMissingInventoryReservationGateway(),
  });

  return {
    cart,
    orders,
    projectors: [...cart.projectors, ...orders.projectors],
    pool,
    db,
  };
}
