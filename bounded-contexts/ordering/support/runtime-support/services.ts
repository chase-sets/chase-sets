import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { TransactionalEmailOutbox } from "@chase-sets/communications-email";
import { createPostgresTransactionalEmailOutbox } from "@chase-sets/transactional-email-outbox";
import { createOrderingAccountRuntime } from "../account-support/runtime";
import { createOrderingOrderRuntime } from "../../features/orders/api/runtime";
import type { TaxQuoteResolver } from "../../features/orders/api/runtime";
import { createPostagePolicyRuntime } from "../../features/postage-policies/api/runtime";
import { defaultShippingQuotePolicy, type ShippingQuotePolicy } from "../../features/orders/domain/policies";

export type OrderingServiceOptions = Readonly<{
  shippingQuotePolicy?: ShippingQuotePolicy;
  taxQuoteResolver?: TaxQuoteResolver;
  transactionalEmailOutbox?: TransactionalEmailOutbox;
}>;

export type OrderingServices = Readonly<{
  orders: ReturnType<typeof createOrderingOrderRuntime>;
  postagePolicies: ReturnType<typeof createPostagePolicyRuntime>;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createOrderingServices(
  pool: PgTransactionalPool,
  options: OrderingServiceOptions = {},
): OrderingServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "ordering" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const transactionalEmailOutbox = options.transactionalEmailOutbox ?? createPostgresTransactionalEmailOutbox({ db });
  const accounts = createOrderingAccountRuntime({ eventStore, checkpointStore, db });
  const postagePolicies = createPostagePolicyRuntime({ eventStore, checkpointStore, db });
  const orders = createOrderingOrderRuntime({
    eventStore,
    checkpointStore,
    db,
    shippingQuotePolicy: options.shippingQuotePolicy ?? defaultShippingQuotePolicy,
    postagePolicyResolver: postagePolicies.getActivePolicy,
    taxQuoteResolver: options.taxQuoteResolver,
    transactionalEmailOutbox,
  });

  return {
    orders,
    postagePolicies,
    projectors: [...accounts.projectors, ...postagePolicies.projectors, ...orders.projectors],
    pool,
    db,
  };
}
