import { createPostgresEventStore } from "../../contracts/event-core/postgres/event-store";
import { createPostgresProjectionStore } from "../../contracts/event-core/postgres/projection-store";
import { createProjector, type Projector } from "../../contracts/event-core/projector";
import type { PgTransactionalPool, PgQueryable } from "../../contracts/event-core/postgres/types";
import { buildBlueprintProjectionHandlers } from "./catalog-cache/blueprint-projection";
import { buildCatalogItemProjectionHandlers } from "./catalog-cache/catalog-item-projection";
import { buildCategoryProjectionHandlers } from "./catalog-cache/category-projection";
import { buildComponentProjectionHandlers } from "./catalog-cache/component-projection";
import { buildDimensionProjectionHandlers } from "./catalog-cache/dimension-projection";
import { buildFieldProjectionHandlers } from "./catalog-cache/field-projection";
import { buildDiscoveryCategoryProjectionHandlers } from "./categories/projection";
import { buildDiscoveryItemDetailProjectionHandlers } from "./item-detail/projection";
import { buildDiscoverySearchItemProjectionHandlers } from "./search/projection";

export type DiscoveryServices = Readonly<{
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createDiscoveryServices(pool: PgTransactionalPool): DiscoveryServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;

  const projectors: Projector[] = [
    createProjector({
      projectorName: "discovery-catalog-cache-dimension-projection",
      eventStore,
      checkpointStore,
      handlers: buildDimensionProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-catalog-cache-field-projection",
      eventStore,
      checkpointStore,
      handlers: buildFieldProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-catalog-cache-component-projection",
      eventStore,
      checkpointStore,
      handlers: buildComponentProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-catalog-cache-blueprint-projection",
      eventStore,
      checkpointStore,
      handlers: buildBlueprintProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-catalog-cache-category-projection",
      eventStore,
      checkpointStore,
      handlers: buildCategoryProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-catalog-cache-catalog-item-projection",
      eventStore,
      checkpointStore,
      handlers: buildCatalogItemProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-search-item-projection",
      eventStore,
      checkpointStore,
      handlers: buildDiscoverySearchItemProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-item-detail-projection",
      eventStore,
      checkpointStore,
      handlers: buildDiscoveryItemDetailProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-category-projection",
      eventStore,
      checkpointStore,
      handlers: buildDiscoveryCategoryProjectionHandlers(db),
    }),
  ];

  return {
    projectors,
    pool,
    db,
  };
}
