import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createStripePaymentProcessorGateway } from ".";

function signature(rawBody: string, secret: string, timestamp: number) {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

describe("Stripe payment processor gateway", () => {
  it("creates PaymentIntents through Stripe with API version and metadata", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "pi_123",
          client_secret: "pi_123_secret",
          status: "requires_payment_method",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: "whsec_test",
      apiBaseUrl: "https://stripe.test",
    });
    const payment = await gateway.createPaymentIntent({
      paymentId: "pay_123" as never,
      buyerAccountId: "acc_buyer" as never,
      orderIds: ["ord_123" as never],
      amount: "12.34",
      currencyCode: "usd",
      description: "Test payment",
    });

    expect(payment.processorPaymentReference).toBe("pi_123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://stripe.test/v1/payment_intents",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Headers).get("Stripe-Version")).toBe("2026-02-25.clover");
    expect((init.headers as Headers).get("Idempotency-Key")).toBe(
      "payments:payment:pay_123:create",
    );
    expect(String(init.body)).toContain("metadata%5Bpayment_id%5D=pay_123");
    expect(String(init.body)).toContain(
      "payment_method_options%5Bcard%5D%5Brequest_three_d_secure%5D=automatic",
    );

    vi.unstubAllGlobals();
  });

  it("parses signed Stripe payment failure webhooks into provider-neutral events", async () => {
    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: "whsec_test",
      webhookToleranceSeconds: 1_000,
    });
    const now = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({
      id: "evt_123",
      type: "payment_intent.payment_failed",
      created: now,
      data: {
        object: {
          id: "pi_123",
          status: "requires_payment_method",
          last_payment_error: {
            code: "card_declined",
            message: "The card was declined.",
          },
        },
      },
    });

    await expect(
      gateway.parseWebhook({
        rawBody,
        signatureHeader: signature(rawBody, "whsec_test", now),
      }),
    ).resolves.toMatchObject({
      eventId: "evt_123",
      kind: "payment-failed",
      processorPaymentReference: "pi_123",
      failureCode: "card_declined",
    });
  });
});
