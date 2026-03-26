import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type {
  PgTransactionalPool,
  PgQueryable,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { createBlueprintRuntime } from "./blueprints/runtime";
import { createCatalogItemRuntime } from "./catalog-items/runtime";
import { createCategoryRuntime } from "./categories/runtime";
import { createComponentRuntime } from "./components/runtime";
import { createDimensionRuntime } from "./dimensions/runtime";
import { createFieldRuntime } from "./fields/runtime";

export type CatalogServices = Readonly<{
  dimensions: ReturnType<typeof createDimensionRuntime>;
  fields: ReturnType<typeof createFieldRuntime>;
  components: ReturnType<typeof createComponentRuntime>;
  blueprints: ReturnType<typeof createBlueprintRuntime>;
  categories: ReturnType<typeof createCategoryRuntime>;
  items: ReturnType<typeof createCatalogItemRuntime>;
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
  const items = createCatalogItemRuntime(deps);

  return {
    dimensions,
    fields,
    components,
    blueprints,
    categories,
    items,
    projectors: [
      ...dimensions.projectors,
      ...fields.projectors,
      ...components.projectors,
      ...blueprints.projectors,
      ...categories.projectors,
      ...items.projectors,
    ],
    pool,
    db,
  };
}