import { t } from "@chase-sets/localization";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { NotificationMessage, NotificationOutbox } from "@chase-sets/outbound-messaging";

type RepricingDigestEvent = TransportEvent &
  Readonly<{
    data: Readonly<{
      schemaVersion: 1;
      digestId: string;
      sellerAccountId: string;
      day: string;
      policiesEvaluated: number;
      listingsChanged: number;
      floorClamped: number;
      ceilingClamped: number;
      maxMoveClamped: number;
      budgetExhausted: number;
      pausedForMissingInput: number;
      withinTolerance: number;
      spiralBreakerTrips: number;
    }>;
  }>;

export function mapRepricingDigestToNotification(event: RepricingDigestEvent): NotificationMessage {
  const {
    digestId,
    sellerAccountId,
    day,
    policiesEvaluated,
    listingsChanged,
    floorClamped,
    ceilingClamped,
    maxMoveClamped,
    budgetExhausted,
    pausedForMissingInput,
    withinTolerance,
    spiralBreakerTrips,
  } = event.data;
  const counts = {
    policiesEvaluated,
    listingsChanged,
    floorClamped,
    ceilingClamped,
    maxMoveClamped,
    budgetExhausted,
    pausedForMissingInput,
    withinTolerance,
    spiralBreakerTrips,
  };
  const actionHref = "/account/desk/repricing";
  return {
    messageType: "pricing.repricing-activity.digest-requested",
    criticality: "operational",
    category: "operational",
    recipientAccountId: sellerAccountId as AccountId,
    title: t("notifications.intents.repricingDigest.title", { day }),
    body: t("notifications.intents.repricingDigest.body", counts),
    actionHref,
    templateId: "pricing_repricing_activity_digest",
    templateVersion: 1,
    locale: "en",
    templateData: { digestId, day, ...counts, actionHref },
    channels: [{ channel: "web", recipient: { accountId: sellerAccountId as AccountId }, actionHref }],
    idempotencyKey: `notifications:pricing:repricing-digest:${digestId}`,
    correlationId: event.trace.traceId ?? event.id,
    actor: { userId: null },
  };
}

export function buildNotificationsPricingRepricingProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = "notifications-source-facts-outbox-projection",
): ProjectorHandlerMap {
  return {
    "pricing.repricing-activity.digest-requested": async (event) => {
      await outbox.enqueueNotification({
        message: mapRepricingDigestToNotification(event as RepricingDigestEvent),
        source: {
          sourceEventId: event.id,
          sourceGlobalPosition: event.globalPosition,
          projectionName,
          occurredAt: event.timing.occurredAt,
        },
      });
    },
  };
}
