import { createTransactionalEmailNotificationMessage, type NotificationMessage } from "@chase-sets/outbound-messaging";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import type { AccountId, SupportRequestId } from "@chase-sets/primitives/typed-ids";

export type SupportRequestEmailIntentInput = Readonly<{
  buyerEmail: string;
  recipientAccountId?: AccountId | null;
  supportRequestId: string;
  orderId: string;
  flowType: string;
  correlationId: string;
}>;

export function mapSupportRequestOpenedToTransactionalEmail(
  input: SupportRequestEmailIntentInput,
): NotificationMessage {
  const supportReference = deriveDisplayReferenceOrRaw(input.supportRequestId as SupportRequestId);

  return createTransactionalEmailNotificationMessage({
    messageType: "support.support-request.opened",
    criticality: "operational",
    recipientAccountId: input.recipientAccountId,
    to: [{ email: input.buyerEmail }],
    subject: `Support request ${supportReference} opened for order ${input.orderId}`,
    templateId: "support_request_opened",
    templateVersion: 1,
    locale: "en",
    templateData: {
      supportRequestId: input.supportRequestId,
      supportReference,
      orderId: input.orderId,
      flowType: input.flowType,
    },
    idempotencyKey: `support:support_request_opened:${input.supportRequestId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  });
}

export function mapSupportRequestResolvedToTransactionalEmail(
  input: SupportRequestEmailIntentInput & Readonly<{ resolutionType: string; resolutionSummary?: string | null }>,
): NotificationMessage {
  const supportReference = deriveDisplayReferenceOrRaw(input.supportRequestId as SupportRequestId);

  return createTransactionalEmailNotificationMessage({
    messageType: "support.support-request.resolved",
    criticality: "operational",
    recipientAccountId: input.recipientAccountId,
    to: [{ email: input.buyerEmail }],
    subject: `Support request ${supportReference} resolved for order ${input.orderId}`,
    templateId: "support_request_resolved",
    templateVersion: 1,
    locale: "en",
    templateData: {
      supportRequestId: input.supportRequestId,
      supportReference,
      orderId: input.orderId,
      flowType: input.flowType,
      resolutionType: input.resolutionType,
      // The operator's adjudication summary is delivered verbatim so both
      // parties read the exact rationale the decision was recorded with.
      resolutionSummary: input.resolutionSummary ?? "",
    },
    idempotencyKey: `support:support_request_resolved:${input.supportRequestId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  });
}
