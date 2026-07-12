import { describe, expect, it } from "vitest";
import type { PaymentProcessorGateway } from ".";

describe("payment processing contract", () => {
  it("keeps the processor port provider-neutral", () => {
    const gateway = {
      getPublicConfiguration: () => ({
        processorName: "stripe",
        publishableKey: null,
        confirmationExperience: "processor-managed-form",
        dynamicPaymentMethods: true,
        sensitivePaymentDetailsHandledByProcessor: true,
      }),
      createPaymentSession: async () => ({
        processorName: "stripe",
        processorPaymentKind: "checkout-session",
        processorPaymentReference: "pi_test",
        processorClientSecret: null,
        processorRedirectUrl: null,
        processorStatus: "requires_payment_method",
      }),
      createCustomer: async () => ({
        processorName: "stripe",
        providerCustomerReference: "cus_test",
      }),
      createSetupSession: async () => ({
        processorName: "stripe",
        processorSetupKind: "checkout-setup-session",
        processorSetupReference: "cs_setup_test",
        processorClientSecret: null,
        processorRedirectUrl: "https://checkout.stripe.test/setup",
        processorStatus: "open",
      }),
      retrieveSetupSessionResult: async () => ({
        processorName: "stripe",
        processorSetupReference: "cs_setup_test",
        processorStatus: "complete",
        setupIntentReference: "seti_test",
        savedPaymentMethod: null,
      }),
      retrieveSavedPaymentMethod: async () => null,
      detachSavedPaymentMethod: async () => null,
      cancelPayment: async (processorPaymentReference: string) => ({
        processorName: "stripe",
        processorPaymentKind: "payment-intent",
        processorPaymentReference,
        processorStatus: "canceled",
        outcome: "cancelled",
        occurredAt: "2026-07-12T00:00:00.000Z",
      }),
      retrievePaymentResult: async () => null,
      createRefund: async () => ({
        processorName: "stripe",
        processorRefundReference: "re_test",
        processorStatus: "succeeded",
      }),
      parseWebhook: async () => null,
    } satisfies PaymentProcessorGateway;

    expect(gateway.getPublicConfiguration().processorName).toBe("stripe");
    expect(gateway.getPublicConfiguration()).toMatchObject({
      confirmationExperience: "processor-managed-form",
      dynamicPaymentMethods: true,
      sensitivePaymentDetailsHandledByProcessor: true,
    });
  });
});
