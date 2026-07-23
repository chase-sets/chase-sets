export { default as contextManifest } from "./context.json";

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
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
import {
  buildNotificationsSettlementSupportHoldProjectionHandlers,
  buildNotificationsSupportDisputeProjectionHandlers,
} from "./features/notification-center/integrations/source-events/support-dispute-notifications";

export const module = defineBoundedContextModule<NotificationsServices, PgTransactionalPool, NotificationsHostPorts>({
  manifest: contextManifest,
  schemaSql: notificationsSchemaSql,
  retentionSweeps: notificationsRetentionSweeps,
  createServices: (pool, ports) => createNotificationsServices(pool, ports),
  buildApis: (services) => [buildNotificationsApi(services), buildNotificationsProviderWebhookApi(services)],
  projectionHandlerSets: () => [],
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "notifications",
      manifest: contextManifest,
      handlers: {
        [`ordering.${NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION}`]: {
          subscriptionName: "notifications.ordering-facts-projection",
          buildHandlers: (subscription) =>
            buildNotificationsOrderingProjectionHandlers(services.notificationOutbox, subscription.projectionName),
        },
        [`fulfillment.${NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION}`]: {
          subscriptionName: "notifications.fulfillment-facts-projection",
          buildHandlers: (subscription) =>
            buildNotificationsFulfillmentProjectionHandlers(services.notificationOutbox, subscription.projectionName),
        },
        [`inventory.${NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION}`]: {
          subscriptionName: "notifications.inventory-facts-projection",
          buildHandlers: (subscription) =>
            buildNotificationsInventoryProjectionHandlers(services.notificationOutbox, subscription.projectionName),
        },
        [`settlement.${NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION}`]: {
          subscriptionName: "notifications.settlement-facts-projection",
          buildHandlers: (subscription) => ({
            ...buildNotificationsSettlementProjectionHandlers(services.notificationOutbox, subscription.projectionName),
            ...buildNotificationsSettlementSupportHoldProjectionHandlers(
              services.notificationOutbox,
              subscription.projectionName,
            ),
          }),
        },
        [`marketplace.${NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION}`]: {
          subscriptionName: "notifications.marketplace-facts-projection",
          buildHandlers: (subscription) =>
            buildNotificationsMarketplaceProjectionHandlers(services.notificationOutbox, subscription.projectionName),
        },
        [`customer-feedback.${NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION}`]: {
          subscriptionName: "notifications.customer-feedback-facts-projection",
          buildHandlers: (subscription) =>
            buildNotificationsCustomerFeedbackProjectionHandlers(
              services.notificationOutbox,
              subscription.projectionName,
            ),
        },
        [`platform-operations.${NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION}`]: {
          subscriptionName: "notifications.support-dispute-facts-projection",
          buildHandlers: (subscription) =>
            buildNotificationsSupportDisputeProjectionHandlers(
              services.notificationOutbox,
              services.supportCaseDirectory,
              subscription.projectionName,
            ),
        },
      },
    }),
});
