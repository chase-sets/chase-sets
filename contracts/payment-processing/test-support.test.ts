import { describe, expect, it } from "vitest";
import { createFakePaymentProcessorGateway } from "./test-support";
import { testPaymentProcessorGatewayContract } from "./gateway-contract.test-support";

testPaymentProcessorGatewayContract(createFakePaymentProcessorGateway, {
  createWebhookInput: (kind) => ({
    rawBody: JSON.stringify({
      eventId: `evt_${kind}`,
      kind,
      processorPaymentReference: "pi_gateway_contract",
      processorStatus: kind === "payment-captured" ? "succeeded" : "requires_payment_method",
      occurredAt: "2026-07-13T00:00:00.000Z",
    }),
    signatureHeader: null,
  }),
});

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
