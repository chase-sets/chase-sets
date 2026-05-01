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
        processorStatus: "requires_payment_method",
      }),
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
