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
  type InventoryDraftListingCreator,
} from "../../features/import-batches/api/runtime";
import { createInventoryItemRuntime } from "../../features/inventory-items/api/runtime";
import { createInventoryReservationRuntime } from "../../features/reservations/api/runtime";
import { createRestockDecisionRuntime } from "../../features/restock-decisions/api/runtime";
import { createRecoveredItemRuntime } from "../../features/recovered-items/api/runtime";
import { createStorageLocationRuntime } from "../../features/storage-locations/api/runtime";
import {
  createInventoryListingAuthority,
  type InventoryListingAuthorityConsumer,
} from "../../features/channel-allocations/api/listing-authority";

export type InventoryServices = Readonly<{
  listingAuthority: ReturnType<typeof createInventoryListingAuthority>;
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
  draftListingCreator?: InventoryDraftListingCreator;
  listingAuthorityConsumer?: InventoryListingAuthorityConsumer;
}>;

const unavailableListingConsumer: InventoryListingAuthorityConsumer = () => {
  throw new Error("Inventory Listing authority consumer is not mounted; retain outstanding reservations.");
};

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
  listingAuthorityConsumer: InventoryListingAuthorityConsumer = unavailableListingConsumer,
): RecordExternalChannelSale {
  const rawEventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "inventory" }),
  });
  const deps = {
    eventStore: rawEventStore,
    checkpointStore: createPostgresProjectionStore({ db: pool }),
    db: pool,
  } as const;
  const authority = createInventoryListingAuthority(deps, listingAuthorityConsumer);
  const guardedDeps = { ...deps, eventStore: authority.eventStore };
  const holdCollisions = createInventoryHoldCollisionRuntime(guardedDeps);
  return createInventoryExternalChannelSaleRuntime(guardedDeps, holdCollisions).bind(context);
}

export function createInventoryServices(
  pool: PgTransactionalPool,
  ports: InventoryHostPorts = {},
  options: BcCreateServicesOptions<PgTransactionalPool> = {},
): InventoryServices {
  const rawEventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "inventory" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const listingAuthority = createInventoryListingAuthority(
    { eventStore: rawEventStore, checkpointStore, db },
    ports.listingAuthorityConsumer ?? unavailableListingConsumer,
  );
  const eventStore = listingAuthority.eventStore;
  const appendToStreams = eventStore.appendToStreams;
  if (!appendToStreams) {
    throw new Error("Inventory order reservation workflow requires atomic multi-stream event appends.");
  }
  const deps = { eventStore, checkpointStore, db } as const;

  const catalogItems = createInventoryCatalogItemRuntime(deps);
  const storageLocations = createStorageLocationRuntime(deps);
  const items = createInventoryItemRuntime(deps, catalogItems, storageLocations);
  const importBatches = createInventoryImportBatchRuntime({
    db,
    notificationWaiterPool: options.notificationWaiterPool,
    items,
    catalogItems,
    draftListingCreator: ports.draftListingCreator,
  });
  const holds = createInventoryHoldRuntime(deps);
  const holdCleanupAuthority = createInventoryHoldCleanupAuthority({ eventStore, db });
  const reservations = createInventoryReservationRuntime(deps);
  const holdCollisions = createInventoryHoldCollisionRuntime(deps);
  const channelSales = createInventoryExternalChannelSaleRuntime(deps, holdCollisions);
  const channelStockAllocations = createInventoryChannelStockAllocationRuntime(deps);
  const restockDecisions = createRestockDecisionRuntime(deps, items, reservations);
  const recoveredItems = createRecoveredItemRuntime(deps);

  return {
    listingAuthority,
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
