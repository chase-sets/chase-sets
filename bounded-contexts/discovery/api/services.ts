import { createPostgresEventStore } from "../../../contracts/event-core/postgres/event-store";
import { createPostgresProjectionStore } from "../../../contracts/event-core/postgres/projection-store";
import { createProjector, type Projector } from "../../../contracts/event-core/projector";
import type { PgTransactionalPool, PgQueryable } from "../../../contracts/event-core/postgres/types";
import { buildBlueprintProjectionHandlers } from "./projections/base/blueprint-projection";
import { buildCatalogItemProjectionHandlers } from "./projections/base/catalog-item-projection";
import { buildCategoryProjectionHandlers } from "./projections/base/category-projection";
import { buildComponentProjectionHandlers } from "./projections/base/component-projection";
import { buildDimensionProjectionHandlers } from "./projections/base/dimension-projection";
import { buildFieldProjectionHandlers } from "./projections/base/field-projection";
import { buildDiscoveryCategoryProjectionHandlers } from "./projections/category-projection";
import { buildDiscoveryItemDetailProjectionHandlers } from "./projections/item-detail-projection";
import { buildDiscoverySearchItemProjectionHandlers } from "./projections/search-item-projection";

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
      projectorName: "discovery-base-dimension-projection",
      eventStore,
      checkpointStore,
      handlers: buildDimensionProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-base-field-projection",
      eventStore,
      checkpointStore,
      handlers: buildFieldProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-base-component-projection",
      eventStore,
      checkpointStore,
      handlers: buildComponentProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-base-blueprint-projection",
      eventStore,
      checkpointStore,
      handlers: buildBlueprintProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-base-category-projection",
      eventStore,
      checkpointStore,
      handlers: buildCategoryProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "discovery-base-catalog-item-projection",
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
