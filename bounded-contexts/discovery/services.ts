import { createPostgresEventStore } from "@chase-sets/event-core/postgres/event-store";
import { createPostgresProjectionStore } from "@chase-sets/event-core/postgres/projection-store";
import type { Projector } from "@chase-sets/event-core/projector";
import type { PgTransactionalPool, PgQueryable } from "@chase-sets/event-core/postgres/types";
import {
  createDiscoveryCategoryRuntime,
  type DiscoveryCategoryServices,
} from "./categories/runtime";
import { createDiscoveryItemRuntime, type DiscoveryItemServices } from "./items/runtime";

export type DiscoveryServices = Readonly<{
  categories: DiscoveryCategoryServices;
  items: DiscoveryItemServices;
  projectors: readonly Projector[];
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
  };
}

