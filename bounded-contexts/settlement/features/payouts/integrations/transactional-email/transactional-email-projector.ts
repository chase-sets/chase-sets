import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { mapPayoutCompletedToTransactionalEmail } from "./transactional-email-intents";

export const SETTLEMENT_PAYOUT_TRANSACTIONAL_EMAIL_PROJECTION = "settlement-payout-transactional-email-projection";

export type SettlementPayoutCompletedEmailEvent = Readonly<
  TransportEvent & {
    type: "settlement.payout.completed";
    data: Readonly<{
      notificationEmail: string | null;
      payoutId: string;
      accountId: AccountId;
      amount: string;
    }>;
  }
>;

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

export async function projectSettlementPayoutEventToTransactionalEmail(
  outbox: NotificationOutbox,
  event: TransportEvent,
  projectionName = SETTLEMENT_PAYOUT_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  if (event.type !== "settlement.payout.completed") return;
  const data = event.data as SettlementPayoutCompletedEmailEvent["data"];
  const sellerEmail = data.notificationEmail?.trim();
  if (!sellerEmail) return;

  await outbox.enqueueNotification({
    message: mapPayoutCompletedToTransactionalEmail({
      sellerEmail,
      recipientAccountId: data.accountId,
      payoutId: data.payoutId,
      amount: data.amount,
      correlationId: correlationIdFromEvent(event),
    }),
    source: {
      sourceEventId: event.id,
      sourceGlobalPosition: event.globalPosition,
      projectionName,
      occurredAt: event.timing.occurredAt,
    },
  });
}

export function buildSettlementPayoutTransactionalEmailProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = SETTLEMENT_PAYOUT_TRANSACTIONAL_EMAIL_PROJECTION,
): ProjectorHandlerMap {
  return {
    "settlement.payout.completed": (event) =>
      projectSettlementPayoutEventToTransactionalEmail(outbox, event, projectionName),
  };
}
