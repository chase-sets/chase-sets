import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type {
  PgQueryable,
  PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { createInventoryHoldRuntime } from "./holds/runtime";
import { createInventoryRecordRuntime } from "./records/runtime";
import { createStorageLocationRuntime } from "./storage-locations/runtime";

export type InventoryServices = Readonly<{
  storageLocations: ReturnType<typeof createStorageLocationRuntime>;
  records: ReturnType<typeof createInventoryRecordRuntime>;
  holds: ReturnType<typeof createInventoryHoldRuntime>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createInventoryServices(pool: PgTransactionalPool): InventoryServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const deps = { eventStore, checkpointStore, db } as const;

  const storageLocations = createStorageLocationRuntime(deps);
  const records = createInventoryRecordRuntime(deps);
  const holds = createInventoryHoldRuntime(deps);

  return {
    storageLocations,
    records,
    holds,
    projectors: [
      ...storageLocations.projectors,
      ...records.projectors,
      ...holds.projectors,
    ],
    pool,
    db,
  };
}
