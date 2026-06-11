export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { buildPlatformOperationsApi } from "./api";
import contextManifest from "./context.json";
import { buildExperienceApi } from "./features/platform-feedback/api/http";
import { buildSupportApi } from "./features/support-requests/api/http";
import {
  buildSupportOrderSourceProjectionHandlers,
  buildSupportShipmentSourceProjectionHandlers,
} from "./features/support-requests/integrations/source/source-projection";
import { platformOperationsSchemaSql } from "./support/runtime-support/schema";
import { seedPlatformOperationsDatabase } from "./support/runtime-support/seed";
import {
  createPlatformOperationsServices,
  type PlatformOperationsHostPorts,
  type PlatformOperationsServices,
} from "./support/runtime-support/services";

const eventSubscriptions = (contextManifest.eventSubscriptions ?? []) as readonly BcEventSubscriptionDeclaration[];
const projectionGroups = (contextManifest.projectionGroups ?? []) as readonly BcProjectionGroupDeclaration[];

function getEventSubscription(sourceContextName: string, projectionName: string): BcEventSubscriptionDeclaration {
  const declaration = eventSubscriptions.find(
    (entry) => entry.sourceContextName === sourceContextName && entry.projectionName === projectionName,
  );

  if (!declaration) {
    throw new Error(
      `Platform Operations is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

export const module: BcApiModule<PlatformOperationsServices, PgTransactionalPool, PlatformOperationsHostPorts> = {
  contextName: "platform-operations",
  routePrefix: "/api/platform",
  streamPrefix: "platform-operations.",
  schemaSql: platformOperationsSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<
    PlatformOperationsServices,
    PgTransactionalPool,
    PlatformOperationsHostPorts
  >["apiMounts"],
  projectionGroups,
  createServices: (pool, ports) => createPlatformOperationsServices(pool, ports),
  buildApis: (services) => [
    buildPlatformOperationsApi(services),
    buildExperienceApi(services.platformFeedback),
    buildSupportApi(services.supportRequests),
  ],
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const orderSubscription = getEventSubscription("ordering", "support-order-source-projection");
    const shipmentSubscription = getEventSubscription("fulfillment", "support-shipment-source-projection");

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
  seed: seedPlatformOperationsDatabase,
};
