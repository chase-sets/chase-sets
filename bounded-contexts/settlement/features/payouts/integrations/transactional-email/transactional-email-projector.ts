import { defineTransactionalEmail, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { mapPayoutCompletedToTransactionalEmail } from "./transactional-email-intents";

export const SETTLEMENT_PAYOUT_TRANSACTIONAL_EMAIL_PROJECTION = "settlement-payout-transactional-email-projection";

type SettlementPayoutCompletedEmailData = Readonly<{
  notificationEmail: string | null;
  payoutId: string;
  accountId: AccountId;
  amount: string;
}>;

export function buildSettlementPayoutTransactionalEmailProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = SETTLEMENT_PAYOUT_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  return defineTransactionalEmail<SettlementPayoutCompletedEmailData, string, "settlement.payout.completed">({
    outbox,
    projectionName,
    on: "settlement.payout.completed",
    recipient: (data) => data.notificationEmail?.trim() || null,
    template: (data, { recipient, correlationId }) =>
      mapPayoutCompletedToTransactionalEmail({
        sellerEmail: recipient,
        recipientAccountId: data.accountId,
        payoutId: data.payoutId,
        amount: data.amount,
        correlationId,
      }),
  });
}
