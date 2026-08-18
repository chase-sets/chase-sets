export { default as contextManifest } from "./context.json" with { type: "json" };

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json" with { type: "json" };
import { notificationsRetentionSweeps } from "./support/runtime-support/retention-policy";
import { buildNotificationsApi, buildNotificationsProviderWebhookApi } from "./api";
import { notificationsSchemaSql } from "./support/runtime-support/schema";
import {
  createNotificationsServices,
  type NotificationsHostPorts,
  type NotificationsServices,
} from "./features/notification-center/api/services";
import {
  buildNotificationsFulfillmentProjectionHandlers,
  buildNotificationsInventoryProjectionHandlers,
  buildNotificationsMarketplaceProjectionHandlers,
  buildNotificationsOrderingProjectionHandlers,
  buildNotificationsSettlementProjectionHandlers,
  NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
} from "./features/notification-center/integrations/source-events/notification-projector";
import { buildNotificationsCustomerFeedbackProjectionHandlers } from "./features/notification-center/integrations/source-events/customer-feedback-notifications";
import { buildNotificationsSupportDisputeProjectionHandlers } from "./features/notification-center/integrations/source-events/support-dispute-notifications";

export const module = defineBoundedContextModule<NotificationsServices, PgTransactionalPool, NotificationsHostPorts>({
  manifest: contextManifest,
  schemaSql: notificationsSchemaSql,
  retentionSweeps: notificationsRetentionSweeps,
  createServices: (pool, ports) => createNotificationsServices(pool, ports),
  buildApis: (services) => [
    { mountPath: "/api/notifications", contextMountOrdinal: 1, router: buildNotificationsApi(services) },
    {
      mountPath: "/api/notifications/provider",
      contextMountOrdinal: 2,
      router: buildNotificationsProviderWebhookApi(services),
    },
  ],
  projectionHandlerSets: () => [],
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "notifications",
      manifest: contextManifest,
      handlers: {
        [`ordering.${NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION}`]: (subscription) =>
          buildNotificationsOrderingProjectionHandlers(services.notificationOutbox, subscription.projectionName),
        [`fulfillment.${NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION}`]: (subscription) =>
          buildNotificationsFulfillmentProjectionHandlers(services.notificationOutbox, subscription.projectionName),
        [`inventory.${NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION}`]: (subscription) =>
          buildNotificationsInventoryProjectionHandlers(services.notificationOutbox, subscription.projectionName),
        // NOTE: settlement.support-hold.{placed,released,consumed}.v1 routing is implemented and
        // unit-tested in support-dispute-notifications.ts, but wiring the subscription is gated on the
        // settlement support-hold lifecycle facts (and their glossary noun) landing from the settlement
        // slice. Merge buildNotificationsSettlementSupportHoldProjectionHandlers here and add the three
        // event types to the settlement subscription in context.json once those facts are on main.
        [`settlement.${NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION}`]: (subscription) =>
          buildNotificationsSettlementProjectionHandlers(services.notificationOutbox, subscription.projectionName),
        [`marketplace.${NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION}`]: (subscription) =>
          buildNotificationsMarketplaceProjectionHandlers(services.notificationOutbox, subscription.projectionName),
        [`customer-feedback.${NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION}`]: (subscription) =>
          buildNotificationsCustomerFeedbackProjectionHandlers(
            services.notificationOutbox,
            subscription.projectionName,
          ),
        [`platform-operations.${NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION}`]: (subscription) =>
          buildNotificationsSupportDisputeProjectionHandlers(
            services.notificationOutbox,
            services.supportCaseDirectory,
            subscription.projectionName,
          ),
      },
    }),
});
