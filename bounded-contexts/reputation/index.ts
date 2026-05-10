export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { ReputationServices } from "./support/runtime-support/services";
import { buildReputationApi } from "./api";
import { createReputationServices } from "./support/runtime-support/services";
import { reputationSchemaSql } from "./support/runtime-support/schema";
import { seedReputationDatabase } from "./support/runtime-support/seed";
import {
  buildReviewAccountProjectionHandlers,
  buildReputationOrderProjectionHandlers,
  buildReputationShipmentProjectionHandlers,
  buildReputationSupportProjectionHandlers,
} from "./features/reviews/integrations/source/source-projection";

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
      `Reputation is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

export const module: BcApiModule<ReputationServices, PgTransactionalPool, void> = {
  contextName: "reputation",
  routePrefix: "/api/marketplace",
  streamPrefix: "reputation.",
  schemaSql: reputationSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<ReputationServices, PgTransactionalPool, void>["apiMounts"],
  projectionGroups,
  createServices: (pool) => createReputationServices(pool),
  buildApis: (services) => [buildReputationApi(services)],
  projectors: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const identitySubscription = getEventSubscription(
      "identity",
      "reputation-account-projection",
    );
    const orderingSubscription = getEventSubscription(
      "ordering",
      "reputation-order-source-projection",
    );
    const fulfillmentSubscription = getEventSubscription(
      "fulfillment",
      "reputation-shipment-source-projection",
    );
    const supportSubscription = getEventSubscription(
      "support",
      "reputation-support-source-projection",
    );

    return [
      {
        subscriptionName: "reputation.identity-account-projection",
        sourceContextName: "identity",
        projectionName: identitySubscription.projectionName,
        subscriptionVersion: identitySubscription.subscriptionVersion,
        handlers: buildReviewAccountProjectionHandlers(services.db),
        eventTypes: identitySubscription.eventTypes,
        streamPrefixes: identitySubscription.streamPrefixes,
        order: identitySubscription.order,
      },
      {
        subscriptionName: "reputation.order-source-projection",
        sourceContextName: "ordering",
        projectionName: orderingSubscription.projectionName,
        subscriptionVersion: orderingSubscription.subscriptionVersion,
        handlers: buildReputationOrderProjectionHandlers(services.db),
        eventTypes: orderingSubscription.eventTypes,
        streamPrefixes: orderingSubscription.streamPrefixes,
        order: orderingSubscription.order,
      },
      {
        subscriptionName: "reputation.shipment-source-projection",
        sourceContextName: "fulfillment",
        projectionName: fulfillmentSubscription.projectionName,
        subscriptionVersion: fulfillmentSubscription.subscriptionVersion,
        handlers: buildReputationShipmentProjectionHandlers(services.db, {
          onDeliveredShipment: services.reviews.recordDeliveredShipmentReviewEligibility,
        }),
        eventTypes: fulfillmentSubscription.eventTypes,
        streamPrefixes: fulfillmentSubscription.streamPrefixes,
        order: fulfillmentSubscription.order,
      },
      {
        subscriptionName: "reputation.support-source-projection",
        sourceContextName: "support",
        projectionName: supportSubscription.projectionName,
        subscriptionVersion: supportSubscription.subscriptionVersion,
        handlers: buildReputationSupportProjectionHandlers(services.db),
        eventTypes: supportSubscription.eventTypes,
        streamPrefixes: supportSubscription.streamPrefixes,
        order: supportSubscription.order,
      },
    ];
  },
  seed: seedReputationDatabase,
};
