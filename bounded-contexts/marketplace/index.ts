export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import {
  buildMarketplaceAccountProjectionHandlers,
  buildMarketplaceCatalogProjectionHandlers,
  buildMarketplaceInventoryProjectionHandlers,
} from "./features/listings/integrations/supply/supply-projection";
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

const eventSubscriptions = (contextManifest.eventSubscriptions ?? []) as readonly BcEventSubscriptionDeclaration[];
const projectionGroups = (contextManifest.projectionGroups ?? []) as readonly BcProjectionGroupDeclaration[];

function getEventSubscription(sourceContextName: string, projectionName: string): BcEventSubscriptionDeclaration {
  const declaration = eventSubscriptions.find(
    (entry) => entry.sourceContextName === sourceContextName && entry.projectionName === projectionName,
  );

  if (!declaration) {
    throw new Error(
      `Marketplace is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

function selectSubscriptionHandlers(
  handlers: ProjectorHandlerMap,
  eventTypes: readonly string[] | undefined,
): ProjectorHandlerMap {
  if (!eventTypes) {
    return handlers;
  }

  return Object.fromEntries(
    eventTypes.flatMap((eventType) => (handlers[eventType] ? [[eventType, handlers[eventType]]] : [])),
  );
}

export const module: BcApiModule<MarketplaceServices, PgTransactionalPool, MarketplaceServiceOptions> = {
  contextName: "marketplace",
  routePrefix: "/api/marketplace",
  streamPrefix: "marketplace.",
  schemaSql: marketplaceSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<
    MarketplaceServices,
    PgTransactionalPool,
    MarketplaceServiceOptions
  >["apiMounts"],
  projectionGroups,
  createServices: (pool, options) => createMarketplaceServices(pool, options),
  buildApis: (services) => [buildMarketplaceApi(services), buildReputationApi(services.reviews)],
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const catalogSubscription = getEventSubscription("catalog", "marketplace-catalog-item-projection");
    const identitySubscription = getEventSubscription("identity", "marketplace-identity-account-projection");
    const inventorySubscription = getEventSubscription("inventory", "marketplace-inventory-supply-projection");
    const reputationSubscription = getEventSubscription("marketplace", "marketplace-identity-account-projection");
    const reviewIdentitySubscription = getEventSubscription("identity", "reputation-account-projection");
    const reviewOrderSubscription = getEventSubscription("ordering", "reputation-order-source-projection");
    const reviewShipmentSubscription = getEventSubscription("fulfillment", "reputation-shipment-source-projection");
    const reviewSupportSubscription = getEventSubscription("platform-operations", "reputation-support-source-projection");
    const accountProjectionHandlers = buildMarketplaceAccountProjectionHandlers(services.db);

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
        handlers: selectSubscriptionHandlers(accountProjectionHandlers, identitySubscription.eventTypes),
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
          onInventoryItemChanged: services.listings.reconcileInventoryCapacity,
        }),
        eventTypes: inventorySubscription.eventTypes,
        streamPrefixes: inventorySubscription.streamPrefixes,
        order: inventorySubscription.order,
      },
      {
        subscriptionName: "marketplace.reputation-account-projection",
        sourceContextName: "marketplace",
        projectionName: reputationSubscription.projectionName,
        subscriptionVersion: reputationSubscription.subscriptionVersion,
        handlers: selectSubscriptionHandlers(accountProjectionHandlers, reputationSubscription.eventTypes),
        eventTypes: reputationSubscription.eventTypes,
        streamPrefixes: reputationSubscription.streamPrefixes,
        order: reputationSubscription.order,
      },
      {
        subscriptionName: "reputation.identity-account-projection",
        sourceContextName: "identity",
        projectionName: reviewIdentitySubscription.projectionName,
        subscriptionVersion: reviewIdentitySubscription.subscriptionVersion,
        handlers: buildReviewAccountProjectionHandlers(services.db),
        eventTypes: reviewIdentitySubscription.eventTypes,
        streamPrefixes: reviewIdentitySubscription.streamPrefixes,
        order: reviewIdentitySubscription.order,
      },
      {
        subscriptionName: "reputation.order-source-projection",
        sourceContextName: "ordering",
        projectionName: reviewOrderSubscription.projectionName,
        subscriptionVersion: reviewOrderSubscription.subscriptionVersion,
        handlers: buildReputationOrderProjectionHandlers(services.db),
        eventTypes: reviewOrderSubscription.eventTypes,
        streamPrefixes: reviewOrderSubscription.streamPrefixes,
        order: reviewOrderSubscription.order,
      },
      {
        subscriptionName: "reputation.shipment-source-projection",
        sourceContextName: "fulfillment",
        projectionName: reviewShipmentSubscription.projectionName,
        subscriptionVersion: reviewShipmentSubscription.subscriptionVersion,
        handlers: buildReputationShipmentProjectionHandlers(services.db, {
          onDeliveredShipment: services.reviews.recordDeliveredShipmentReviewEligibility,
        }),
        eventTypes: reviewShipmentSubscription.eventTypes,
        streamPrefixes: reviewShipmentSubscription.streamPrefixes,
        order: reviewShipmentSubscription.order,
      },
      {
        subscriptionName: "reputation.support-source-projection",
        sourceContextName: "platform-operations",
        projectionName: reviewSupportSubscription.projectionName,
        subscriptionVersion: reviewSupportSubscription.subscriptionVersion,
        handlers: buildReputationSupportProjectionHandlers(services.db),
        eventTypes: reviewSupportSubscription.eventTypes,
        streamPrefixes: reviewSupportSubscription.streamPrefixes,
        order: reviewSupportSubscription.order,
      },
    ];
  },
  seed: seedMarketplaceContextDatabase,
};
