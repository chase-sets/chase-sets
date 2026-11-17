import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type { AppendToStreamsResult } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { BcCreateServicesOptions } from "@chase-sets/bounded-context-module";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createInventoryCatalogItemRuntime } from "../../features/inventory-items/integrations/catalog/runtime";
import {
  createInventoryChannelStockAllocationRuntime,
  type InventoryChannelStockAllocationServices,
} from "../../features/channel-allocations/api/runtime";
import { createInventoryHoldRuntime } from "../../features/holds/api/runtime";
import {
  createInventoryHoldCleanupAuthority,
  type InventoryHoldCleanupAuthorityServices,
} from "../../features/holds/api/cleanup-authority";
import { createInventoryHoldCollisionRuntime } from "../../features/hold-collisions/api/runtime";
import {
  createInventoryExternalChannelSaleRuntime,
  type InventoryExternalChannelSaleServices,
} from "../../features/channel-sales/api/runtime";
import type { RecordExternalChannelSale } from "../../features/channel-sales/api/contracts";
import {
  createInventoryImportBatchRuntime,
  type InventoryDraftListingDelivery,
} from "../../features/import-batches/api/runtime";
import { createInventoryItemRuntime } from "../../features/inventory-items/api/runtime";
import { createInventoryStockReservations } from "../../features/inventory-items/api/stock-reservations";
import { createInventoryStockAuthority } from "../../features/inventory-items/api/stock-authority";
import type { RecordExternalChannelSaleCommand } from "../../features/channel-sales/api/contracts";
import { createInventoryReservationRuntime } from "../../features/reservations/api/runtime";
import { createRestockDecisionRuntime } from "../../features/restock-decisions/api/runtime";
import { createRecoveredItemRuntime } from "../../features/recovered-items/api/runtime";
import { createStorageLocationRuntime } from "../../features/storage-locations/api/runtime";
import { createInventoryMutationRuntime } from "./mutation-attempt";
import type { InventoryCheckoutReservationAuthority } from "../../features/holds/api/checkout-reservation-authority";
import {
  recoverInventoryHolds,
  recoverInventoryItems,
  recoverInventoryReductions,
  recoverStorageLocations,
  recoverRestockDecisions,
  recoverInventoryImportCreates,
} from "./recovery-services";

export type InventoryServices = Readonly<{
  mutations: ReturnType<typeof createInventoryMutationRuntime>;
  checkoutReservationAuthority?: InventoryCheckoutReservationAuthority;
  catalogItems: ReturnType<typeof createInventoryCatalogItemRuntime>;
  storageLocations: ReturnType<typeof createStorageLocationRuntime>;
  items: ReturnType<typeof createInventoryItemRuntime>;
  importBatches: ReturnType<typeof createInventoryImportBatchRuntime>;
  holds: ReturnType<typeof createInventoryHoldRuntime>;
  /**
   * Read-only Hold/reservation cleanup authority. It appends no
   * event and reads no projection; Ordering consumes it through an
   * Ordering-owned host capability.
   */
  holdCleanupAuthority: InventoryHoldCleanupAuthorityServices;
  holdCollisions: ReturnType<typeof createInventoryHoldCollisionRuntime>;
  channelSales: InventoryExternalChannelSaleServices;
  channelStockAllocations: InventoryChannelStockAllocationServices;
  reservations: ReturnType<typeof createInventoryReservationRuntime>;
  restockDecisions: ReturnType<typeof createRestockDecisionRuntime>;
  recoveredItems: ReturnType<typeof createRecoveredItemRuntime>;
  appendToStreams: (inputs: readonly AppendToStreamInput[]) => Promise<readonly AppendToStreamsResult[]>;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export type InventoryHostPorts = Readonly<{
  stockReservationConsumerPool?: PgTransactionalPool;
  checkoutReservationAuthority?: InventoryCheckoutReservationAuthority;
  draftListingDelivery?: InventoryDraftListingDelivery;
  importProductRollout?: Readonly<{ normalizationEnabled: boolean; stockProgressionEnabled: boolean }>;
}>;

/**
 * Builds the Inventory cleanup authority against a bare Inventory pool.
 *
 * The composition root binds this to Ordering's own port type, so the two
 * contexts stay decoupled while a payload or identity drift becomes a
 * typecheck error instead of a runtime throw.
 */
export function createInventoryHoldCleanupAuthorityForPool(
  pool: PgTransactionalPool,
): InventoryHoldCleanupAuthorityServices {
  return createInventoryHoldCleanupAuthority({ eventStore: createPostgresEventStore({ pool }), db: pool });
}

/**
 * Binds the existing Inventory external-channel-sale runtime to an explicitly
 * account-scoped event-store context for a host composition root.
 */
export function createInventoryExternalChannelSaleRecorderForPool(
  pool: PgTransactionalPool,
  context: EventStoreContext,
  consumerPool?: PgTransactionalPool,
): RecordExternalChannelSale {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "inventory" }),
  });
  const stockReservations = createInventoryStockReservations(pool, eventStore, consumerPool);
  const deps = {
    eventStore: stockReservations.persistence,
    stockReservations,
    checkpointStore: createPostgresProjectionStore({ db: pool }),
    db: pool,
  } as const;
  const holdCollisions = createInventoryHoldCollisionRuntime(deps);
  return createInventoryExternalChannelSaleRuntime(deps, holdCollisions).bind(context);
}

