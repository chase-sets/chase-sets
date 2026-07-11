import { createTransactionalEmailNotificationMessage, type NotificationMessage } from "@chase-sets/outbound-messaging";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import type { PayoutId } from "@chase-sets/primitives/typed-ids";

export type PayoutCompletedEmailIntentInput = Readonly<{
  sellerEmail: string;
  payoutId: string;
  amount: string;
  correlationId: string;
}>;

export function mapPayoutCompletedToTransactionalEmail(input: PayoutCompletedEmailIntentInput): NotificationMessage {
  const payoutReference = deriveDisplayReferenceOrRaw(input.payoutId as PayoutId);

  return createTransactionalEmailNotificationMessage({
    messageType: "settlement.payout.completed",
    criticality: "commerce",
    to: [{ email: input.sellerEmail }],
    subject: `Payout ${payoutReference} completed`,
    templateId: "payout_completed",
    templateVersion: 1,
    locale: "en",
    templateData: { payoutReference, amount: input.amount },
    idempotencyKey: `settlement:payout_completed:${input.payoutId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  });
}
