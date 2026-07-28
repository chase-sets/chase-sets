export { default as contextManifest } from "./context.json";

import {
  buildEventReactionsFromManifest,
  buildEventSubscriptionsFromManifest,
  defineBoundedContextModule,
  type BcContextManifest,
} from "@chase-sets/bounded-context-module";
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
import { buildPricingMarketTradesProjectionHandlers } from "./features/market-trades/integrations/source/source-projection";
import {
  buildPricingMarketTradesAuthenticityIntegrityProjectionHandlers,
  buildPricingMarketTradesIdentityIntegrityProjectionHandlers,
  buildPricingMarketTradesPaymentsIntegrityProjectionHandlers,
  buildPricingMarketTradesSettlementIntegrityProjectionHandlers,
} from "./features/market-trades/integrations/integrity/integrity-projection";
import { pricingFeatureSchemaMigrations, pricingSchemaSql } from "./support/runtime-support/schema";
import { pricingUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { seedPricingDatabase } from "./support/runtime-support/seed";
import type { PricingServices } from "./support/runtime-support/services";
import { createPricingServices } from "./support/runtime-support/services";
import { createPricingRecommendationMcpHandlers } from "./features/recommendations/api/mcp";
import {
  buildCompetingAskRepricingReactionHandlers,
  buildMarketPriceRepricingReactionHandlers,
} from "./features/repricing-engine/integrations/signal-reactions";

const pricingContextManifest = contextManifest as BcContextManifest;

export const module = defineBoundedContextModule<PricingServices, PgTransactionalPool, void>({
  manifest: pricingContextManifest,
  schemaSql: pricingSchemaSql,
  schemaMigrations: [...pricingUnloggedProjectionSchemaMigrations, ...pricingFeatureSchemaMigrations],
  createServices: (pool) => createPricingServices(pool),
  buildApis: (services) => [buildPricingApi(services)],
  buildMcpHandlers: (services) => createPricingRecommendationMcpHandlers(services.recommendations),
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const marketTradesHandlers = buildPricingMarketTradesProjectionHandlers(services.db);

    return [
      ...buildEventSubscriptionsFromManifest({
        contextName: "pricing",
        manifest: pricingContextManifest,
        handlers: {
          "catalog.pricing-catalog-input-projection": () => ({
            ...buildPricingCatalogInputProjectionHandlers(services.db),
            ...buildPricingPriceSignalCatalogProjectionHandlers(services.db),
          }),
          "inventory.pricing-inventory-input-projection": () =>
            buildPricingInventoryInputProjectionHandlers(services.db),
          "marketplace.pricing-market-input-projection": () =>
            buildPricingMarketplaceInputProjectionHandlers(services.db),
          "ordering.pricing-order-input-projection": () => buildPricingOrderingInputProjectionHandlers(services.db),
          "fulfillment.pricing-fulfillment-input-projection": () =>
            buildPricingFulfillmentInputProjectionHandlers(services.db),
          "ordering.pricing-market-trades-projection": () => marketTradesHandlers,
          "fulfillment.pricing-market-trades-projection": () => marketTradesHandlers,
          "identity.pricing-market-trades-projection": () =>
            buildPricingMarketTradesIdentityIntegrityProjectionHandlers(services.db),
          "payments.pricing-market-trades-projection": () =>
            buildPricingMarketTradesPaymentsIntegrityProjectionHandlers(services.db),
          "settlement.pricing-market-trades-projection": () =>
            buildPricingMarketTradesSettlementIntegrityProjectionHandlers(services.db),
          "authenticity.pricing-market-trades-projection": () =>
            buildPricingMarketTradesAuthenticityIntegrityProjectionHandlers(services.db),
        },
      }),
      ...buildEventReactionsFromManifest({
        contextName: "pricing",
        manifest: pricingContextManifest,
        handlers: {
          "marketplace.pricing-repricing-evaluation-reaction": () =>
            buildCompetingAskRepricingReactionHandlers(services.repricingEngine),
          "pricing.pricing-repricing-evaluation-reaction": () =>
            buildMarketPriceRepricingReactionHandlers(services.repricingEngine),
        },
      }),
    ];
  },
  seed: seedPricingDatabase,
});
