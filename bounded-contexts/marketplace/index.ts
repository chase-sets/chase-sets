export { default as contextManifest } from "./context.json";

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import {
  buildMarketplaceAccountProjectionHandlers,
  buildMarketplaceCatalogProjectionHandlers,
  buildMarketplaceInventoryProjectionHandlers,
} from "./features/listings/integrations/supply/supply-projection";
import { buildMarketplaceListingProjectionHandlers } from "./features/listings/read-model/projection";
import {
  buildReviewAccountProjectionHandlers,
  buildReputationOrderProjectionHandlers,
  buildReputationShipmentProjectionHandlers,
  buildReputationSupportProjectionHandlers,
} from "./features/reviews/integrations/source/source-projection";
import type { MarketplaceServiceOptions, MarketplaceServices } from "./support/runtime-support/services";
import { buildMarketplaceApi } from "./api";
import { buildReputationApi } from "./features/reviews/api/http";
import { createMarketplaceServices } from "./support/runtime-support/services";
import { marketplaceSchemaSql } from "./support/runtime-support/schema";
import { seedMarketplaceContextDatabase } from "./support/runtime-support/seed";

export const module = defineBoundedContextModule<MarketplaceServices, PgTransactionalPool, MarketplaceServiceOptions>({
  manifest: contextManifest,
  schemaSql: marketplaceSchemaSql,
  createServices: (pool, options) => createMarketplaceServices(pool, options),
  buildApis: (services) => [buildMarketplaceApi(services), buildReputationApi(services.reviews)],
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
          subscriptionName: "marketplace.reputation-account-projection",
          filterToEventTypes: true,
          buildHandlers: () => accountProjectionHandlers,
        },
        "marketplace.marketplace-listing-projection": {
          subscriptionName: "marketplace.self-listing-projection",
          filterToEventTypes: true,
          buildHandlers: () => buildMarketplaceListingProjectionHandlers(services.db),
        },
        "identity.reputation-account-projection": {
          subscriptionName: "reputation.identity-account-projection",
          buildHandlers: () => buildReviewAccountProjectionHandlers(services.db),
        },
        "ordering.reputation-order-source-projection": {
          subscriptionName: "reputation.order-source-projection",
          buildHandlers: () => buildReputationOrderProjectionHandlers(services.db),
        },
        "fulfillment.reputation-shipment-source-projection": {
          subscriptionName: "reputation.shipment-source-projection",
          buildHandlers: () =>
            buildReputationShipmentProjectionHandlers(services.db, {
              onDeliveredShipment: services.reviews.recordDeliveredShipmentReviewEligibility,
            }),
        },
        "platform-operations.reputation-support-source-projection": {
          subscriptionName: "reputation.support-source-projection",
          buildHandlers: () => buildReputationSupportProjectionHandlers(services.db),
        },
      },
    });
  },
  seed: seedMarketplaceContextDatabase,
});
