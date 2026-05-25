export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { DiscoveryServices } from "./support/runtime-support/services";
import { buildDiscoveryApi } from "./api";
import { buildDiscoveryCategoryProjectionHandlers } from "./features/categories/read-model/projection";
import { buildDiscoveryItemDetailProjectionHandlers } from "./features/item-detail/read-model/projection";
import { buildProductAlertNotificationProjectionHandlers } from "./features/product-alerts/integrations/notifications/notification-projector";
import { buildProductAlertPageProjectionHandlers } from "./features/product-alerts/read-model/projection";
import { buildDiscoveryMarketProjectionHandlers } from "./support/market-support/projection";
import { buildDiscoverySearchItemProjectionHandlers } from "./features/search/read-model/projection";
import { createDiscoveryServices, type DiscoveryHostPorts } from "./support/runtime-support/services";
import { discoverySchemaSql } from "./support/runtime-support/schema";

const eventSubscriptions = (contextManifest.eventSubscriptions ?? []) as readonly BcEventSubscriptionDeclaration[];
const projectionGroups = (contextManifest.projectionGroups ?? []) as readonly BcProjectionGroupDeclaration[];

function getEventSubscription(sourceContextName: string, projectionName: string): BcEventSubscriptionDeclaration {
  const declaration = eventSubscriptions.find(
    (entry) => entry.sourceContextName === sourceContextName && entry.projectionName === projectionName,
  );

  if (!declaration) {
    throw new Error(
      `Discovery is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
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

export const module: BcApiModule<DiscoveryServices, PgTransactionalPool, DiscoveryHostPorts> = {
  contextName: "discovery",
  routePrefix: "/api/marketplace",
  streamPrefix: "discovery.",
  schemaSql: discoverySchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<
    DiscoveryServices,
    PgTransactionalPool,
    DiscoveryHostPorts
  >["apiMounts"],
  projectionGroups,
  createServices: (pool, ports) => createDiscoveryServices(pool, ports),
  buildApis: (services) => [buildDiscoveryApi(services)],
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const categorySubscription = getEventSubscription("catalog", "discovery-category-projection");
    const productAlertPageSubscription = getEventSubscription("discovery", "discovery-product-alert-page-projection");
    const searchSubscription = getEventSubscription("catalog", "discovery-search-item-projection");
    const detailSubscription = getEventSubscription("catalog", "discovery-item-detail-projection");
    const identitySubscription = getEventSubscription("identity", "discovery-market-projection");
    const marketplaceSubscription = getEventSubscription("marketplace", "discovery-market-projection");
    const reputationSubscription = getEventSubscription("reputation", "discovery-market-projection");
    const productAlertSubscription = getEventSubscription(
      "marketplace",
      "discovery-product-alert-notification-projection",
    );

    const marketProjectionHandlers = buildDiscoveryMarketProjectionHandlers(services.db);

    return [
      {
        subscriptionName: "discovery.product-alert-page-projection",
        sourceContextName: "discovery",
        projectionName: productAlertPageSubscription.projectionName,
        subscriptionVersion: productAlertPageSubscription.subscriptionVersion,
        handlers: buildProductAlertPageProjectionHandlers(services.db),
        eventTypes: productAlertPageSubscription.eventTypes,
        streamPrefixes: productAlertPageSubscription.streamPrefixes,
        order: productAlertPageSubscription.order,
      },
      {
        subscriptionName: "discovery.catalog-category-projection",
        sourceContextName: "catalog",
        projectionName: categorySubscription.projectionName,
        subscriptionVersion: categorySubscription.subscriptionVersion,
        handlers: buildDiscoveryCategoryProjectionHandlers(services.db),
        eventTypes: categorySubscription.eventTypes,
        streamPrefixes: categorySubscription.streamPrefixes,
        order: categorySubscription.order,
      },
      {
        subscriptionName: "discovery.catalog-search-projection",
        sourceContextName: "catalog",
        projectionName: searchSubscription.projectionName,
        subscriptionVersion: searchSubscription.subscriptionVersion,
        handlers: buildDiscoverySearchItemProjectionHandlers(services.db),
        eventTypes: searchSubscription.eventTypes,
        streamPrefixes: searchSubscription.streamPrefixes,
        order: searchSubscription.order,
      },
      {
        subscriptionName: "discovery.catalog-detail-projection",
        sourceContextName: "catalog",
        projectionName: detailSubscription.projectionName,
        subscriptionVersion: detailSubscription.subscriptionVersion,
        handlers: buildDiscoveryItemDetailProjectionHandlers(services.db),
        eventTypes: detailSubscription.eventTypes,
        streamPrefixes: detailSubscription.streamPrefixes,
        order: detailSubscription.order,
      },
      {
        subscriptionName: "discovery.identity-market-projection",
        sourceContextName: "identity",
        projectionName: identitySubscription.projectionName,
        subscriptionVersion: identitySubscription.subscriptionVersion,
        handlers: selectSubscriptionHandlers(marketProjectionHandlers, identitySubscription.eventTypes),
        eventTypes: identitySubscription.eventTypes,
        streamPrefixes: identitySubscription.streamPrefixes,
        order: identitySubscription.order,
      },
      {
        subscriptionName: "discovery.marketplace-market-projection",
        sourceContextName: "marketplace",
        projectionName: marketplaceSubscription.projectionName,
        subscriptionVersion: marketplaceSubscription.subscriptionVersion,
        handlers: selectSubscriptionHandlers(marketProjectionHandlers, marketplaceSubscription.eventTypes),
        eventTypes: marketplaceSubscription.eventTypes,
        streamPrefixes: marketplaceSubscription.streamPrefixes,
        order: marketplaceSubscription.order,
      },
      {
        subscriptionName: "discovery.reputation-market-projection",
        sourceContextName: "reputation",
        projectionName: reputationSubscription.projectionName,
        subscriptionVersion: reputationSubscription.subscriptionVersion,
        handlers: selectSubscriptionHandlers(marketProjectionHandlers, reputationSubscription.eventTypes),
        eventTypes: reputationSubscription.eventTypes,
        streamPrefixes: reputationSubscription.streamPrefixes,
        order: reputationSubscription.order,
      },
      {
        subscriptionName: "discovery.marketplace-product-alert-notifications",
        sourceContextName: "marketplace",
        projectionName: productAlertSubscription.projectionName,
        subscriptionVersion: productAlertSubscription.subscriptionVersion,
        handlers: buildProductAlertNotificationProjectionHandlers(
          services.db,
          services.notificationOutbox,
          productAlertSubscription.projectionName,
        ),
        eventTypes: productAlertSubscription.eventTypes,
        streamPrefixes: productAlertSubscription.streamPrefixes,
        order: productAlertSubscription.order,
      },
    ];
  },
};
