export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { buildCheckoutApi } from "./api";
import { buildCheckoutCatalogProjectionHandlers } from "./features/cart/integrations/catalog/catalog-projection";
import {
  createCheckoutServices,
  type CheckoutServiceOptions,
  type CheckoutServices,
} from "./support/runtime-support/services";
import { checkoutSchemaSql } from "./support/runtime-support/schema";
import { seedCheckoutDatabase } from "./support/runtime-support/seed";

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
      `Checkout is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

export const module: BcApiModule<
  CheckoutServices,
  PgTransactionalPool,
  CheckoutServiceOptions
> = {
  contextName: "checkout",
  routePrefix: "/api/marketplace",
  streamPrefix: "checkout.",
  schemaSql: checkoutSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<
    CheckoutServices,
    PgTransactionalPool,
    CheckoutServiceOptions
  >["apiMounts"],
  projectionGroups,
  createServices: (pool, options) => createCheckoutServices(pool, options),
  buildApis: (services) => [buildCheckoutApi(services)],
  projectors: (services) => services.projectors,
  seed: seedCheckoutDatabase,
  buildSubscriptions: (services) => {
    const catalogSubscription = getEventSubscription(
      "catalog",
      "checkout-catalog-item-projection",
    );

    return [
      {
        subscriptionName: "checkout.catalog-item-projection",
        sourceContextName: "catalog",
        projectionName: catalogSubscription.projectionName,
        subscriptionVersion: catalogSubscription.subscriptionVersion,
        handlers: buildCheckoutCatalogProjectionHandlers(services.db),
        eventTypes: catalogSubscription.eventTypes,
        streamPrefixes: catalogSubscription.streamPrefixes,
        order: catalogSubscription.order,
      },
    ];
  },
};
