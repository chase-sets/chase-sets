import { createPostgresEventStore } from "@chase-sets/event-core/postgres/event-store";
import { createPostgresProjectionStore } from "@chase-sets/event-core/postgres/projection-store";
import type {
  PgTransactionalPool,
  PgQueryable,
} from "@chase-sets/event-core/postgres/types";
import type { Projector } from "@chase-sets/event-core/projector";
import { createBlueprintRuntime } from "./blueprints/runtime";
import { createCatalogItemRuntime } from "./catalog-items/runtime";
import { createCategoryRuntime } from "./categories/runtime";
import { createComponentRuntime } from "./components/runtime";
import { createDimensionRuntime } from "./dimensions/runtime";
import { createFieldRuntime } from "./fields/runtime";

export type CatalogServices = Readonly<{
  dimensionHandler: ReturnType<typeof createDimensionRuntime>["dimensionHandler"];
  fieldHandler: ReturnType<typeof createFieldRuntime>["fieldHandler"];
  componentHandler: ReturnType<typeof createComponentRuntime>["componentHandler"];
  blueprintHandler: ReturnType<typeof createBlueprintRuntime>["blueprintHandler"];
  categoryHandler: ReturnType<typeof createCategoryRuntime>["categoryHandler"];
  catalogItemHandler: ReturnType<typeof createCatalogItemRuntime>["catalogItemHandler"];
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createCatalogServices(pool: PgTransactionalPool): CatalogServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const deps = { eventStore, checkpointStore, db } as const;

  const dimensions = createDimensionRuntime(deps);
  const fields = createFieldRuntime(deps);
  const components = createComponentRuntime(deps);
  const blueprints = createBlueprintRuntime(deps);
  const categories = createCategoryRuntime(deps);
  const catalogItems = createCatalogItemRuntime(deps);

  return {
    dimensionHandler: dimensions.dimensionHandler,
    fieldHandler: fields.fieldHandler,
    componentHandler: components.componentHandler,
    blueprintHandler: blueprints.blueprintHandler,
    categoryHandler: categories.categoryHandler,
    catalogItemHandler: catalogItems.catalogItemHandler,
    projectors: [
      ...dimensions.projectors,
      ...fields.projectors,
      ...components.projectors,
      ...blueprints.projectors,
      ...categories.projectors,
      ...catalogItems.projectors,
    ],
    pool,
    db,
  };
}

