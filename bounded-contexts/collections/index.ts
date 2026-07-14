export { default as contextManifest } from "./context.json";

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { buildCollectionsApi } from "./api";
import contextManifest from "./context.json";
import {
  buildSavedListValuationCollectionProjectionHandlers,
  buildSavedListValuationPricingProjectionHandlers,
} from "./features/saved-list-valuation/read-model/projection";
import type { CollectionsHostPorts, CollectionsServices } from "./support/runtime-support/services";
import { createCollectionsServices } from "./support/runtime-support/services";
import { collectionsSchemaSql } from "./support/runtime-support/schema";

export const module = defineBoundedContextModule<CollectionsServices, PgTransactionalPool, CollectionsHostPorts>({
  manifest: contextManifest,
  schemaSql: collectionsSchemaSql,
  createServices: (pool, ports) => createCollectionsServices(pool, ports),
  buildApis: (services) => [buildCollectionsApi(services)],
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "collections",
      manifest: contextManifest,
      handlers: {
        "collections.collections-saved-list-valuation-projection": () =>
          buildSavedListValuationCollectionProjectionHandlers(services.db),
        "pricing.collections-saved-list-valuation-projection": () =>
          buildSavedListValuationPricingProjectionHandlers(services.db),
      },
    }),
});
