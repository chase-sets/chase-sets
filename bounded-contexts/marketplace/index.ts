export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import {
  buildMarketplaceAccountProjectionHandlers,
  buildMarketplaceCatalogProjectionHandlers,
  buildMarketplaceInventoryProjectionHandlers,
} from "./features/listings/integrations/supply/supply-projection";
import type { MarketplaceServices } from "./support/runtime-support/services";
import { buildMarketplaceApi } from "./api";
import { createMarketplaceServices } from "./support/runtime-support/services";
import { marketplaceSchemaSql } from "./support/runtime-support/schema";
import { seedMarketplaceDatabase } from "./support/runtime-support/seed";

const eventSubscriptions =
  (contextManifest.eventSubscriptions ?? []) as readonly BcEventSubscriptionDeclaration[];
const projectionGroups =
  (contextManifest.projectionGroups ?? []) as readonly BcProjectionGroupDeclaration[];

function getEventSubscription(
  sourceContextName: string,
  projectionName: string,
): BcEventSubscriptionDeclaration {
  const declaration = eventSubscriptions.find(
    (entry) =>
      entry.sourceContextName === sourceContextName &&
      entry.projectionName === projectionName,
  );

  if (!declaration) {
    throw new Error(
      `Marketplace is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

export const module: BcApiModule<MarketplaceServices, PgTransactionalPool, void> = {
  contextName: "marketplace",
  routePrefix: "/api/marketplace",
  streamPrefix: "marketplace.",
  schemaSql: marketplaceSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<MarketplaceServices, PgTransactionalPool, void>["apiMounts"],
  projectionGroups,
  createServices: (pool) => createMarketplaceServices(pool),
  buildApis: (services) => [buildMarketplaceApi(services)],
  projectors: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const catalogSubscription = getEventSubscription(
      "catalog",
      "marketplace-catalog-item-projection",
    );
    const identitySubscription = getEventSubscription(
      "identity",
      "marketplace-identity-account-projection",
    );
    const inventorySubscription = getEventSubscription(
      "inventory",
      "marketplace-inventory-supply-projection",
    );

    return [
      {
        subscriptionName: "marketplace.catalog-item-projection",
        sourceContextName: "catalog",
        projectionName: catalogSubscription.projectionName,
        subscriptionVersion: catalogSubscription.subscriptionVersion,
        handlers: buildMarketplaceCatalogProjectionHandlers(services.db),
        eventTypes: catalogSubscription.eventTypes,
        streamPrefixes: catalogSubscription.streamPrefixes,
        order: catalogSubscription.order,
      },
      {
        subscriptionName: "marketplace.identity-account-projection",
        sourceContextName: "identity",
        projectionName: identitySubscription.projectionName,
        subscriptionVersion: identitySubscription.subscriptionVersion,
        handlers: buildMarketplaceAccountProjectionHandlers(services.db),
        eventTypes: identitySubscription.eventTypes,
        streamPrefixes: identitySubscription.streamPrefixes,
        order: identitySubscription.order,
      },
      {
        subscriptionName: "marketplace.inventory-supply-projection",
        sourceContextName: "inventory",
        projectionName: inventorySubscription.projectionName,
        subscriptionVersion: inventorySubscription.subscriptionVersion,
        handlers: buildMarketplaceInventoryProjectionHandlers(services.db, {
          onRecordChanged: services.listings.reconcileInventoryCapacity,
        }),
        eventTypes: inventorySubscription.eventTypes,
        streamPrefixes: inventorySubscription.streamPrefixes,
        order: inventorySubscription.order,
      },
    ];
  },
  seed: seedMarketplaceDatabase,
};
