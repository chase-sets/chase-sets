import type {
  CreateProcessorCustomerInput,
  CreateProcessorPaymentInput,
  CreateProcessorRefundInput,
  CreateProcessorSetupSessionInput,
  PaymentProcessorGateway,
  PaymentProcessorWebhookEvent,
  ProcessorSavedPaymentMethod,
} from "./index";

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
  return `re_seed_${input.refundId}`;
}

function fakeSavedPaymentMethod(
  providerReference: string,
  customerReference = "cus_seed",
): ProcessorSavedPaymentMethod {
  return {
    processorName: "stripe",
    providerCustomerReference: customerReference,
    providerReference,
    paymentMethodCategory: providerReference.includes("bank") ? "bank-account" : "card",
    displayLabel: providerReference.includes("bank") ? "Bank account ending in 6789" : "Visa ending in 4242",
    readiness: "ready",
    allowRedisplay: "always",
    removed: false,
  };
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
    async createCustomer(input: CreateProcessorCustomerInput) {
      return {
        processorName: "stripe",
        providerCustomerReference: `cus_seed_${input.accountId.replaceAll(/[^a-zA-Z0-9]+/g, "_")}`,
      };
    },
    async createSetupSession(input: CreateProcessorSetupSessionInput) {
      return {
        processorName: "stripe",
        processorSetupKind: "checkout-setup-session",
        processorSetupReference: `cs_setup_seed_${input.accountId}`,
        processorClientSecret: `cs_setup_seed_${input.accountId}_secret_seed`,
        processorRedirectUrl: `https://checkout.stripe.test/setup/${input.accountId}`,
        processorStatus: "open",
      };
    },
    async retrieveSetupSessionResult(processorSetupReference) {
      return {
        processorName: "stripe",
        processorSetupReference,
        processorStatus: "complete",
        setupIntentReference: `seti_${processorSetupReference}`,
        savedPaymentMethod: fakeSavedPaymentMethod(`pm_${processorSetupReference}`, "cus_seed"),
      };
    },
    async retrieveSavedPaymentMethod(providerReference) {
      return fakeSavedPaymentMethod(providerReference);
    },
    async detachSavedPaymentMethod(providerReference) {
      return {
        ...fakeSavedPaymentMethod(providerReference),
        providerCustomerReference: null,
        readiness: "removed",
        removed: true,
      };
    },
    async createPaymentSession(input) {
      return {
        processorName: "stripe",
        processorPaymentKind: input.savedCheckoutInstrument ? "payment-intent" : "checkout-session",
        processorPaymentReference: input.savedCheckoutInstrument
          ? `pi_seed_${input.paymentId}`
          : createPaymentReference(input),
        processorClientSecret: input.savedCheckoutInstrument
          ? `pi_seed_${input.paymentId}_secret_seed`
          : `cs_seed_${input.paymentId}_secret_seed`,
        processorRedirectUrl: null,
        processorStatus: input.savedCheckoutInstrument ? "succeeded" : "open",
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
