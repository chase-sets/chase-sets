import { describe, expect, it } from "vitest";
import { createFakePaymentProcessorGateway } from ".";

describe("fake payment processor gateway", () => {
  it("implements the payment processor port", async () => {
    const gateway = createFakePaymentProcessorGateway();

    const payment = await gateway.createPaymentIntent({
      paymentId: "pay_123" as never,
      buyerAccountId: "acc_buyer" as never,
      orderIds: ["ord_123" as never],
      amount: "12.34",
      currencyCode: "usd",
      description: "Test payment",
    });

    expect(payment).toMatchObject({
      processorName: "stripe",
      processorPaymentReference: "pi_seed_pay_123",
      processorStatus: "requires_capture",
    });
  });
});
