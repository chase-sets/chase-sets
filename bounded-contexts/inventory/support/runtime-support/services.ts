import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type {
  PgQueryable,
  PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { createInventoryCatalogItemRuntime } from "../../features/inventory-items/integrations/catalog/runtime";
import { createInventoryHoldRuntime } from "../../features/holds/api/runtime";
import {
  createInventoryImportBatchRuntime,
  type InventoryDraftListingCreator,
} from "../../features/import-batches/api/runtime";
import { createInventoryItemRuntime } from "../../features/inventory-items/api/runtime";
import { createInventoryReservationRuntime } from "../../features/reservations/api/runtime";
import { createStorageLocationRuntime } from "../../features/storage-locations/api/runtime";

export type InventoryServices = Readonly<{
  catalogItems: ReturnType<typeof createInventoryCatalogItemRuntime>;
  storageLocations: ReturnType<typeof createStorageLocationRuntime>;
  items: ReturnType<typeof createInventoryItemRuntime>;
  importBatches: ReturnType<typeof createInventoryImportBatchRuntime>;
  holds: ReturnType<typeof createInventoryHoldRuntime>;
  reservations: ReturnType<typeof createInventoryReservationRuntime>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export type InventoryHostPorts = Readonly<{
  draftListingCreator?: InventoryDraftListingCreator;
}>;

export function createInventoryServices(
  pool: PgTransactionalPool,
  ports: InventoryHostPorts = {},
): InventoryServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const deps = { eventStore, checkpointStore, db } as const;

  const catalogItems = createInventoryCatalogItemRuntime(deps);
  const storageLocations = createStorageLocationRuntime(deps);
  const items = createInventoryItemRuntime(deps, catalogItems);
  const importBatches = createInventoryImportBatchRuntime({
    db,
    items,
    catalogItems,
    draftListingCreator: ports.draftListingCreator,
  });
  const holds = createInventoryHoldRuntime(deps);
  const reservations = createInventoryReservationRuntime(deps);

  return {
    catalogItems,
    storageLocations,
    items,
    importBatches,
    holds,
    reservations,
    projectors: [
      ...catalogItems.projectors,
      ...storageLocations.projectors,
      ...items.projectors,
      ...holds.projectors,
      ...reservations.projectors,
    ],
    pool,
    db,
  };
}
