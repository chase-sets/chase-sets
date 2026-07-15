import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type { AppendToStreamsResult } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { BcCreateServicesOptions } from "@chase-sets/bounded-context-module";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createInventoryCatalogItemRuntime } from "../../features/inventory-items/integrations/catalog/runtime";
import { createInventoryHoldRuntime } from "../../features/holds/api/runtime";
import {
  createInventoryImportBatchRuntime,
  type InventoryDraftListingCreator,
} from "../../features/import-batches/api/runtime";
import { createInventoryItemRuntime } from "../../features/inventory-items/api/runtime";
import { createInventoryReservationRuntime } from "../../features/reservations/api/runtime";
import { createRestockDecisionRuntime } from "../../features/restock-decisions/api/runtime";
import { createRecoveredItemRuntime } from "../../features/recovered-items/api/runtime";
import { createStorageLocationRuntime } from "../../features/storage-locations/api/runtime";

export type InventoryServices = Readonly<{
  catalogItems: ReturnType<typeof createInventoryCatalogItemRuntime>;
  storageLocations: ReturnType<typeof createStorageLocationRuntime>;
  items: ReturnType<typeof createInventoryItemRuntime>;
  importBatches: ReturnType<typeof createInventoryImportBatchRuntime>;
  holds: ReturnType<typeof createInventoryHoldRuntime>;
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
}>;

export function createInventoryServices(
  pool: PgTransactionalPool,
  ports: InventoryHostPorts = {},
  options: BcCreateServicesOptions<PgTransactionalPool> = {},
): InventoryServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "inventory" }),
  });
  const appendToStreams = eventStore.appendToStreams;
  if (!appendToStreams) {
    throw new Error("Inventory order reservation workflow requires atomic multi-stream event appends.");
  }
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
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
  const reservations = createInventoryReservationRuntime(deps);
  const restockDecisions = createRestockDecisionRuntime(deps, items, reservations);
  const recoveredItems = createRecoveredItemRuntime(deps);

  return {
    catalogItems,
    storageLocations,
    items,
    importBatches,
    holds,
    reservations,
    restockDecisions,
    recoveredItems,
    appendToStreams,
    projectors: [
      ...catalogItems.projectors,
      ...storageLocations.projectors,
      ...items.projectors,
      ...holds.projectors,
      ...reservations.projectors,
      ...restockDecisions.projectors,
      ...recoveredItems.projectors,
    ],
    pool,
    db,
  };
}
