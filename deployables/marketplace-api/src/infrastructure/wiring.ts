import { createPostgresEventStore } from "../../../../contracts/event-core/postgres/event-store";
import { createPostgresProjectionStore } from "../../../../contracts/event-core/postgres/projection-store";
import { createProjector, type Projector } from "../../../../contracts/event-core/projector";
import type { PgTransactionalPool } from "../../../../contracts/event-core/postgres/types";
import type { PgQueryable } from "../../../../contracts/event-core/postgres/types";

import { buildDimensionProjectionHandlers } from "../../../catalog-api/src/projections/dimension-projection";
import { buildFieldProjectionHandlers } from "../../../catalog-api/src/projections/field-projection";
import { buildComponentProjectionHandlers } from "../../../catalog-api/src/projections/component-projection";
import { buildBlueprintProjectionHandlers } from "../../../catalog-api/src/projections/blueprint-projection";
import { buildCategoryProjectionHandlers } from "../../../catalog-api/src/projections/category-projection";
import { buildCatalogItemProjectionHandlers } from "../../../catalog-api/src/projections/catalog-item-projection";

import { buildSearchItemProjectionHandlers } from "../projections/search-item-projection";
import { buildItemDetailProjectionHandlers } from "../projections/item-detail-projection";
import { buildMarketplaceCategoryProjectionHandlers } from "../projections/category-projection";

export type MarketplaceServices = Readonly<{
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createMarketplaceServices(pool: PgTransactionalPool): MarketplaceServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;

  const projectors: Projector[] = [
    createProjector({
      projectorName: "marketplace-base-dimension-projection",
      eventStore,
      checkpointStore,
      handlers: buildDimensionProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "marketplace-base-field-projection",
      eventStore,
      checkpointStore,
      handlers: buildFieldProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "marketplace-base-component-projection",
      eventStore,
      checkpointStore,
      handlers: buildComponentProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "marketplace-base-blueprint-projection",
      eventStore,
      checkpointStore,
      handlers: buildBlueprintProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "marketplace-base-category-projection",
      eventStore,
      checkpointStore,
      handlers: buildCategoryProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "marketplace-base-catalog-item-projection",
      eventStore,
      checkpointStore,
      handlers: buildCatalogItemProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "marketplace-search-item-projection",
      eventStore,
      checkpointStore,
      handlers: buildSearchItemProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "marketplace-item-detail-projection",
      eventStore,
      checkpointStore,
      handlers: buildItemDetailProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "marketplace-category-projection",
      eventStore,
      checkpointStore,
      handlers: buildMarketplaceCategoryProjectionHandlers(db),
    }),
  ];

  return {
    projectors,
    pool,
    db,
  };
}
