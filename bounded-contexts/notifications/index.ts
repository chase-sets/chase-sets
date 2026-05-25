export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { buildNotificationsApi, buildNotificationsMobileMessageWebhookApi } from "./api";
import { notificationsSchemaSql } from "./support/runtime-support/schema";
import {
  createNotificationsServices,
  type NotificationsHostPorts,
  type NotificationsServices,
} from "./features/notification-center/api/services";
import {
  buildNotificationsFulfillmentProjectionHandlers,
  buildNotificationsOrderingProjectionHandlers,
  NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
} from "./features/notification-center/integrations/source-events/notification-projector";

const eventSubscriptions = (contextManifest.eventSubscriptions ?? []) as readonly BcEventSubscriptionDeclaration[];
const projectionGroups = (contextManifest.projectionGroups ?? []) as readonly BcProjectionGroupDeclaration[];

function getEventSubscription(sourceContextName: string, projectionName: string): BcEventSubscriptionDeclaration {
  const declaration = eventSubscriptions.find(
    (entry) => entry.sourceContextName === sourceContextName && entry.projectionName === projectionName,
  );

  if (!declaration) {
    throw new Error(
      `Notifications is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

export const module: BcApiModule<NotificationsServices, PgTransactionalPool, NotificationsHostPorts> = {
  contextName: "notifications",
  routePrefix: "/api/notifications",
  streamPrefix: "notifications.",
  schemaSql: notificationsSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<
    NotificationsServices,
    PgTransactionalPool,
    NotificationsHostPorts
  >["apiMounts"],
  projectionGroups,
  createServices: (pool, ports) => createNotificationsServices(pool, ports),
  buildApis: (services) => [buildNotificationsApi(services), buildNotificationsMobileMessageWebhookApi(services)],
  projectionHandlerSets: () => [],
  buildSubscriptions: (services) => {
    const orderingSubscription = getEventSubscription("ordering", NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION);
    const fulfillmentSubscription = getEventSubscription("fulfillment", NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION);

    return [
      {
        subscriptionName: "notifications.ordering-facts-projection",
        sourceContextName: "ordering",
        projectionName: orderingSubscription.projectionName,
        subscriptionVersion: orderingSubscription.subscriptionVersion,
        handlers: buildNotificationsOrderingProjectionHandlers(
          services.notificationOutbox,
          orderingSubscription.projectionName,
        ),
        eventTypes: orderingSubscription.eventTypes,
        streamPrefixes: orderingSubscription.streamPrefixes,
        order: orderingSubscription.order,
      },
      {
        subscriptionName: "notifications.fulfillment-facts-projection",
        sourceContextName: "fulfillment",
        projectionName: fulfillmentSubscription.projectionName,
        subscriptionVersion: fulfillmentSubscription.subscriptionVersion,
        handlers: buildNotificationsFulfillmentProjectionHandlers(
          services.notificationOutbox,
          fulfillmentSubscription.projectionName,
        ),
        eventTypes: fulfillmentSubscription.eventTypes,
        streamPrefixes: fulfillmentSubscription.streamPrefixes,
        order: fulfillmentSubscription.order,
      },
    ];
  },
};
