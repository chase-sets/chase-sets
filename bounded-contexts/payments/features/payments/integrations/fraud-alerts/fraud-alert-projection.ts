import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { NotificationMessage, NotificationOutbox } from "@chase-sets/outbound-messaging";

export const PAYMENTS_FRAUD_ALERT_PROJECTION = "payments-fraud-alert-projection";

type FraudAlertEventData = Readonly<{
  paymentId: string;
  orderIds: readonly string[];
  buyerAccountId: string;
  providerEventId: string;
  earlyFraudWarningId?: string;
  providerReviewId?: string;
  providerChargeReference?: string | null;
  fraudType?: string | null;
  reason?: string | null;
  outcome?: string | null;
  chargeDisputed?: boolean;
  receivedAt?: string;
  openedAt?: string;
  closedAt?: string;
}>;

function fraudAlertKind(eventType: string) {
  switch (eventType) {
    case "payments.payment-fraud-warning-received":
      return "early-fraud-warning";
    case "payments.payment-fraud-review-opened":
      return "fraud-review-opened";
    case "payments.payment-fraud-review-closed":
      return "fraud-review-closed";
    default:
      return "fraud-signal";
  }
}

function occurredAt(data: FraudAlertEventData, fallback: string) {
  return data.receivedAt ?? data.openedAt ?? data.closedAt ?? fallback;
}

function fraudAlertMessage(event: TransportEvent): NotificationMessage {
  const data = event.data as FraudAlertEventData;
  const kind = fraudAlertKind(event.type);
  const signalId = data.earlyFraudWarningId ?? data.providerReviewId ?? data.providerEventId;
  return {
    messageType: `payments.${kind}`,
    criticality: "operational",
    title: "Stripe fraud signal received",
    body: `Stripe ${kind} for payment ${data.paymentId}.`,
    templateId: "payments-fraud-alert-v1",
    templateVersion: 1,
    locale: "en-US",
    templateData: {
      kind,
      paymentId: data.paymentId,
      buyerAccountId: data.buyerAccountId,
      orderIds: data.orderIds.join(","),
      providerEventId: data.providerEventId,
      signalId,
      providerChargeReference: data.providerChargeReference ?? null,
      fraudType: data.fraudType ?? null,
      reason: data.reason ?? null,
      outcome: data.outcome ?? null,
      chargeDisputed: data.chargeDisputed ?? null,
      occurredAt: occurredAt(data, event.timing.occurredAt),
    },
    channels: [
      {
        channel: "ops-alert",
        payload: {
          context: "payments",
          kind,
          paymentId: data.paymentId,
          buyerAccountId: data.buyerAccountId,
          orderIds: data.orderIds.join(","),
          signalId,
        },
      },
    ],
    idempotencyKey: `payments:fraud-alert:${event.id}`,
    correlationId: event.trace.traceId ?? event.id,
    actor: { accountId: data.buyerAccountId as never },
  };
}

export async function projectPaymentFraudSignalToAlert(
  outbox: NotificationOutbox,
  event: TransportEvent,
  projectionName = PAYMENTS_FRAUD_ALERT_PROJECTION,
) {
  await outbox.enqueueNotification({
    message: fraudAlertMessage(event),
    source: {
      sourceEventId: event.id,
      sourceGlobalPosition: event.globalPosition,
      projectionName,
      occurredAt: event.timing.occurredAt,
    },
  });
}

export function buildPaymentFraudAlertProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = PAYMENTS_FRAUD_ALERT_PROJECTION,
): ProjectorHandlerMap {
  return {
    "payments.payment-fraud-warning-received": (event) =>
      projectPaymentFraudSignalToAlert(outbox, event, projectionName),
    "payments.payment-fraud-review-opened": (event) => projectPaymentFraudSignalToAlert(outbox, event, projectionName),
    "payments.payment-fraud-review-closed": (event) => projectPaymentFraudSignalToAlert(outbox, event, projectionName),
  };
}
