import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import {
  createOrderingCommercialTermsResolver,
  type CommercialTermsResolver,
} from "../../api";
import { createOrderingAccountRuntime } from "../account-support/runtime";
import { createOrderingOrderRuntime } from "../../features/orders/api/runtime";
import {
  defaultShippingQuotePolicy,
  type ShippingQuotePolicy,
} from "../../features/orders/domain/policies";

export type OrderingServiceOptions = Readonly<{
  commercialTermsResolver?: CommercialTermsResolver;
  shippingQuotePolicy?: ShippingQuotePolicy;
}>;

export type OrderingServices = Readonly<{
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
  const orders = createOrderingOrderRuntime({
    eventStore,
    checkpointStore,
    db,
    commercialTermsResolver:
      options.commercialTermsResolver ?? createOrderingCommercialTermsResolver(db),
    shippingQuotePolicy:
      options.shippingQuotePolicy ?? defaultShippingQuotePolicy,
  });

  return {
    orders,
    projectors: [...accounts.projectors, ...orders.projectors],
    pool,
    db,
  };
}
