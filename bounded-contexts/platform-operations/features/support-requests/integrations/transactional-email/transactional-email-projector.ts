import type { NotificationOutbox } from "@chase-sets/notifications";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  mapSupportRequestOpenedToTransactionalEmail,
  mapSupportRequestResolvedToTransactionalEmail,
} from "./transactional-email-intents";

export const SUPPORT_REQUEST_TRANSACTIONAL_EMAIL_PROJECTION = "support-request-transactional-email-projection";

type SupportRequestEmailEventData = Readonly<{
  supportRequestId: string;
  orderId: string;
  flowType: string;
  resolution?: Readonly<{ resolutionType: string }> | null;
}>;

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

async function findBuyerEmailForOrder(db: PgQueryable, orderId: string) {
  const result = await db.query<{ buyer_email: string | null }>(
    `SELECT buyer_email
     FROM support_order_sources
     WHERE order_id = $1
     LIMIT 1`,
    [orderId],
  );

  return result.rows[0]?.buyer_email?.trim() || null;
}

export async function projectSupportRequestEventToTransactionalEmail(
  db: PgQueryable,
  outbox: NotificationOutbox,
  event: TransportEvent,
  projectionName = SUPPORT_REQUEST_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  if (event.type !== "support.support-request.opened" && event.type !== "support.support-request.resolved") return;
  const data = event.data as SupportRequestEmailEventData;
  const buyerEmail = await findBuyerEmailForOrder(db, data.orderId);
  if (!buyerEmail) return;

  const common = {
    buyerEmail,
    supportRequestId: data.supportRequestId,
    orderId: data.orderId,
    flowType: data.flowType,
    correlationId: correlationIdFromEvent(event),
  };
  const message =
    event.type === "support.support-request.opened"
      ? mapSupportRequestOpenedToTransactionalEmail(common)
      : mapSupportRequestResolvedToTransactionalEmail({
          ...common,
          resolutionType: data.resolution?.resolutionType ?? "resolved",
        });

  await outbox.enqueueNotification({
    message,
    source: {
      sourceEventId: event.id,
      sourceGlobalPosition: event.globalPosition,
      projectionName,
      occurredAt: event.timing.occurredAt,
    },
  });
}

export function buildSupportRequestTransactionalEmailProjectionHandlers(
  db: PgQueryable,
  outbox: NotificationOutbox,
  projectionName = SUPPORT_REQUEST_TRANSACTIONAL_EMAIL_PROJECTION,
): ProjectorHandlerMap {
  return {
    "support.support-request.opened": (event) =>
      projectSupportRequestEventToTransactionalEmail(db, outbox, event, projectionName),
    "support.support-request.resolved": (event) =>
      projectSupportRequestEventToTransactionalEmail(db, outbox, event, projectionName),
  };
}
