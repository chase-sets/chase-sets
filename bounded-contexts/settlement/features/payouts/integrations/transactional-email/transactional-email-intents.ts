import { createTransactionalEmailNotificationMessage, type NotificationMessage } from "@chase-sets/notifications";

export type PayoutCompletedEmailIntentInput = Readonly<{
  sellerEmail: string;
  payoutId: string;
  amount: string;
  correlationId: string;
}>;

export function mapPayoutCompletedToTransactionalEmail(input: PayoutCompletedEmailIntentInput): NotificationMessage {
  return createTransactionalEmailNotificationMessage({
    messageType: "settlement.payout.completed",
    criticality: "commerce",
    to: [{ email: input.sellerEmail }],
    subject: `Payout ${input.payoutId} completed`,
    templateId: "payout_completed",
    templateVersion: 1,
    locale: "en",
    templateData: { payoutId: input.payoutId, amount: input.amount },
    idempotencyKey: `settlement:payout_completed:${input.payoutId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  });
}
