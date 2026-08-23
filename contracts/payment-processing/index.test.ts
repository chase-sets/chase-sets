import { describe, expect, it } from "vitest";
import type { PaymentProcessorGateway, ProcessorSetupSessionCancellationResult } from ".";
import { parseProcessorSetupSessionCancellationResult } from ".";

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
      cancelSetupSession: async () => ({
        outcome: "cancelled",
        processorStatus: "canceled",
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

  it("closes the setup-session cancellation result", () => {
    const validCases: readonly ProcessorSetupSessionCancellationResult[] = [
      { outcome: "cancelled", processorStatus: "canceled" },
      { outcome: "already-terminal", processorStatus: "canceled" },
      { outcome: "already-terminal", processorStatus: "succeeded" },
      { outcome: "not-found" },
      { outcome: "refused", reason: "invalid-reference", httpStatus: null },
      { outcome: "refused", reason: "provider-rejected", httpStatus: 402 },
      { outcome: "refused", reason: "transport-failure", httpStatus: null },
      { outcome: "refused", reason: "unexpected-status", httpStatus: 200 },
    ];
    for (const validCase of validCases) {
      expect(parseProcessorSetupSessionCancellationResult(validCase)).toEqual(validCase);
    }

    const refusals: readonly Readonly<{ label: string; value: unknown }>[] = [
      { label: "unknown key", value: { outcome: "not-found", extra: "x" } },
      { label: "missing required key", value: { outcome: "cancelled" } },
      { label: "out-of-enum outcome", value: { outcome: "voided" } },
      { label: "out-of-enum reason", value: { outcome: "refused", reason: "mystery", httpStatus: null } },
      {
        label: "non-integer status",
        value: { outcome: "refused", reason: "provider-rejected", httpStatus: 402.5 },
      },
      { label: "status below 100", value: { outcome: "refused", reason: "provider-rejected", httpStatus: 99 } },
      { label: "status above 599", value: { outcome: "refused", reason: "provider-rejected", httpStatus: 600 } },
      {
        label: "invalid nullability (null where an integer is required)",
        value: { outcome: "refused", reason: "provider-rejected", httpStatus: null },
      },
      {
        label: "invalid nullability (integer where null is required)",
        value: { outcome: "refused", reason: "invalid-reference", httpStatus: 400 },
      },
      {
        label: "provider-shaped string",
        value: {
          outcome: "refused",
          reason: "provider-rejected",
          httpStatus: 402,
          message: "Your card was declined.",
        },
      },
      { label: "not an object", value: "cancelled" },
    ];
    for (const refusal of refusals) {
      expect(() => parseProcessorSetupSessionCancellationResult(refusal.value)).toThrow();
    }
  });
});
