export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type {
  FulfillmentHostPorts,
  FulfillmentServices,
} from "./support/runtime-support/services";
import { buildFulfillmentApi } from "./api";
import { createFulfillmentServices } from "./support/runtime-support/services";
import { fulfillmentSchemaSql } from "./support/runtime-support/schema";
import { seedFulfillmentDatabase } from "./support/runtime-support/seed";
import {
  buildFulfillmentAccountProjectionHandlers,
  buildFulfillmentOrderProjectionHandlers,
} from "./features/shipments/integrations/source/source-projection";

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
      `Fulfillment is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

export const module: BcApiModule<
  FulfillmentServices,
  PgTransactionalPool,
  FulfillmentHostPorts
> = {
  contextName: "fulfillment",
  routePrefix: "/api/marketplace",
  streamPrefix: "fulfillment.",
  schemaSql: fulfillmentSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<
    FulfillmentServices,
    PgTransactionalPool,
    FulfillmentHostPorts
  >["apiMounts"],
  projectionGroups,
  createServices: (pool, ports) => createFulfillmentServices(pool, ports),
  buildApis: (services) => [buildFulfillmentApi(services)],
  projectors: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const identitySubscription = getEventSubscription(
      "identity",
      "fulfillment-account-projection",
    );
    const orderingSubscription = getEventSubscription(
      "ordering",
      "fulfillment-order-source-projection",
    );

    return [
      {
        subscriptionName: "fulfillment.identity-account-projection",
        sourceContextName: "identity",
        projectionName: identitySubscription.projectionName,
        subscriptionVersion: identitySubscription.subscriptionVersion,
        handlers: buildFulfillmentAccountProjectionHandlers(services.db),
        eventTypes: identitySubscription.eventTypes,
        streamPrefixes: identitySubscription.streamPrefixes,
        order: identitySubscription.order,
      },
      {
        subscriptionName: "fulfillment.order-source-projection",
        sourceContextName: "ordering",
        projectionName: orderingSubscription.projectionName,
        subscriptionVersion: orderingSubscription.subscriptionVersion,
        handlers: buildFulfillmentOrderProjectionHandlers(services.db, {
          onReadyForFulfillment: async (params) => {
            await services.shipments.createShipmentForReadyOrder(params);
          },
          onOrderCancelled: async (params) => {
            await services.shipments.cancelShipmentForCancelledOrder(params);
          },
        }),
        eventTypes: orderingSubscription.eventTypes,
        streamPrefixes: orderingSubscription.streamPrefixes,
        order: orderingSubscription.order,
      },
    ];
  },
  seed: seedFulfillmentDatabase,
};