export function createInventoryServices(
  pool: PgTransactionalPool,
  ports: InventoryHostPorts = {},
  options: BcCreateServicesOptions<PgTransactionalPool> = {},
): InventoryServices {
  const postgresEventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "inventory" }),
  });
  const stockReservations = createInventoryStockReservations(
    pool,
    postgresEventStore,
    ports.stockReservationConsumerPool,
  );
  const mutations = createInventoryMutationRuntime(pool, postgresEventStore, stockReservations);
  const { eventStore } = mutations;
  const appendToStreams = eventStore.appendToStreams;
  if (!appendToStreams) {
    throw new Error("Inventory order reservation workflow requires atomic multi-stream event appends.");
  }
  const checkpointStore = createPostgresProjectionStore({ db: mutations.db });
  const db: PgQueryable = mutations.db;
  const deps = { eventStore, checkpointStore, db, mutationChild: mutations.child, stockReservations } as const;

  const catalogItems = createInventoryCatalogItemRuntime(deps);
  const storageLocations = recoverStorageLocations(createStorageLocationRuntime(deps), mutations);
  const pendingStorageLocations = createStorageLocationRuntime(deps);
  const pendingItems = createInventoryItemRuntime(deps, catalogItems, pendingStorageLocations);
  const items = recoverInventoryItems(createInventoryItemRuntime(deps, catalogItems, storageLocations), mutations);
  const importBatches = recoverInventoryImportCreates(
    createInventoryImportBatchRuntime({
      db,
      notificationWaiterPool: options.notificationWaiterPool,
      items: pendingItems,
      rowItems: items,
      catalogItems,
      draftListingDelivery: ports.draftListingDelivery,
      importProductRollout: ports.importProductRollout,
      executeMutation: mutations.execute,
    }),
    mutations,
  );
  const holds = recoverInventoryHolds(createInventoryHoldRuntime(deps), mutations);
  const holdCleanupAuthority = createInventoryHoldCleanupAuthority({ eventStore, db });
  const reservations = createInventoryReservationRuntime(deps);
  const rawHoldCollisions = createInventoryHoldCollisionRuntime(deps);
  const holdCollisions = recoverInventoryReductions(rawHoldCollisions, mutations);
  const channelSales = createInventoryExternalChannelSaleRuntime(deps, rawHoldCollisions);
  const channelStockAllocations = createInventoryChannelStockAllocationRuntime(deps);
  const restockDecisions = recoverRestockDecisions(createRestockDecisionRuntime(deps, pendingItems), mutations);
  const recoveredItems = createRecoveredItemRuntime(deps);

  return {
    mutations,
    checkoutReservationAuthority: ports.checkoutReservationAuthority,
    catalogItems,
    storageLocations,
    items,
    importBatches,
    holds,
    holdCleanupAuthority,
    holdCollisions,
    channelSales,
    channelStockAllocations,
    reservations,
    restockDecisions,
    recoveredItems,
    appendToStreams,
    projectors: [
      ...catalogItems.projectors,
      ...storageLocations.projectors,
      ...items.projectors,
      ...holds.projectors,
      ...holdCollisions.projectors,
      ...channelStockAllocations.projectors,
      ...reservations.projectors,
      ...restockDecisions.projectors,
      ...recoveredItems.projectors,
    ],
    pool,
    db,
  };
}

/** Owner capability only. Marketplace abort-port and host wiring are composed separately. */
export function createInventoryStockAuthorityForPool(pool: PgTransactionalPool, consumerPool?: PgTransactionalPool) {
  const store = createPostgresEventStore({ pool });
  const reservations = createInventoryStockReservations(pool, store, consumerPool);
  return {
    ...createInventoryStockAuthority(pool, store, reservations),
    status: reservations.status,
    invalidateStock: reservations.invalidateStock,
    async settleInboundSale(evidenceId: string) {
      const result = await pool.query<{
        payload: { command: RecordExternalChannelSaleCommand; context: EventStoreContext };
      }>("SELECT payload FROM event_owner_stream_inbound_evidence WHERE evidence_id = $1", [evidenceId]);
      if (result.rows.length !== 1) throw new Error("Inventory inbound sale evidence unavailable.");
      const { command, context } = result.rows[0].payload;
      const services = createInventoryServices(pool, { stockReservationConsumerPool: consumerPool });
      return services.channelSales.record(command, context);
    },
  };
}
