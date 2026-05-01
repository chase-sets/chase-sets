import type {
  CreateProcessorPaymentInput,
  CreateProcessorRefundInput,
  PaymentProcessorGateway,
  PaymentProcessorWebhookEvent,
} from "@chase-sets/payment-processing";

type FakeWebhookEnvelope = Readonly<{
  eventId?: string;
  kind: PaymentProcessorWebhookEvent["kind"];
  processorPaymentReference: string;
  processorStatus: string;
  failureCode?: string | null;
  failureMessage?: string | null;
  occurredAt: string;
}>;

export type FakePaymentProcessorGatewayOptions = Readonly<{
  publishableKey?: string | null;
}>;

function createPaymentReference(input: CreateProcessorPaymentInput) {
  return `cs_seed_${input.paymentId}`;
}

function createRefundReference(input: CreateProcessorRefundInput) {
  return `re_seed_${input.paymentId}_${input.amount.replace(".", "_")}`;
}

export function createFakePaymentProcessorGateway(
  options: FakePaymentProcessorGatewayOptions = {},
): PaymentProcessorGateway {
  return {
    getPublicConfiguration() {
      return {
        processorName: "stripe",
        publishableKey: options.publishableKey ?? "pk_seed_offline",
        confirmationExperience: "processor-managed-form",
        dynamicPaymentMethods: true,
        sensitivePaymentDetailsHandledByProcessor: true,
      };
    },
    async createPaymentSession(input) {
      return {
        processorName: "stripe",
        processorPaymentKind: "checkout-session",
        processorPaymentReference: createPaymentReference(input),
        processorClientSecret: `cs_seed_${input.paymentId}_secret_seed`,
        processorStatus: "open",
      };
    },
    async createRefund(input) {
      if (input.reason.trim().toLowerCase().includes("fail")) {
        throw new Error("Seeded refund failure.");
      }

      return {
        processorName: "stripe",
        processorRefundReference: createRefundReference(input),
        processorStatus: "succeeded",
      };
    },
    async parseWebhook(input) {
      if (!input.rawBody.trim()) {
        return null;
      }

      const body = JSON.parse(input.rawBody) as FakeWebhookEnvelope;
      return {
        eventId: body.eventId ?? `evt_seed_${body.kind}_${body.processorPaymentReference}`,
        kind: body.kind,
        processorName: "stripe",
        processorPaymentKind: "checkout-session",
        processorPaymentReference: body.processorPaymentReference,
        internalPaymentId: null,
        processorStatus: body.processorStatus,
        failureCode: body.failureCode ?? null,
        failureMessage: body.failureMessage ?? null,
        occurredAt: body.occurredAt,
      };
    },
  };
}
