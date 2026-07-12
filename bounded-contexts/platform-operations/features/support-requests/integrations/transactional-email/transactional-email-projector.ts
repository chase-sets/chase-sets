import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
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
  const result = await db.query<{ buyer_email: string | null; buyer_account_id: string | null }>(
    `SELECT buyer_email, buyer_account_id
     FROM support_order_sources
     WHERE order_id = $1
     LIMIT 1`,
    [orderId],
  );

  const row = result.rows[0];
  return row?.buyer_email?.trim() ? { email: row.buyer_email.trim(), accountId: row.buyer_account_id } : null;
}

export async function projectSupportRequestEventToTransactionalEmail(
  db: PgQueryable,
  outbox: NotificationOutbox,
  event: TransportEvent,
  projectionName = SUPPORT_REQUEST_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  if (event.type !== "support.support-request.opened" && event.type !== "support.support-request.resolved") return;
  const data = event.data as SupportRequestEmailEventData;
  const buyer = await findBuyerEmailForOrder(db, data.orderId);
  if (!buyer) return;

  const common = {
    buyerEmail: buyer.email,
    recipientAccountId: buyer.accountId as AccountId | null,
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
