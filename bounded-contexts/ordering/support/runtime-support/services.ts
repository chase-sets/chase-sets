import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { createOrderingAccountRuntime } from "../account-support/runtime";
import { createOrderingCartRuntime } from "../../features/cart/api/runtime";
import { createOrderingOrderRuntime } from "../../features/orders/api/runtime";
import {
  defaultShippingQuotePolicy,
  type ShippingQuotePolicy,
} from "../../features/orders/domain/policies";

export type OrderingServiceOptions = Readonly<{
  shippingQuotePolicy?: ShippingQuotePolicy;
}>;

export type OrderingServices = Readonly<{
  cart: ReturnType<typeof createOrderingCartRuntime>;
  orders: ReturnType<typeof createOrderingOrderRuntime>;
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
  const accounts = createOrderingAccountRuntime({ eventStore, checkpointStore, db });
  const cart = createOrderingCartRuntime({ eventStore, checkpointStore, db });
  const orders = createOrderingOrderRuntime({
    eventStore,
    checkpointStore,
    db,
    carts: cart,
    shippingQuotePolicy:
      options.shippingQuotePolicy ?? defaultShippingQuotePolicy,
  });

  return {
    cart,
    orders,
    projectors: [...accounts.projectors, ...cart.projectors, ...orders.projectors],
    pool,
    db,
  };
}
