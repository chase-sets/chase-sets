export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { DiscoveryServices } from "./services";
import { buildDiscoveryApi } from "./api";
import { buildDiscoveryCategoryProjectionHandlers } from "./categories/projection";
import { buildDiscoveryItemDetailProjectionHandlers } from "./items/detail/projection";
import { buildDiscoveryMarketProjectionHandlers } from "./items/market/projection";
import { buildDiscoverySearchItemProjectionHandlers } from "./items/search/projection";
import { createDiscoveryServices } from "./services";
import { discoverySchemaSql } from "./schema";

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
      `Discovery is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

export const module: BcApiModule<DiscoveryServices, PgTransactionalPool, void> = {
  contextName: "discovery",
  routePrefix: "/api/marketplace",
  streamPrefix: "discovery.",
  schemaSql: discoverySchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<DiscoveryServices, PgTransactionalPool, void>["apiMounts"],
  projectionGroups,
  createServices: (pool) => createDiscoveryServices(pool),
  buildApis: (services) => [buildDiscoveryApi(services)],
  projectors: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const categorySubscription = getEventSubscription(
      "catalog",
      "discovery-category-projection",
    );
    const searchSubscription = getEventSubscription(
      "catalog",
      "discovery-search-item-projection",
    );
    const detailSubscription = getEventSubscription(
      "catalog",
      "discovery-item-detail-projection",
    );
    const identitySubscription = getEventSubscription(
      "identity",
      "discovery-market-projection",
    );
    const marketplaceSubscription = getEventSubscription(
      "marketplace",
      "discovery-market-projection",
    );

    return [
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
        handlers: buildDiscoveryMarketProjectionHandlers(services.db),
        eventTypes: identitySubscription.eventTypes,
        streamPrefixes: identitySubscription.streamPrefixes,
        order: identitySubscription.order,
      },
      {
        subscriptionName: "discovery.marketplace-market-projection",
        sourceContextName: "marketplace",
        projectionName: marketplaceSubscription.projectionName,
        subscriptionVersion: marketplaceSubscription.subscriptionVersion,
        handlers: buildDiscoveryMarketProjectionHandlers(services.db),
        eventTypes: marketplaceSubscription.eventTypes,
        streamPrefixes: marketplaceSubscription.streamPrefixes,
        order: marketplaceSubscription.order,
      },
    ];
  },
};
