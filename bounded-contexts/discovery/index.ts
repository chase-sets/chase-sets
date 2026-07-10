export { default as contextManifest } from "./context.json";

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { discoveryRetentionSweeps } from "./support/runtime-support/retention-policy";
import type { DiscoveryServices } from "./support/runtime-support/services";
import { buildDiscoveryApi } from "./api";
import { buildDiscoveryCategoryProjectionHandlers } from "./features/categories/read-model/projection";
import { buildDiscoveryItemDetailProjectionHandlers } from "./features/item-detail/read-model/projection";
import { buildProductAlertNotificationProjectionHandlers } from "./features/product-alerts/integrations/notifications/notification-projector";
import { buildProductAlertPageProjectionHandlers } from "./features/product-alerts/read-model/projection";
import { buildGoogleShoppingFeedRowProjectionHandlers } from "./features/google-shopping-operations/api/projection";
import { buildDiscoveryMarketProjectionHandlers } from "./support/market-support/projection";
import { buildDiscoverySearchItemProjectionHandlers } from "./features/search/read-model/projection";
import { createDiscoveryServices, type DiscoveryHostPorts } from "./support/runtime-support/services";
import { discoverySchemaMigrations, discoverySchemaSql } from "./support/runtime-support/schema";
import { discoveryUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { createDiscoveryItemMcpHandlers } from "./support/item-support/mcp";

export const module = defineBoundedContextModule<DiscoveryServices, PgTransactionalPool, DiscoveryHostPorts>({
  manifest: contextManifest,
  schemaSql: discoverySchemaSql,
  retentionSweeps: discoveryRetentionSweeps,
  schemaMigrations: [...discoveryUnloggedProjectionSchemaMigrations, ...discoverySchemaMigrations],
  createServices: (pool, ports) => createDiscoveryServices(pool, ports),
  buildApis: (services) => [buildDiscoveryApi(services)],
  buildMcpHandlers: (services) => createDiscoveryItemMcpHandlers(services.items),
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const marketProjectionHandlers = buildDiscoveryMarketProjectionHandlers(services.db);

    // Search/detail rebuild large buyer-facing documents from Catalog facts.
    // Their manifest declarations intentionally use a larger projection budget
    // and one-event transaction chunks so deterministic bulk replays do not park poison.
    return buildEventSubscriptionsFromManifest({
      contextName: "discovery",
      manifest: contextManifest,
      handlers: {
        "discovery.discovery-product-alert-page-projection": () => buildProductAlertPageProjectionHandlers(services.db),
        "catalog.discovery-category-projection": {
          subscriptionName: "discovery.catalog-category-projection",
          buildHandlers: () => buildDiscoveryCategoryProjectionHandlers(services.db),
        },
        "catalog.discovery-search-item-projection": {
          subscriptionName: "discovery.catalog-search-projection",
          buildHandlers: () => buildDiscoverySearchItemProjectionHandlers(services.db),
        },
        "catalog.discovery-item-detail-projection": {
          subscriptionName: "discovery.catalog-detail-projection",
          buildHandlers: () => buildDiscoveryItemDetailProjectionHandlers(services.db),
        },
        "catalog.discovery-google-shopping-feed-row-projection": {
          subscriptionName: "discovery.catalog-google-shopping-feed-row-projection",
          buildHandlers: () => buildGoogleShoppingFeedRowProjectionHandlers(services.db),
        },
        "catalog.discovery-market-projection": {
          subscriptionName: "discovery.catalog-market-projection",
          filterToEventTypes: true,
          buildHandlers: () => marketProjectionHandlers,
        },
        "identity.discovery-market-projection": {
          subscriptionName: "discovery.identity-market-projection",
          filterToEventTypes: true,
          buildHandlers: () => marketProjectionHandlers,
        },
        "inventory.discovery-market-projection": {
          subscriptionName: "discovery.inventory-market-projection",
          filterToEventTypes: true,
          buildHandlers: () => marketProjectionHandlers,
        },
        "checkout.discovery-market-projection": {
          subscriptionName: "discovery.checkout-market-projection",
          filterToEventTypes: true,
          buildHandlers: () => marketProjectionHandlers,
        },
        "marketplace.discovery-market-projection": {
          subscriptionName: "discovery.marketplace-market-projection",
          filterToEventTypes: true,
          buildHandlers: () => marketProjectionHandlers,
        },
        "marketplace.discovery-product-alert-notification-projection": {
          subscriptionName: "discovery.marketplace-product-alert-notifications",
          buildHandlers: (subscription) =>
            buildProductAlertNotificationProjectionHandlers(
              services.db,
              services.notificationOutbox,
              subscription.projectionName,
            ),
        },
      },
    });
  },
});
