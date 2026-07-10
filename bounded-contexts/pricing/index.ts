export { default as contextManifest } from "./context.json";

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { buildPricingApi } from "./api";
import { buildPricingPriceSignalCatalogProjectionHandlers } from "./features/price-signals/integrations/catalog/projection";
import {
  buildPricingCatalogInputProjectionHandlers,
  buildPricingFulfillmentInputProjectionHandlers,
  buildPricingInventoryInputProjectionHandlers,
  buildPricingMarketplaceInputProjectionHandlers,
  buildPricingOrderingInputProjectionHandlers,
} from "./features/recommendations/integrations/source/source-projection";
import { pricingSchemaSql } from "./support/runtime-support/schema";
import { pricingUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { seedPricingDatabase } from "./support/runtime-support/seed";
import type { PricingServices } from "./support/runtime-support/services";
import { createPricingServices } from "./support/runtime-support/services";
import { createPricingRecommendationMcpHandlers } from "./features/recommendations/api/mcp";

export const module = defineBoundedContextModule<PricingServices, PgTransactionalPool, void>({
  manifest: contextManifest,
  schemaSql: pricingSchemaSql,
  schemaMigrations: pricingUnloggedProjectionSchemaMigrations,
  createServices: (pool) => createPricingServices(pool),
  buildApis: (services) => [buildPricingApi(services)],
  buildMcpHandlers: (services) => createPricingRecommendationMcpHandlers(services.recommendations),
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "pricing",
      manifest: contextManifest,
      handlers: {
        "catalog.pricing-catalog-input-projection": () => ({
          ...buildPricingCatalogInputProjectionHandlers(services.db),
          ...buildPricingPriceSignalCatalogProjectionHandlers(services.db),
        }),
        "inventory.pricing-inventory-input-projection": () => buildPricingInventoryInputProjectionHandlers(services.db),
        "marketplace.pricing-market-input-projection": () =>
          buildPricingMarketplaceInputProjectionHandlers(services.db),
        "ordering.pricing-order-input-projection": () => buildPricingOrderingInputProjectionHandlers(services.db),
        "fulfillment.pricing-fulfillment-input-projection": () =>
          buildPricingFulfillmentInputProjectionHandlers(services.db),
      },
    }),
  seed: seedPricingDatabase,
});
