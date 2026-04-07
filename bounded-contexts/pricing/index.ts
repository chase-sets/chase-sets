export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { buildPricingApi } from "./api";
import {
  buildPricingCatalogInputProjectionHandlers,
  buildPricingFulfillmentInputProjectionHandlers,
  buildPricingInventoryInputProjectionHandlers,
  buildPricingMarketplaceInputProjectionHandlers,
  buildPricingOrderingInputProjectionHandlers,
} from "./recommendations/source-projection";
import { pricingSchemaSql } from "./schema";
import { seedPricingDatabase } from "./seed";
import type { PricingServices } from "./services";
import { createPricingServices } from "./services";

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
      `Pricing is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

export const module: BcApiModule<PricingServices, PgTransactionalPool, void> = {
  contextName: "pricing",
  routePrefix: "/api/marketplace",
  streamPrefix: "pricing.",
  schemaSql: pricingSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<
    PricingServices,
    PgTransactionalPool,
    void
  >["apiMounts"],
  projectionGroups,
  createServices: (pool) => createPricingServices(pool),
  buildApis: (services) => [buildPricingApi(services)],
  projectors: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const catalogSubscription = getEventSubscription(
      "catalog",
      "pricing-catalog-input-projection",
    );
    const inventorySubscription = getEventSubscription(
      "inventory",
      "pricing-inventory-input-projection",
    );
    const marketplaceSubscription = getEventSubscription(
      "marketplace",
      "pricing-market-input-projection",
    );
    const orderingSubscription = getEventSubscription(
      "ordering",
      "pricing-order-input-projection",
    );
    const fulfillmentSubscription = getEventSubscription(
      "fulfillment",
      "pricing-fulfillment-input-projection",
    );

    return [
      {
        subscriptionName: "pricing.catalog-input-projection",
        sourceContextName: "catalog",
        projectionName: catalogSubscription.projectionName,
        subscriptionVersion: catalogSubscription.subscriptionVersion,
        handlers: buildPricingCatalogInputProjectionHandlers(services.db),
        eventTypes: catalogSubscription.eventTypes,
        streamPrefixes: catalogSubscription.streamPrefixes,
        order: catalogSubscription.order,
      },
      {
        subscriptionName: "pricing.inventory-input-projection",
        sourceContextName: "inventory",
        projectionName: inventorySubscription.projectionName,
        subscriptionVersion: inventorySubscription.subscriptionVersion,
        handlers: buildPricingInventoryInputProjectionHandlers(services.db),
        eventTypes: inventorySubscription.eventTypes,
        streamPrefixes: inventorySubscription.streamPrefixes,
        order: inventorySubscription.order,
      },
      {
        subscriptionName: "pricing.market-input-projection",
        sourceContextName: "marketplace",
        projectionName: marketplaceSubscription.projectionName,
        subscriptionVersion: marketplaceSubscription.subscriptionVersion,
        handlers: buildPricingMarketplaceInputProjectionHandlers(services.db),
        eventTypes: marketplaceSubscription.eventTypes,
        streamPrefixes: marketplaceSubscription.streamPrefixes,
        order: marketplaceSubscription.order,
      },
      {
        subscriptionName: "pricing.order-input-projection",
        sourceContextName: "ordering",
        projectionName: orderingSubscription.projectionName,
        subscriptionVersion: orderingSubscription.subscriptionVersion,
        handlers: buildPricingOrderingInputProjectionHandlers(services.db),
        eventTypes: orderingSubscription.eventTypes,
        streamPrefixes: orderingSubscription.streamPrefixes,
        order: orderingSubscription.order,
      },
      {
        subscriptionName: "pricing.fulfillment-input-projection",
        sourceContextName: "fulfillment",
        projectionName: fulfillmentSubscription.projectionName,
        subscriptionVersion: fulfillmentSubscription.subscriptionVersion,
        handlers: buildPricingFulfillmentInputProjectionHandlers(services.db),
        eventTypes: fulfillmentSubscription.eventTypes,
        streamPrefixes: fulfillmentSubscription.streamPrefixes,
        order: fulfillmentSubscription.order,
      },
    ];
  },
  seed: seedPricingDatabase,
};
