import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type { PgTransactionalPool, PgQueryable } from "@chase-sets/event-core-postgres";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createBlueprintRuntime } from "../../features/blueprints/api/runtime";
import { createCatalogItemRuntime } from "../../features/catalog-items/api/runtime";
import { createCategoryRuntime } from "../../features/categories/api/runtime";
import { createComponentRuntime } from "../../features/components/api/runtime";
import { createDimensionRuntime } from "../../features/dimensions/api/runtime";
import { createDisplayTemplateRuntime } from "../../features/display-templates/api/runtime";
import { createFieldRuntime } from "../../features/fields/api/runtime";
import { createProductMeasureRuntime } from "../../features/product-measures/api/runtime";
import { createReferenceDataRuntime } from "../../features/reference-data/api/runtime";
import { createCatalogProviderIntegrationProfileVersionStore } from "../../features/source-observations/api/provider-integration-profile-store";
import { createSourceObservationRuntime } from "../../features/source-observations/api/runtime";
import type { CatalogAssetStorage } from "../../features/source-observations/api/asset-storage";
import { createCatalogAuthoringBulkJobServices } from "./bulk-authoring-jobs";

export type CatalogHostPorts = Readonly<{
  catalogAssetStorage?: CatalogAssetStorage;
}>;

export type CatalogServices = Readonly<{
  dimensions: ReturnType<typeof createDimensionRuntime>;
  displayTemplates: ReturnType<typeof createDisplayTemplateRuntime>;
  fields: ReturnType<typeof createFieldRuntime>;
  referenceData: ReturnType<typeof createReferenceDataRuntime>;
  components: ReturnType<typeof createComponentRuntime>;
  blueprints: ReturnType<typeof createBlueprintRuntime>;
  categories: ReturnType<typeof createCategoryRuntime>;
  items: ReturnType<typeof createCatalogItemRuntime>;
  productMeasures: ReturnType<typeof createProductMeasureRuntime>;
  providerIntegrationProfiles: ReturnType<typeof createCatalogProviderIntegrationProfileVersionStore>;
  sourceObservations: ReturnType<typeof createSourceObservationRuntime>;
  authoringBulkJobs: ReturnType<typeof createCatalogAuthoringBulkJobServices>;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createCatalogServices(pool: PgTransactionalPool, ports: CatalogHostPorts = {}): CatalogServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const deps = {
    eventStore,
    checkpointStore,
    db,
    assetStorage: ports.catalogAssetStorage,
  } as const;

  const dimensions = createDimensionRuntime(deps);
  const displayTemplates = createDisplayTemplateRuntime(deps);
  const fields = createFieldRuntime(deps);
  const referenceData = createReferenceDataRuntime(deps);
  const components = createComponentRuntime(deps);
  const blueprints = createBlueprintRuntime(deps);
  const categories = createCategoryRuntime(deps);
  const items = createCatalogItemRuntime(deps);
  const productMeasures = createProductMeasureRuntime(deps);
  const providerIntegrationProfiles = createCatalogProviderIntegrationProfileVersionStore(db);
  const sourceObservations = createSourceObservationRuntime(deps, items, referenceData, providerIntegrationProfiles);
  const authoringBulkJobs = createCatalogAuthoringBulkJobServices(db);

  return {
    dimensions,
    displayTemplates,
    fields,
    referenceData,
    components,
    blueprints,
    categories,
    items,
    productMeasures,
    providerIntegrationProfiles,
    sourceObservations,
    authoringBulkJobs,
    projectors: [
      ...dimensions.projectors,
      ...displayTemplates.projectors,
      ...fields.projectors,
      ...referenceData.projectors,
      ...components.projectors,
      ...blueprints.projectors,
      ...categories.projectors,
      ...items.projectors,
      ...productMeasures.projectors,
      ...sourceObservations.projectors,
    ],
    pool,
    db,
  };
}
