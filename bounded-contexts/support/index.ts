export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { SupportServices } from "./support/runtime-support/services";
import { buildSupportApi } from "./api";
import { createSupportServices } from "./support/runtime-support/services";
import { supportSchemaSql } from "./support/runtime-support/schema";
import { seedSupportDatabase } from "./support/runtime-support/seed";
import {
  buildSupportOrderSourceProjectionHandlers,
  buildSupportShipmentSourceProjectionHandlers,
} from "./features/support-requests/integrations/source/source-projection";

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
      `Support is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

export const module: BcApiModule<SupportServices, PgTransactionalPool, void> = {
  contextName: "support",
  routePrefix: "/api/marketplace",
  streamPrefix: "support.",
  schemaSql: supportSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<SupportServices, PgTransactionalPool, void>["apiMounts"],
  projectionGroups,
  createServices: (pool) => createSupportServices(pool),
  buildApis: (services) => [buildSupportApi(services)],
  projectors: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const orderSubscription = getEventSubscription(
      "ordering",
      "support-order-source-projection",
    );
    const shipmentSubscription = getEventSubscription(
      "fulfillment",
      "support-shipment-source-projection",
    );

    return [
      {
        subscriptionName: "support.order-source-projection",
        sourceContextName: "ordering",
        projectionName: orderSubscription.projectionName,
        subscriptionVersion: orderSubscription.subscriptionVersion,
        handlers: buildSupportOrderSourceProjectionHandlers(services.db),
        eventTypes: orderSubscription.eventTypes,
        streamPrefixes: orderSubscription.streamPrefixes,
        order: orderSubscription.order,
      },
      {
        subscriptionName: "support.shipment-source-projection",
        sourceContextName: "fulfillment",
        projectionName: shipmentSubscription.projectionName,
        subscriptionVersion: shipmentSubscription.subscriptionVersion,
        handlers: buildSupportShipmentSourceProjectionHandlers(services.db),
        eventTypes: shipmentSubscription.eventTypes,
        streamPrefixes: shipmentSubscription.streamPrefixes,
        order: shipmentSubscription.order,
      },
    ];
  },
  seed: seedSupportDatabase,
};
