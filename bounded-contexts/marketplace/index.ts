export { default as contextManifest } from "./context.json";

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import {
  buildMarketplaceAccountProjectionHandlers,
  buildMarketplaceCatalogProjectionHandlers,
  buildMarketplaceInventoryProjectionHandlers,
} from "./features/listings/integrations/supply/supply-projection";
import { buildMarketplaceSettlementNegativeBalanceProjectionHandlers } from "./features/listings/integrations/settlement/negative-balance-projection";
import { buildMarketplaceListingProjectionHandlers } from "./features/listings/read-model/projection";
import { createMarketplaceListingMcpHandlers } from "./features/listings/api/mcp";
import { createMarketplaceOfferMcpHandlers } from "./features/offers/api/mcp";
import { createMarketplaceReviewMcpHandlers } from "./features/reviews/api/mcp";
import {
  buildReviewAccountProjectionHandlers,
  buildReviewOrderSourceProjectionHandlers,
  buildReviewShipmentSourceProjectionHandlers,
  buildReviewSupportSourceProjectionHandlers,
} from "./features/reviews/integrations/source/source-projection";
import type { MarketplaceServiceOptions, MarketplaceServices } from "./support/runtime-support/services";
import { buildMarketplaceApi } from "./api";
import { buildReviewApi } from "./features/reviews/api/http";
import { createMarketplaceServices } from "./support/runtime-support/services";
import { marketplaceSchemaSql } from "./support/runtime-support/schema";
import { seedMarketplaceContextDatabase } from "./support/runtime-support/seed";

export const module = defineBoundedContextModule<MarketplaceServices, PgTransactionalPool, MarketplaceServiceOptions>({
  manifest: contextManifest,
  schemaSql: marketplaceSchemaSql,
  createServices: (pool, options) => createMarketplaceServices(pool, options),
  buildApis: (services) => [buildMarketplaceApi(services), buildReviewApi(services.reviews)],
  buildMcpHandlers: (services) => {
    const listings = createMarketplaceListingMcpHandlers(services.listings);
    const offers = createMarketplaceOfferMcpHandlers(services.offers);
    const reviews = createMarketplaceReviewMcpHandlers(services.reviews);

    return {
      toolHandlers: {
        ...listings.toolHandlers,
        ...offers.toolHandlers,
        ...reviews.toolHandlers,
      },
      resourceHandlers: {
        ...listings.resourceHandlers,
        ...offers.resourceHandlers,
        ...reviews.resourceHandlers,
      },
    };
  },
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const accountProjectionHandlers = buildMarketplaceAccountProjectionHandlers(services.db);

    return buildEventSubscriptionsFromManifest({
      contextName: "marketplace",
      manifest: contextManifest,
      handlers: {
        "catalog.marketplace-catalog-item-projection": () => buildMarketplaceCatalogProjectionHandlers(services.db),
        "catalog.marketplace-listing-projection": {
          filterToEventTypes: true,
          buildHandlers: () => buildMarketplaceListingProjectionHandlers(services.db),
        },
        "identity.marketplace-identity-account-projection": {
          filterToEventTypes: true,
          buildHandlers: () => accountProjectionHandlers,
        },
        "inventory.marketplace-inventory-supply-projection": () =>
          buildMarketplaceInventoryProjectionHandlers(services.db, {
            onInventoryItemChanged: services.listings.reconcileInventoryCapacity,
          }),
        "marketplace.marketplace-identity-account-projection": {
          subscriptionName: "marketplace.review-account-projection",
          filterToEventTypes: true,
          buildHandlers: () => accountProjectionHandlers,
        },
        "marketplace.marketplace-listing-projection": {
          subscriptionName: "marketplace.self-listing-projection",
          filterToEventTypes: true,
          buildHandlers: () => buildMarketplaceListingProjectionHandlers(services.db),
        },
        "identity.marketplace-review-account-source-projection": {
          subscriptionName: "marketplace.review-account-source-projection",
          buildHandlers: () => buildReviewAccountProjectionHandlers(services.db),
        },
        "ordering.marketplace-review-order-source-projection": {
          subscriptionName: "marketplace.review-order-source-projection",
          buildHandlers: () => buildReviewOrderSourceProjectionHandlers(services.db),
        },
        "fulfillment.marketplace-review-shipment-source-projection": {
          subscriptionName: "marketplace.review-shipment-source-projection",
          buildHandlers: () =>
            buildReviewShipmentSourceProjectionHandlers(services.db, {
              onDeliveredShipment: services.reviews.recordDeliveredShipmentReviewEligibility,
            }),
        },
        "platform-operations.marketplace-review-support-source-projection": {
          subscriptionName: "marketplace.review-support-source-projection",
          buildHandlers: () => buildReviewSupportSourceProjectionHandlers(services.db),
        },
        "settlement.marketplace-settlement-negative-balance-projection": {
          buildHandlers: () => buildMarketplaceSettlementNegativeBalanceProjectionHandlers(services.listings),
          filterToEventTypes: true,
        },
      },
    });
  },
  seed: seedMarketplaceContextDatabase,
});
