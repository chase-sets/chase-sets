import { createPostgresEventStore } from "../../contracts/event-core/postgres/event-store";
import { createPostgresProjectionStore } from "../../contracts/event-core/postgres/projection-store";
import type { Projector } from "../../contracts/event-core/projector";
import type { PgTransactionalPool, PgQueryable } from "../../contracts/event-core/postgres/types";
import { createCategoryProjectors } from "./categories/runtime";
import { createItemDetailProjectors } from "./item-detail/runtime";
import { createSearchProjectors } from "./search/runtime";

export type DiscoveryServices = Readonly<{
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createDiscoveryServices(pool: PgTransactionalPool): DiscoveryServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const deps = { eventStore, checkpointStore, db } as const;

  return {
    projectors: [
      ...createSearchProjectors(deps),
      ...createItemDetailProjectors(deps),
      ...createCategoryProjectors(deps),
    ],
    pool,
    db,
  };
}
