import { describe, expect, it } from "vitest";
import type { PaymentProcessorGateway } from ".";

describe("payment processing contract", () => {
  it("keeps the processor port provider-neutral", () => {
    const gateway = {
      getPublicConfiguration: () => ({
        processorName: "stripe",
        publishableKey: null,
      }),
      createPaymentIntent: async () => ({
        processorName: "stripe",
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
  });
});
