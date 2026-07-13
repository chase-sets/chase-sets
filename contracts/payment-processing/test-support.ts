import { afterEach, describe, expect, it } from "vitest";
import type {
  CreateProcessorCustomerInput,
  CreateProcessorPaymentInput,
  CreateProcessorRefundInput,
  CreateProcessorSetupSessionInput,
  PaymentProcessorGateway,
  PaymentProcessorWebhookEvent,
  ProcessorPaymentReconciliationResult,
  ProcessorSavedPaymentMethod,
} from "./index";

export type PaymentProcessorGatewayContractOptions = Readonly<{
  createWebhookInput: (
    kind: "payment-captured" | "payment-failed",
  ) => Readonly<{ rawBody: string; signatureHeader: string | null }>;
  prepare?: () => void | Promise<void>;
  assertIdempotency?: () => void;
  cleanup?: () => void;
}>;

/**
 * Behavioral contract shared by the offline fake and provider adapter.
 * Provider-specific webhook encoding stays with each adapter test while the
 * gateway port's status and event-kind vocabulary is asserted once.
 */
export function testPaymentProcessorGatewayContract(
  createGateway: () => PaymentProcessorGateway,
  options: PaymentProcessorGatewayContractOptions,
): void {
  const createPreparedGateway = async () => {
    await options.prepare?.();
    return createGateway();
  };

  describe("payment processor gateway contract", () => {
    afterEach(() => options.cleanup?.());

    it("keeps repeated payment creation idempotent and uses the shared status vocabulary", async () => {
      const gateway = await createPreparedGateway();
      const input: CreateProcessorPaymentInput = {
        paymentId: "pay_gateway_contract" as never,
        buyerAccountId: "acc_gateway_contract" as never,
        orderIds: ["ord_gateway_contract" as never],
        amount: "12.34",
        currencyCode: "usd",
        paymentMethodCategory: "card",
        description: "Gateway contract payment",
        idempotencyKey: "payments:contract:payment",
      };

      const first = await gateway.createPaymentSession(input);
      const retry = await gateway.createPaymentSession(input);

      expect(retry).toEqual(first);
      expect(first).toMatchObject({
        processorName: "stripe",
        processorPaymentKind: "checkout-session",
        processorStatus: expect.stringMatching(/^(open|unpaid)$/),
      });
      options.assertIdempotency?.();
    });

    it.each([
      ["payment-captured" as const, "payment-captured"],
      ["payment-failed" as const, "payment-failed"],
    ])("maps %s into the provider-neutral event kind", async (kind, expectedKind) => {
      const gateway = await createPreparedGateway();

      await expect(gateway.parseWebhook(options.createWebhookInput(kind))).resolves.toMatchObject({
        kind: expectedKind,
        processorStatus: expect.any(String),
      });
    });
  });
}

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
  paymentResults?: Readonly<Record<string, ProcessorPaymentReconciliationResult | null>>;
  paymentResultsByPaymentId?: Readonly<Record<string, ProcessorPaymentReconciliationResult | null>>;
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
  const paymentResults = new Map(Object.entries(options.paymentResults ?? {}));
  const paymentResultsByPaymentId = new Map(Object.entries(options.paymentResultsByPaymentId ?? {}));

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
      const embedded = input.uiMode === "embedded";
      return {
        processorName: "stripe",
        processorSetupKind: embedded ? "setup-intent" : "checkout-setup-session",
        processorSetupReference: embedded ? `seti_setup_seed_${input.accountId}` : `cs_setup_seed_${input.accountId}`,
        processorClientSecret: embedded
          ? `seti_setup_seed_${input.accountId}_secret_seed`
          : `cs_setup_seed_${input.accountId}_secret_seed`,
        processorRedirectUrl: embedded ? null : `https://checkout.stripe.test/setup/${input.accountId}`,
        processorStatus: embedded ? "requires_payment_method" : "open",
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
      const processorPaymentReference = input.savedCheckoutInstrument
        ? `pi_seed_${input.paymentId}`
        : createPaymentReference(input);
      const processorPaymentKind = input.savedCheckoutInstrument ? "payment-intent" : "checkout-session";
      const processorStatus = input.savedCheckoutInstrument ? "succeeded" : "open";
      const result: ProcessorPaymentReconciliationResult = {
        processorName: "stripe",
        processorPaymentKind,
        processorPaymentReference,
        processorStatus,
        outcome: processorStatus === "succeeded" ? "captured" : "pending",
        occurredAt: new Date().toISOString(),
        internalPaymentId: input.paymentId,
      };
      paymentResults.set(processorPaymentReference, result);
      paymentResultsByPaymentId.set(input.paymentId, result);

      return {
        processorName: "stripe",
        processorPaymentKind,
        processorPaymentReference,
        processorClientSecret: input.savedCheckoutInstrument
          ? `pi_seed_${input.paymentId}_secret_seed`
          : `cs_seed_${input.paymentId}_secret_seed`,
        processorRedirectUrl: null,
        processorStatus,
      };
    },
    async retrievePaymentResult(processorPaymentReference) {
      return paymentResults.get(processorPaymentReference) ?? null;
    },
    async cancelPayment(processorPaymentReference) {
      const existing = paymentResults.get(processorPaymentReference);
      const cancelled: ProcessorPaymentReconciliationResult = {
        processorName: "stripe",
        processorPaymentKind: "payment-intent",
        processorPaymentReference,
        processorStatus: "canceled",
        outcome: "cancelled",
        occurredAt: new Date().toISOString(),
        internalPaymentId: existing?.internalPaymentId ?? null,
      };
      paymentResults.set(processorPaymentReference, cancelled);
      return cancelled;
    },
    async retrievePaymentResultByPaymentId(paymentId) {
      return paymentResultsByPaymentId.get(paymentId) ?? null;
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
