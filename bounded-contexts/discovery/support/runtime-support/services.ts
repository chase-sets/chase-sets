import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import type { PgTransactionalPool, PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createDiscoveryCategoryRuntime,
  type DiscoveryCategoryServices,
} from "../../features/categories/api/runtime";
import { createDiscoveryItemRuntime, type DiscoveryItemsServices } from "../item-support/runtime";

export type DiscoveryServices = Readonly<{
  categories: DiscoveryCategoryServices;
  items: DiscoveryItemsServices;
  projectors: readonly Projector[];
  db: PgQueryable;
  pool: PgTransactionalPool;
}>;

export function createDiscoveryServices(pool: PgTransactionalPool): DiscoveryServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const deps = { eventStore, checkpointStore, db } as const;
  const categories = createDiscoveryCategoryRuntime(deps);
  const items = createDiscoveryItemRuntime(deps);

  return {
    categories,
    items,
    projectors: [...items.projectors, ...categories.projectors],
    db,
    pool,
  };
}
