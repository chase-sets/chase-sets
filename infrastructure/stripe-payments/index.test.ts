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
  it("creates Checkout Sessions through Stripe with API version, managed Elements, and metadata", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "cs_123",
          client_secret: "cs_123_secret",
          status: "open",
          payment_status: "unpaid",
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
    const payment = await gateway.createPaymentSession({
      paymentId: "pay_123" as never,
      buyerAccountId: "acc_buyer" as never,
      orderIds: ["ord_123" as never],
      amount: "12.34",
      currencyCode: "usd",
      description: "Test payment",
      returnUrl: "https://marketplace.test/account/payments/pay_123",
    });

    expect(payment.processorPaymentReference).toBe("cs_123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://stripe.test/v1/checkout/sessions",
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
    expect(String(init.body)).toContain("ui_mode=elements");
    expect(String(init.body)).toContain("mode=payment");
    expect(String(init.body)).toContain(
      "return_url=https%3A%2F%2Fmarketplace.test%2Faccount%2Fpayments%2Fpay_123",
    );
    expect(String(init.body)).toContain("metadata%5Bpayment_id%5D=pay_123");
    expect(String(init.body)).toContain(
      "payment_intent_data%5Bpayment_method_options%5D%5Bcard%5D%5Brequest_three_d_secure%5D=automatic",
    );

    vi.unstubAllGlobals();
  });

  it("can create a hosted Checkout Session fallback", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "cs_hosted",
          url: "https://checkout.stripe.com/c/pay/cs_hosted",
          status: "open",
          payment_status: "unpaid",
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
      checkoutUiMode: "hosted",
    });
    const payment = await gateway.createPaymentSession({
      paymentId: "pay_hosted" as never,
      buyerAccountId: "acc_buyer" as never,
      orderIds: ["ord_123" as never],
      amount: "12.34",
      currencyCode: "usd",
      description: "Test payment",
      returnUrl: "https://marketplace.test/account/payments/pay_hosted",
    });

    expect(gateway.getPublicConfiguration().confirmationExperience).toBe(
      "processor-hosted-page",
    );
    expect(payment.processorClientSecret).toBeNull();
    expect(payment.processorRedirectUrl).toBe(
      "https://checkout.stripe.com/c/pay/cs_hosted",
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toContain("ui_mode=hosted");
    expect(String(init.body)).toContain(
      "success_url=https%3A%2F%2Fmarketplace.test%2Faccount%2Fpayments%2Fpay_hosted",
    );
    expect(String(init.body)).toContain(
      "cancel_url=https%3A%2F%2Fmarketplace.test%2Faccount%2Fpayments%2Fpay_hosted",
    );
    expect(String(init.body)).not.toContain("return_url=");

    vi.unstubAllGlobals();
  });

  it("parses signed Stripe checkout failure webhooks into provider-neutral events", async () => {
    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: "whsec_test",
      webhookToleranceSeconds: 1_000,
    });
    const now = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({
      id: "evt_123",
      type: "checkout.session.async_payment_failed",
      created: now,
      data: {
        object: {
          id: "cs_123",
          status: "open",
          payment_status: "unpaid",
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
      processorPaymentReference: "cs_123",
      failureCode: "card_declined",
    });
  });
});
