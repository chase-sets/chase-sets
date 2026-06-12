import { describe, expect, it } from "vitest";
import { createFakePaymentProcessorGateway } from "./test-support";

describe("fake payment processor gateway", () => {
  it("implements the payment processor port", async () => {
    const gateway = createFakePaymentProcessorGateway();

    const payment = await gateway.createPaymentSession({
      paymentId: "pay_123" as never,
      buyerAccountId: "acc_buyer" as never,
      orderIds: ["ord_123" as never],
      amount: "12.34",
      currencyCode: "usd",
      paymentMethodCategory: "card",
      description: "Test payment",
    });

    expect(payment).toMatchObject({
      processorName: "stripe",
      processorPaymentReference: "cs_seed_pay_123",
      processorStatus: "open",
    });
  });
});
