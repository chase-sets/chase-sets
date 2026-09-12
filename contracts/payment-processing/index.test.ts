import { describe, expect, it } from "vitest";
import { parseProcessorSetupSessionCancellationResult, type PaymentProcessorGateway } from ".";

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
      cancelSetupSession: async () => ({ outcome: "already-terminal", processorStatus: "canceled" }),
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

  it.each([
    { outcome: "cancelled", processorStatus: "canceled" },
    { outcome: "already-terminal", processorStatus: "canceled" },
    { outcome: "not-found" },
    { outcome: "refused", reason: "invalid-reference", httpStatus: null },
    { outcome: "refused", reason: "transport-failure", httpStatus: null },
    { outcome: "refused", reason: "provider-rejected", httpStatus: 409 },
    { outcome: "refused", reason: "unexpected-status", httpStatus: 200 },
  ])("round-trips the closed setup-session cancellation shape %#", (value) => {
    expect(parseProcessorSetupSessionCancellationResult(value)).toStrictEqual(value);
  });

  it("accepts both explicitly terminal processor statuses", () => {
    expect(
      parseProcessorSetupSessionCancellationResult({ outcome: "already-terminal", processorStatus: "succeeded" }),
    ).toStrictEqual({ outcome: "already-terminal", processorStatus: "succeeded" });
  });

  it.each([
    null,
    [],
    {},
    { outcome: "cancelled" },
    { outcome: "cancelled", processorStatus: "canceled", diagnostic: "optional text" },
    { outcome: "cancelled", processorStatus: "succeeded" },
    { outcome: "already-terminal" },
    { outcome: "already-terminal", processorStatus: "processing" },
    { outcome: "not-found", processorSetupReference: "seti_must_not_escape" },
    { outcome: "missing-outcome" },
    { outcome: "refused", reason: "missing-reason" },
    { outcome: "refused", reason: "new-reason", httpStatus: null },
    { outcome: "refused", reason: "invalid-reference", httpStatus: 400 },
    { outcome: "refused", reason: "transport-failure", httpStatus: 503 },
    { outcome: "refused", reason: "provider-rejected", httpStatus: null },
    { outcome: "refused", reason: "provider-rejected", httpStatus: 409.5 },
    { outcome: "refused", reason: "provider-rejected", httpStatus: 99 },
    { outcome: "refused", reason: "provider-rejected", httpStatus: 600 },
    { outcome: "refused", reason: "unexpected-status", httpStatus: null },
    { outcome: "refused", reason: "unexpected-status", httpStatus: 201 },
    { outcome: "refused", reason: "unexpected-status", httpStatus: 200, error: { message: "raw" } },
  ])("refuses non-contract setup-session cancellation value %#", (value) => {
    expect(parseProcessorSetupSessionCancellationResult(value)).toBeNull();
  });
});
