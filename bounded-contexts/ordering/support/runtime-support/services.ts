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
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createOrderingAccountRuntime } from "../account-support/runtime";
import { createOrderingOrderRuntime } from "../../features/orders/api/runtime";
import type { TaxQuoteResolver } from "../../features/orders/api/runtime";
import { createPostagePolicyRuntime } from "../../features/postage-policies/api/runtime";
import { defaultShippingQuotePolicy, type ShippingQuotePolicy } from "../../features/orders/domain/policies";
import { shippingRatesPolicy } from "../../features/orders/domain/shipping-rates";
import type { AuthenticityFeePolicyResolver } from "../../features/orders/api/authenticity-fee-policy-resolver";
import {
  assertOrderingInventoryCleanupAuthorityCapability,
  type OrderingInventoryCleanupAuthorityCapability,
} from "../../features/orders/api/cleanup-authority";

export type OrderingServiceOptions = Readonly<{
  shippingQuotePolicy?: ShippingQuotePolicy;
  taxQuoteResolver?: TaxQuoteResolver;
  notificationOutbox?: NotificationOutbox;
  authenticityFeePolicyResolver?: AuthenticityFeePolicyResolver;
  /**
   * Required host capability. Every host states one of two explicit
   * variants: it either mounts the Inventory cleanup authority or it does
   * not. There is no optional, defaulted, or `undefined` form -- an
   * unsupplied nonoptional port would silently resolve to `undefined` and
   * read as "mounted", so Ordering fails boot rather than constructing a
   * placeholder.
   */
  inventoryCleanupAuthority: OrderingInventoryCleanupAuthorityCapability;
}>;

export type OrderingServices = Readonly<{
  orders: ReturnType<typeof createOrderingOrderRuntime>;
  postagePolicies: ReturnType<typeof createPostagePolicyRuntime>;
  policies: PolicyRuntime;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createOrderingServices(pool: PgTransactionalPool, options: OrderingServiceOptions): OrderingServices {
  const inventoryCleanupAuthority = assertOrderingInventoryCleanupAuthorityCapability(
    options?.inventoryCleanupAuthority,
  );
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "ordering" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const notificationOutbox = options.notificationOutbox ?? createPostgresNotificationOutbox({ db });
  const accounts = createOrderingAccountRuntime({ eventStore, checkpointStore, db });
  const postagePolicies = createPostagePolicyRuntime({ eventStore, checkpointStore, db });
  const policies = createPolicyRuntime({ eventStore, db, commitSourceContextName: "ordering" });
  const orders = createOrderingOrderRuntime({
    eventStore,
    checkpointStore,
    db: pool,
    shippingQuotePolicy: options.shippingQuotePolicy ?? defaultShippingQuotePolicy,
    postagePolicyResolver: postagePolicies.getActivePolicy,
    shippingRatesResolver: async () => (await policies.resolvePolicy(shippingRatesPolicy)).value,
    taxQuoteResolver: options.taxQuoteResolver,
    notificationOutbox,
    authenticityFeePolicyResolver: options.authenticityFeePolicyResolver,
    inventoryCleanupAuthority,
  });

  return {
    orders,
    postagePolicies,
    policies,
    projectors: [...accounts.projectors, ...postagePolicies.projectors, ...orders.projectors, ...policies.projectors],
    pool,
    db,
  };
}
