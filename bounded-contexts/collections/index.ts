export { default as contextManifest } from "./context.json";

import {
  buildEventSubscriptionsFromManifest,
  defineBoundedContextModule,
  type BcContextManifest,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { buildCollectionsApi } from "./api";
import contextManifest from "./context.json";
import {
  buildSavedListValuationCollectionProjectionHandlers,
  buildSavedListValuationPricingProjectionHandlers,
} from "./features/saved-list-valuation/read-model/projection";
import { buildSavedListCatalogProjectionHandlers } from "./features/saved-lists/integrations/catalog/projection";
import { buildSavedListProjectionHandlers } from "./features/saved-lists/read-model/projection";
import type { CollectionsHostPorts, CollectionsServices } from "./support/runtime-support/services";
import { createCollectionsServices } from "./support/runtime-support/services";
import { collectionsSchemaSql } from "./support/runtime-support/schema";
import { collectionsRetentionSweeps } from "./support/runtime-support/retention-policy";
import { buildSavedListPickerProjectionHandlers } from "./features/saved-lists/read-model/picker-projection";

const collectionsContextManifest = contextManifest as BcContextManifest;

export const module = defineBoundedContextModule<CollectionsServices, PgTransactionalPool, CollectionsHostPorts>({
  manifest: collectionsContextManifest,
  schemaSql: collectionsSchemaSql,
  retentionSweeps: collectionsRetentionSweeps,
  createServices: (pool, ports) => createCollectionsServices(pool, ports),
  buildApis: (services) => [
    { mountPath: "/api/collections", contextMountOrdinal: 1, router: buildCollectionsApi(services) },
  ],
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "collections",
      manifest: collectionsContextManifest,
      handlers: {
        "catalog.collections-catalog-product-projection": () => buildSavedListCatalogProjectionHandlers(services.db),
        "collections.collections-saved-list-projection": () => buildSavedListProjectionHandlers(services.db),
        "collections.collections-saved-list-valuation-projection": () =>
          buildSavedListValuationCollectionProjectionHandlers(services.db),
        "pricing.collections-saved-list-valuation-projection": () =>
          buildSavedListValuationPricingProjectionHandlers(services.db),
        "collections.collections-saved-list-picker-projection": () =>
          buildSavedListPickerProjectionHandlers(services.db),
      },
    }),
  projectionHandlerSets: (services) => services.projectors,
});
