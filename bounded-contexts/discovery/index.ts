export { default as contextManifest } from "./context.json" with { type: "json" };

import {
  buildEventSubscriptionsFromManifest,
  defineBcProjectionGroupReset,
  defineBoundedContextModule,
  type BcProjectionGroup,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json" with { type: "json" };
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
import { buildDiscoverySavedListPickerProjectionHandlers } from "./features/saved-list-addition/integrations/collections/projection";
import { createDiscoveryServices, type DiscoveryHostPorts } from "./support/runtime-support/services";
import { discoverySchemaMigrations, discoverySchemaSql } from "./support/runtime-support/schema";
import { discoveryUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { createDiscoveryItemMcpHandlers } from "./support/item-support/mcp";

const baseModule = defineBoundedContextModule<DiscoveryServices, PgTransactionalPool, DiscoveryHostPorts>({
  manifest: contextManifest,
  schemaSql: discoverySchemaSql,
  retentionSweeps: discoveryRetentionSweeps,
  schemaMigrations: [...discoveryUnloggedProjectionSchemaMigrations, ...discoverySchemaMigrations],
  createServices: (pool, ports) => createDiscoveryServices(pool, ports),
  buildApis: (services) => [
    { mountPath: "/api/marketplace", contextMountOrdinal: 1, router: buildDiscoveryApi(services) },
  ],
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
        "collections.discovery-saved-list-picker-projection": () =>
          buildDiscoverySavedListPickerProjectionHandlers(services.db),
        "catalog.discovery-category-projection": () => buildDiscoveryCategoryProjectionHandlers(services.db),
        "catalog.discovery-search-item-projection": () => buildDiscoverySearchItemProjectionHandlers(services.db),
        "catalog.discovery-item-detail-projection": () => buildDiscoveryItemDetailProjectionHandlers(services.db),
        "catalog.discovery-google-shopping-feed-row-projection": () =>
          buildGoogleShoppingFeedRowProjectionHandlers(services.db),
        "catalog.discovery-market-projection": () => marketProjectionHandlers,
        "identity.discovery-market-projection": () => marketProjectionHandlers,
        "inventory.discovery-market-projection": () => marketProjectionHandlers,
        "checkout.discovery-market-projection": () => marketProjectionHandlers,
        "marketplace.discovery-market-projection": () => marketProjectionHandlers,
        "ordering.discovery-market-projection": () => marketProjectionHandlers,
        "marketplace.discovery-product-alert-notification-projection": (subscription) =>
          buildProductAlertNotificationProjectionHandlers(
            services.db,
            services.notificationOutbox,
            subscription.projectionName,
          ),
      },
    });
  },
});

function buildDiscoveryProjectionGroups(services: DiscoveryServices): readonly BcProjectionGroup[] {
  return (baseModule.projectionGroups ?? []).map((group) =>
    group.projectionName === "discovery-search-item-projection"
      ? {
          ...group,
          reset: defineBcProjectionGroupReset(services.items.search.rebuildSearchIndex),
        }
      : group,
  );
}

export const module = {
  ...baseModule,
  buildProjectionGroups: buildDiscoveryProjectionGroups,
};
