import { createTransactionalEmailNotificationMessage, type NotificationMessage } from "@chase-sets/notifications";

export type SupportRequestEmailIntentInput = Readonly<{
  buyerEmail: string;
  supportRequestId: string;
  orderId: string;
  flowType: string;
  correlationId: string;
}>;

export function mapSupportRequestOpenedToTransactionalEmail(
  input: SupportRequestEmailIntentInput,
): NotificationMessage {
  return createTransactionalEmailNotificationMessage({
    messageType: "support.support-request.opened",
    criticality: "operational",
    to: [{ email: input.buyerEmail }],
    subject: `Support request opened for order ${input.orderId}`,
    templateId: "support_request_opened",
    templateVersion: 1,
    locale: "en",
    templateData: {
      supportRequestId: input.supportRequestId,
      orderId: input.orderId,
      flowType: input.flowType,
    },
    idempotencyKey: `support:support_request_opened:${input.supportRequestId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  });
}

export function mapSupportRequestResolvedToTransactionalEmail(
  input: SupportRequestEmailIntentInput & Readonly<{ resolutionType: string }>,
): NotificationMessage {
  return createTransactionalEmailNotificationMessage({
    messageType: "support.support-request.resolved",
    criticality: "operational",
    to: [{ email: input.buyerEmail }],
    subject: `Support request resolved for order ${input.orderId}`,
    templateId: "support_request_resolved",
    templateVersion: 1,
    locale: "en",
    templateData: {
      supportRequestId: input.supportRequestId,
      orderId: input.orderId,
      flowType: input.flowType,
      resolutionType: input.resolutionType,
    },
    idempotencyKey: `support:support_request_resolved:${input.supportRequestId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  });
}
