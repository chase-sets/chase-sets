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
  return `pi_seed_${input.paymentId}`;
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
    async createPaymentIntent(input) {
      return {
        processorName: "stripe",
        processorPaymentReference: createPaymentReference(input),
        processorClientSecret: `secret_seed_${input.paymentId}`,
        processorStatus: "requires_capture",
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
        processorPaymentReference: body.processorPaymentReference,
        processorStatus: body.processorStatus,
        failureCode: body.failureCode ?? null,
        failureMessage: body.failureMessage ?? null,
        occurredAt: body.occurredAt,
      };
    },
  };
}
