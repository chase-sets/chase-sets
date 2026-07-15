import { defineTransactionalEmail, type NotificationOutbox } from "@chase-sets/outbound-messaging";
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
  resolution?: Readonly<{ resolutionType: string; summary?: string | null }> | null;
}>;

type SupportRequestEmailRecipient = Readonly<{ email: string; accountId: string | null }>;

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

export function buildSupportRequestTransactionalEmailProjectionHandlers(
  db: PgQueryable,
  outbox: NotificationOutbox,
  projectionName = SUPPORT_REQUEST_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  const recipient = (data: SupportRequestEmailEventData) => findBuyerEmailForOrder(db, data.orderId);
  const intentInput = (
    data: SupportRequestEmailEventData,
    resolved: SupportRequestEmailRecipient,
    correlationId: string,
  ) => ({
    buyerEmail: resolved.email,
    recipientAccountId: resolved.accountId as AccountId | null,
    supportRequestId: data.supportRequestId,
    orderId: data.orderId,
    flowType: data.flowType,
    correlationId,
  });

  return {
    ...defineTransactionalEmail<
      SupportRequestEmailEventData,
      SupportRequestEmailRecipient,
      "support.support-request.opened"
    >({
      outbox,
      projectionName,
      on: "support.support-request.opened",
      recipient,
      template: (data, { recipient: resolved, correlationId }) =>
        mapSupportRequestOpenedToTransactionalEmail(intentInput(data, resolved, correlationId)),
    }),
    ...defineTransactionalEmail<
      SupportRequestEmailEventData,
      SupportRequestEmailRecipient,
      "support.support-request.resolved"
    >({
      outbox,
      projectionName,
      on: "support.support-request.resolved",
      recipient,
      template: (data, { recipient: resolved, correlationId }) =>
        mapSupportRequestResolvedToTransactionalEmail({
          ...intentInput(data, resolved, correlationId),
          resolutionType: data.resolution?.resolutionType ?? "resolved",
          resolutionSummary: data.resolution?.summary ?? "",
        }),
    }),
  };
}
