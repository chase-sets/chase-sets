import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createStripePaymentProcessorGateway } from ".";

function signature(rawBody: string, secret: string, timestamp: number) {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function formSnapshot(body: BodyInit | null | undefined) {
  return Object.fromEntries(new URLSearchParams(String(body)).entries());
}

describe("Stripe payment processor gateway", () => {
  it("creates Checkout Sessions through Stripe with API version, managed Elements, and metadata", async () => {
    const fetchMock = vi.fn(
      async () =>
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
      paymentMethodCategory: "card",
      description: "Test payment",
      returnUrl: "https://marketplace.test/account/payments/pay_123",
      marketplaceRiskMetadata: {
        seller_account_ids: "acc_seller",
        seller_account_count: 1,
        high_dollar_order: true,
        fulfillment_required: true,
      },
    });

    expect(payment.processorPaymentReference).toBe("cs_123");
    expect(gateway.getPublicConfiguration().dynamicPaymentMethods).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://stripe.test/v1/checkout/sessions",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Headers).get("Stripe-Version")).toBe("2026-03-25.dahlia");
    expect((init.headers as Headers).get("Idempotency-Key")).toBe("payments:payment:pay_123:create");
    expect(String(init.body)).toContain("ui_mode=elements");
    expect(String(init.body)).toContain("mode=payment");
    expect(String(init.body)).toContain("return_url=https%3A%2F%2Fmarketplace.test%2Faccount%2Fpayments%2Fpay_123");
    expect(String(init.body)).toContain("metadata%5Bpayment_id%5D=pay_123");
    expect(formSnapshot(init.body)).toMatchObject({
      mode: "payment",
      ui_mode: "elements",
      return_url: "https://marketplace.test/account/payments/pay_123",
      client_reference_id: "pay_123",
      "line_items[0][price_data][product_data][name]": "Test payment",
      "metadata[funds_strategy]": "platform-held",
      "metadata[explicit_payment_method_selection]": "true",
      "metadata[seller_account_ids]": "acc_seller",
      "metadata[high_dollar_order]": "true",
      "payment_intent_data[metadata][seller_account_count]": "1",
      "payment_intent_data[metadata][explicit_payment_method_selection]": "true",
      "payment_intent_data[transfer_group]": "payment:pay_123",
    });
    expect(formSnapshot(init.body)).not.toHaveProperty("payment_intent_data[transfer_data][destination]");
    expect(formSnapshot(init.body)).not.toHaveProperty("payment_intent_data[on_behalf_of]");
    expect(formSnapshot(init.body)).not.toHaveProperty("description");
    expect(formSnapshot(init.body)).not.toHaveProperty(
      "payment_intent_data[payment_method_options][card][request_three_d_secure]",
    );

    vi.unstubAllGlobals();
  });

  it("bounds order id metadata for many-order Checkout Session create requests", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "cs_many_orders",
            client_secret: "cs_many_orders_secret",
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
    const orderIds = Array.from({ length: 50 }, (_, index) => `ord_${String(index + 1).padStart(26, "0")}` as never);

    await gateway.createPaymentSession({
      paymentId: "pay_many_orders" as never,
      buyerAccountId: "acc_buyer_many" as never,
      orderIds,
      amount: "123.45",
      currencyCode: "usd",
      paymentMethodCategory: "card",
      description: "Many-order payment",
      returnUrl: "https://marketplace.test/account/payments/pay_many_orders",
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const snapshot = formSnapshot(init.body);
    const metadataEntries = Object.entries(snapshot).filter(
      ([key]) => key.startsWith("metadata[") || key.startsWith("payment_intent_data[metadata]"),
    );

    expect(metadataEntries.length).toBeGreaterThan(0);
    for (const [key, value] of metadataEntries) {
      expect(value.length, key).toBeLessThanOrEqual(500);
    }
    expect(snapshot).toMatchObject({
      "metadata[payment_id]": "pay_many_orders",
      "metadata[buyer_account_id]": "acc_buyer_many",
      "metadata[order_count]": "50",
      "metadata[order_ids_truncated]": "true",
      "payment_intent_data[metadata][payment_id]": "pay_many_orders",
      "payment_intent_data[metadata][buyer_account_id]": "acc_buyer_many",
      "payment_intent_data[metadata][order_count]": "50",
      "payment_intent_data[metadata][order_ids_truncated]": "true",
    });
    expect(snapshot["metadata[order_ids]"]?.split(",")).toEqual(
      snapshot["payment_intent_data[metadata][order_ids]"]?.split(","),
    );
    expect(snapshot["metadata[order_ids]"]?.split(",").length).toBeLessThan(orderIds.length);

    vi.unstubAllGlobals();
  });

  it("retrieves payment reconciliation state by local payment metadata", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "pi_orphan",
                status: "succeeded",
                metadata: { payment_id: "pay_orphan" },
              },
            ],
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

    await expect(gateway.retrievePaymentResultByPaymentId?.("pay_orphan" as never)).resolves.toMatchObject({
      processorName: "stripe",
      processorPaymentKind: "payment-intent",
      processorPaymentReference: "pi_orphan",
      processorStatus: "succeeded",
      outcome: "captured",
      internalPaymentId: "pay_orphan",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://stripe.test/v1/payment_intents/search?"),
      expect.objectContaining({ method: "GET" }),
    );
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(decodeURIComponent(url)).toContain("metadata['payment_id']:'pay_orphan'");

    vi.unstubAllGlobals();
  });

  it("creates Stripe customers and hosted setup sessions for saved payment methods", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "cus_123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "cs_setup_123",
            url: "https://checkout.stripe.com/c/setup/cs_setup_123",
            status: "open",
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
    const customer = await gateway.createCustomer({
      accountId: "acc_buyer" as never,
      displayName: "Buyer",
      email: "buyer@example.com",
    });
    const setup = await gateway.createSetupSession({
      accountId: "acc_buyer" as never,
      providerCustomerReference: customer.providerCustomerReference,
      currencyCode: "usd",
      returnUrl: "https://marketplace.test/account/payment-methods?setupReferenceId=scs_1",
      consentId: "consent_1",
      consentText: "Save for future checkout.",
    });

    expect(customer.providerCustomerReference).toBe("cus_123");
    expect(setup.processorSetupReference).toBe("cs_setup_123");
    expect(setup.processorRedirectUrl).toBe("https://checkout.stripe.com/c/setup/cs_setup_123");
    const [customerUrl, customerInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(customerUrl).toBe("https://stripe.test/v1/customers");
    expect(formSnapshot(customerInit.body)).toMatchObject({
      name: "Buyer",
      email: "buyer@example.com",
      "metadata[account_id]": "acc_buyer",
    });
    const [setupUrl, setupInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(setupUrl).toBe("https://stripe.test/v1/checkout/sessions");
    expect(formSnapshot(setupInit.body)).toMatchObject({
      mode: "setup",
      ui_mode: "hosted",
      customer: "cus_123",
      success_url: "https://marketplace.test/account/payment-methods?setupReferenceId=scs_1",
      "metadata[saved_payment_consent_id]": "consent_1",
      "metadata[saved_payment_consent_text]": "Save for future checkout.",
    });

    vi.unstubAllGlobals();
  });

  it("charges selected Stripe saved payment methods with customer and payment method references", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "pi_saved", client_secret: "pi_saved_secret", status: "succeeded" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: "whsec_test",
      apiBaseUrl: "https://stripe.test",
    });
    const payment = await gateway.createPaymentSession({
      paymentId: "pay_saved" as never,
      buyerAccountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      amount: "26.05",
      currencyCode: "usd",
      paymentMethodCategory: "card",
      description: "Saved payment",
      savedCheckoutInstrument: {
        instrumentId: "sci_card_1",
        providerCustomerReference: "cus_123",
        providerReference: "pm_123",
        confirmationExperience: "off-session-token",
        displayLabel: "Visa ending in 4242",
      },
    });

    expect(payment.processorPaymentKind).toBe("payment-intent");
    expect(payment.processorPaymentReference).toBe("pi_saved");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://stripe.test/v1/payment_intents");
    expect(formSnapshot(init.body)).toMatchObject({
      amount: "2605",
      currency: "usd",
      customer: "cus_123",
      payment_method: "pm_123",
      confirm: "true",
      off_session: "true",
      "metadata[saved_checkout_instrument_id]": "sci_card_1",
    });
    expect(formSnapshot(init.body)).not.toHaveProperty("transfer_data[destination]");
    expect(formSnapshot(init.body)).not.toHaveProperty("on_behalf_of");

    vi.unstubAllGlobals();
  });

  it("creates agentic PaymentIntents with a Stripe shared payment token", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "pi_agentic",
            client_secret: "pi_agentic_secret",
            status: "succeeded",
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
    const payment = await gateway.createAgenticPaymentSession?.({
      paymentId: "pay_agentic" as never,
      buyerAccountId: "acc_buyer" as never,
      orderIds: ["ord_agentic" as never],
      amount: "20.00",
      currencyCode: "usd",
      paymentMethodCategory: "card",
      description: "Agentic payment",
      idempotencyKey: "idem_agentic",
      agenticPayment: {
        kind: "stripe-shared-payment-token",
        sharedPaymentGrantedToken: "spt_123",
        ap2CheckoutMandateId: "ap2_checkout_1",
        ap2PaymentMandateId: "ap2_payment_1",
      },
      marketplaceRiskMetadata: {
        seller_account_ids: "acc_seller",
        high_dollar_order: false,
      },
    });

    expect(payment?.processorPaymentKind).toBe("payment-intent");
    expect(payment?.processorPaymentReference).toBe("pi_agentic");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://stripe.test/v1/payment_intents",
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Headers).get("Stripe-Version")).toBe("2026-03-25.dahlia");
    expect((init.headers as Headers).get("Idempotency-Key")).toBe("idem_agentic");
    expect(formSnapshot(init.body)).toMatchObject({
      amount: "2000",
      currency: "usd",
      shared_payment_granted_token: "spt_123",
      confirm: "true",
      "metadata[payment_id]": "pay_agentic",
      "metadata[order_ids]": "ord_agentic",
      "metadata[ucp_payment_handler]": "stripe-shared-payment-token",
      "metadata[ap2_checkout_mandate_id]": "ap2_checkout_1",
      "metadata[ap2_payment_mandate_id]": "ap2_payment_1",
      "metadata[seller_account_ids]": "acc_seller",
      "metadata[high_dollar_order]": "false",
    });

    vi.unstubAllGlobals();
  });

  it("uses the local refund id for Stripe refund idempotency", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "re_123", status: "succeeded" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: "whsec_test",
      apiBaseUrl: "https://stripe.test",
    });

    await gateway.createRefund({
      refundId: "rfd_first",
      paymentId: "pay_123" as never,
      processorPaymentReference: "pi_123",
      orderIds: ["ord_1" as never],
      amount: "4.00",
      currencyCode: "usd",
      reason: "First partial refund",
    });
    await gateway.createRefund({
      refundId: "rfd_second",
      paymentId: "pay_123" as never,
      processorPaymentReference: "pi_123",
      orderIds: ["ord_2" as never],
      amount: "4.00",
      currencyCode: "usd",
      reason: "Second partial refund",
    });

    const [, firstInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [, secondInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect((firstInit.headers as Headers).get("Idempotency-Key")).toBe("payments:refund:rfd_first");
    expect((secondInit.headers as Headers).get("Idempotency-Key")).toBe("payments:refund:rfd_second");
    expect(formSnapshot(firstInit.body)).toMatchObject({
      payment_intent: "pi_123",
      amount: "400",
      "metadata[payment_id]": "pay_123",
      "metadata[refund_id]": "rfd_first",
    });

    vi.unstubAllGlobals();
  });

  it("captures synchronous paid Checkout Session completion webhooks", async () => {
    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: "whsec_test",
      webhookToleranceSeconds: 1_000,
    });
    const now = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({
      id: "evt_checkout_paid",
      type: "checkout.session.completed",
      created: now,
      data: {
        object: {
          id: "cs_paid",
          mode: "payment",
          status: "complete",
          payment_status: "paid",
          metadata: { payment_id: "pay_123" },
        },
      },
    });

    await expect(
      gateway.parseWebhook({
        rawBody,
        signatureHeader: signature(rawBody, "whsec_test", now),
      }),
    ).resolves.toMatchObject({
      eventId: "evt_checkout_paid",
      kind: "payment-captured",
      processorPaymentKind: "checkout-session",
      processorPaymentReference: "cs_paid",
      internalPaymentId: "pay_123",
      processorStatus: "paid",
    });
  });

  it("records unpaid Checkout Session completion webhooks as authorization without capture", async () => {
    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: "whsec_test",
      webhookToleranceSeconds: 1_000,
    });
    const now = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({
      id: "evt_checkout_unpaid",
      type: "checkout.session.completed",
      created: now,
      data: {
        object: {
          id: "cs_unpaid",
          mode: "payment",
          status: "complete",
          payment_status: "unpaid",
          metadata: { payment_id: "pay_ach" },
        },
      },
    });

    await expect(
      gateway.parseWebhook({
        rawBody,
        signatureHeader: signature(rawBody, "whsec_test", now),
      }),
    ).resolves.toMatchObject({
      eventId: "evt_checkout_unpaid",
      kind: "payment-authorized",
      processorPaymentKind: "checkout-session",
      processorPaymentReference: "cs_unpaid",
      internalPaymentId: "pay_ach",
      processorStatus: "unpaid",
    });
  });

  it("captures delayed Checkout Session payments only after async success", async () => {
    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: "whsec_test",
      webhookToleranceSeconds: 1_000,
    });
    const now = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({
      id: "evt_checkout_async_succeeded",
      type: "checkout.session.async_payment_succeeded",
      created: now,
      data: {
        object: {
          id: "cs_ach",
          mode: "payment",
          status: "complete",
          payment_status: "paid",
          metadata: { payment_id: "pay_ach" },
        },
      },
    });

    await expect(
      gateway.parseWebhook({
        rawBody,
        signatureHeader: signature(rawBody, "whsec_test", now),
      }),
    ).resolves.toMatchObject({
      eventId: "evt_checkout_async_succeeded",
      kind: "payment-captured",
      processorPaymentKind: "checkout-session",
      processorPaymentReference: "cs_ach",
      internalPaymentId: "pay_ach",
      processorStatus: "paid",
    });
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

  it("ignores aggregate charge refunds and correlates refund and dispute webhooks through PaymentIntent references", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "ch_123",
            payment_intent: "pi_123",
            amount_refunded: 400,
            metadata: { payment_id: "pay_123" },
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
      webhookToleranceSeconds: 1_000,
    });
    const now = Math.floor(Date.now() / 1000);
    const chargeRefundBody = JSON.stringify({
      id: "evt_charge_refund",
      type: "charge.refunded",
      created: now,
      data: {
        object: {
          id: "ch_123",
          status: "succeeded",
          payment_intent: "pi_123",
          amount_refunded: 400,
          currency: "usd",
          metadata: { payment_id: "pay_123" },
        },
      },
    });
    const refundBody = JSON.stringify({
      id: "evt_refund",
      type: "refund.updated",
      created: now,
      data: {
        object: {
          id: "re_123",
          status: "succeeded",
          payment_intent: "pi_123",
          charge: "ch_123",
          amount: 400,
          currency: "usd",
          metadata: {
            payment_id: "pay_123",
            refund_id: "rfd_123",
            order_ids: "ord_1",
          },
        },
      },
    });
    const disputeBody = JSON.stringify({
      id: "evt_dispute",
      type: "charge.dispute.created",
      created: now,
      data: {
        object: {
          id: "dp_123",
          status: "needs_response",
          charge: "ch_123",
          payment_intent: "pi_123",
          metadata: { payment_id: "pay_123" },
        },
      },
    });

    await expect(
      gateway.parseWebhook({
        rawBody: chargeRefundBody,
        signatureHeader: signature(chargeRefundBody, "whsec_test", now),
      }),
    ).resolves.toBeNull();
    await expect(
      gateway.parseWebhook({
        rawBody: refundBody,
        signatureHeader: signature(refundBody, "whsec_test", now),
      }),
    ).resolves.toMatchObject({
      eventId: "evt_refund",
      kind: "payment-refunded",
      processorPaymentReference: "pi_123",
      providerObjectReference: "re_123",
      processorRefundReference: "re_123",
      refundId: "rfd_123",
      orderIds: ["ord_1"],
      internalPaymentId: "pay_123",
      amount: "4.00",
      refundedAmount: "4.00",
    });
    await expect(
      gateway.parseWebhook({
        rawBody: disputeBody,
        signatureHeader: signature(disputeBody, "whsec_test", now),
      }),
    ).resolves.toMatchObject({
      eventId: "evt_dispute",
      kind: "payment-disputed",
      processorPaymentReference: "pi_123",
      providerObjectReference: "dp_123",
      internalPaymentId: "pay_123",
      failureCode: "charge.dispute.created",
      failureMessage: "needs_response",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://stripe.test/v1/charges/ch_123",
      expect.objectContaining({ method: "GET" }),
    );
    vi.unstubAllGlobals();
  });

  it("does not default charge refund webhooks into payment refund facts", async () => {
    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: "whsec_test",
      webhookToleranceSeconds: 1_000,
    });
    const now = Math.floor(Date.now() / 1000);
    const refundBody = JSON.stringify({
      id: "evt_refund_missing_amount",
      type: "charge.refunded",
      created: now,
      data: {
        object: {
          id: "ch_123",
          status: "succeeded",
          payment_intent: "pi_123",
          amount: 1000,
          currency: "usd",
          metadata: { payment_id: "pay_123" },
        },
      },
    });

    await expect(
      gateway.parseWebhook({
        rawBody: refundBody,
        signatureHeader: signature(refundBody, "whsec_test", now),
      }),
    ).resolves.toBeNull();
  });
});
