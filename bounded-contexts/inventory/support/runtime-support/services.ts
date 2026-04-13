import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type {
  PgQueryable,
  PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { createInventoryCatalogItemRuntime } from "../../features/records/integrations/catalog/runtime";
import { createInventoryHoldRuntime } from "../../features/holds/api/runtime";
import { createInventoryRecordRuntime } from "../../features/records/api/runtime";
import { createInventoryReservationRuntime } from "../../features/reservations/api/runtime";
import { createStorageLocationRuntime } from "../../features/storage-locations/api/runtime";

export type InventoryServices = Readonly<{
  catalogItems: ReturnType<typeof createInventoryCatalogItemRuntime>;
  storageLocations: ReturnType<typeof createStorageLocationRuntime>;
  records: ReturnType<typeof createInventoryRecordRuntime>;
  holds: ReturnType<typeof createInventoryHoldRuntime>;
  reservations: ReturnType<typeof createInventoryReservationRuntime>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createInventoryServices(pool: PgTransactionalPool): InventoryServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const deps = { eventStore, checkpointStore, db } as const;

  const catalogItems = createInventoryCatalogItemRuntime(deps);
  const storageLocations = createStorageLocationRuntime(deps);
  const records = createInventoryRecordRuntime(deps, catalogItems);
  const holds = createInventoryHoldRuntime(deps);
  const reservations = createInventoryReservationRuntime(deps);

  return {
    catalogItems,
    storageLocations,
    records,
    holds,
    reservations,
    projectors: [
      ...catalogItems.projectors,
      ...storageLocations.projectors,
      ...records.projectors,
      ...holds.projectors,
      ...reservations.projectors,
    ],
    pool,
    db,
  };
}
