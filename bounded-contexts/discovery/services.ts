import { createPostgresEventStore } from "../../contracts/event-core/postgres/event-store";
import { createPostgresProjectionStore } from "../../contracts/event-core/postgres/projection-store";
import { createProjector, type Projector } from "../../contracts/event-core/projector";
import type { PgTransactionalPool, PgQueryable } from "../../contracts/event-core/postgres/types";
import { buildBlueprintProjectionHandlers } from "./catalog-mirror/blueprint-projection";
import { buildCatalogItemProjectionHandlers } from "./catalog-mirror/catalog-item-projection";
import { buildCategoryProjectionHandlers } from "./catalog-mirror/category-projection";
import { buildComponentProjectionHandlers } from "./catalog-mirror/component-projection";
import { buildDimensionProjectionHandlers } from "./catalog-mirror/dimension-projection";
import { buildFieldProjectionHandlers } from "./catalog-mirror/field-projection";
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
      projectorName: "discovery-catalog-mirror-dimension-projection",
      eventStore,
      checkpointStore,
      handlers: buildDimensionProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-catalog-mirror-field-projection",
      eventStore,
      checkpointStore,
      handlers: buildFieldProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-catalog-mirror-component-projection",
      eventStore,
      checkpointStore,
      handlers: buildComponentProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-catalog-mirror-blueprint-projection",
      eventStore,
      checkpointStore,
      handlers: buildBlueprintProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-catalog-mirror-category-projection",
      eventStore,
      checkpointStore,
      handlers: buildCategoryProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-catalog-mirror-catalog-item-projection",
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
