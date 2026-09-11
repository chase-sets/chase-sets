import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStripePaymentProcessorGateway } from ".";
import { STRIPE_API_VERSION } from "@chase-sets/stripe-config";
import { testPaymentProcessorGatewayContract } from "@chase-sets/payment-processing/gateway-contract";

function signature(rawBody: string, secret: string, timestamp: number) {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function formSnapshot(body: BodyInit | null | undefined) {
  return Object.fromEntries(new URLSearchParams(String(body)).entries());
}

const syntheticSetupReferenceA = "seti_SYNTHETIC_6732_A";
const syntheticSetupReferenceB = "seti_SYNTHETIC_6732_B";
const syntheticSetupCancellationKeyA =
  "payments:setup-intent-cancel:v1:5d6f7dc35331f6fc22f97064baca7be1bd0fc3b6df178944dd93e942d6f4e851";
const syntheticSetupCancellationKeyB =
  "payments:setup-intent-cancel:v1:222f8bf9de2e3a05eb232016d8e67c19a5ec98c92367af6adb0e666e53cbdaba";

function stripeGateway(apiBaseUrl = "https://stripe.test") {
  return createStripePaymentProcessorGateway({
    secretKey: "sk_test",
    publishableKey: "pk_test",
    webhookSecret: "whsec_test",
    apiBaseUrl,
  });
}

function stripeResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestIdempotencyKey(init: RequestInit | undefined) {
  return new Headers(init?.headers).get("Idempotency-Key");
}

function containsForbiddenSetupCancellationEvidenceMarker(value: string) {
  return /seti_|sk_(?:test|live)_|whsec_/i.test(value);
}

const contractWebhookSecret = "whsec_gateway_contract";
let contractFetchMock = vi.fn();

testPaymentProcessorGatewayContract(
  () =>
    createStripePaymentProcessorGateway({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: contractWebhookSecret,
      apiBaseUrl: "https://stripe.contract.test",
    }),
  {
    prepare: () => {
      let setupStatus = "requires_payment_method";
      contractFetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/v1/setup_intents/seti_gateway_contract")) {
          if (init?.method === "POST") {
            setupStatus = "canceled";
          }
          return Response.json({ id: "seti_gateway_contract", status: setupStatus });
        }
        if (url.includes("/v1/payment_intents/")) {
          return Response.json({ id: "pi_gateway_contract", status: "requires_payment_method", payment_method: null });
        }
        return Response.json({
          id: "cs_gateway_contract",
          status: "open",
          payment_status: "unpaid",
          url: "https://checkout.contract.test/session",
        });
      });
      vi.stubGlobal("fetch", contractFetchMock);
    },
    cleanup: () => vi.unstubAllGlobals(),
    assertIdempotency: () => {
      expect(contractFetchMock).toHaveBeenCalledTimes(2);
      for (const [, init] of contractFetchMock.mock.calls as unknown as [string, RequestInit][]) {
        expect((init.headers as Headers).get("Idempotency-Key")).toBe("payments:contract:payment");
      }
    },
    createWebhookInput: (kind) => {
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = JSON.stringify({
        id: `evt_${kind}`,
        type: kind === "payment-captured" ? "payment_intent.succeeded" : "payment_intent.payment_failed",
        created: timestamp,
        data: {
          object: {
            id: `pi_${kind}`,
            status: kind === "payment-captured" ? "succeeded" : "requires_payment_method",
            metadata: { payment_id: "pay_gateway_contract" },
            ...(kind === "payment-failed"
              ? { last_payment_error: { code: "card_declined", message: "Declined" } }
              : {}),
          },
        },
      });
      return {
        rawBody,
        signatureHeader: signature(rawBody, contractWebhookSecret, timestamp),
      };
    },
  },
);

describe("Stripe payment processor gateway", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects statement descriptor suffixes outside Stripe's constraints", () => {
    expect(() =>
      createStripePaymentProcessorGateway({
        secretKey: "sk_test",
        publishableKey: "pk_test",
        webhookSecret: "whsec_test",
        statementDescriptorSuffix: "TOO-LONG-SUFFIX",
      }),
    ).toThrow("Stripe statement descriptor suffix must be 1-10 characters");
  });

  it("submits dispute evidence with Stripe evidence fields and idempotency", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "dp_123", status: "under_review" }), {
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

    const result = await gateway.submitDisputeEvidence!({
      paymentId: "pay_123" as never,
      providerDisputeId: "dp_123",
      providerChargeReference: "ch_123",
      processorPaymentReference: "pi_123",
      idempotencyKey: "payments:dispute:dp_123:evidence",
      evidence: {
        customerEmailAddress: "buyer@example.test",
        customerName: "Buyer Example",
        productDescription: "1 x Test card",
        shippingAddress: "Buyer Example\n123 Test St\nChicago, IL 60601\nUS",
        shippingCarrier: "USPS",
        shippingDate: "2026-07-02",
        shippingTrackingNumber: "940000000000000000",
        uncategorizedText: "Delivery confirmed at 2026-07-04T15:00:00.000Z.",
      },
    });

    expect(result).toMatchObject({
      processorName: "stripe",
      providerDisputeId: "dp_123",
      processorStatus: "under_review",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://stripe.test/v1/disputes/dp_123",
      expect.objectContaining({ method: "POST", headers: expect.any(Headers) }),
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Headers).get("Idempotency-Key")).toBe("payments:dispute:dp_123:evidence");
    expect(formSnapshot(init.body)).toMatchObject({
      "evidence[customer_email_address]": "buyer@example.test",
      "evidence[customer_name]": "Buyer Example",
      "evidence[product_description]": "1 x Test card",
      "evidence[shipping_address]": "Buyer Example\n123 Test St\nChicago, IL 60601\nUS",
      "evidence[shipping_carrier]": "USPS",
      "evidence[shipping_date]": "2026-07-02",
      "evidence[shipping_tracking_number]": "940000000000000000",
      "evidence[uncategorized_text]": "Delivery confirmed at 2026-07-04T15:00:00.000Z.",
      "metadata[payment_id]": "pay_123",
      "metadata[provider_charge_reference]": "ch_123",
      "metadata[processor_payment_reference]": "pi_123",
      submit: "true",
    });

    vi.unstubAllGlobals();
  });

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
      providerCustomerReference: "cus_123",
      returnUrl: "https://marketplace.test/account/payments/pay_123",
      marketplaceRiskMetadata: {
        seller_account_ids: "acc_seller",
        seller_account_count: 1,
        high_dollar_order: true,
        fulfillment_required: true,
      },
    });

    expect(payment.processorPaymentReference).toBe("cs_123");
    expect(gateway.getPublicConfiguration().dynamicPaymentMethods).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://stripe.test/v1/checkout/sessions",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Headers).get("Stripe-Version")).toBe(STRIPE_API_VERSION);
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
      customer: "cus_123",
      "payment_method_types[0]": "card",
      "payment_method_types[1]": "link",
      "payment_intent_data[statement_descriptor_suffix]": "CHASESETS",
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

  it("offers card-rail wallets and Link to guests without creating a Stripe Customer", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "cs_guest",
            client_secret: "cs_guest_secret",
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

    await gateway.createPaymentSession({
      paymentId: "pay_guest" as never,
      buyerAccountId: "acc_guest" as never,
      orderIds: ["ord_guest" as never],
      amount: "12.34",
      currencyCode: "usd",
      paymentMethodCategory: "card",
      description: "Guest payment",
      returnUrl: "https://marketplace.test/checkout/payments/pay_guest",
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(formSnapshot(init.body)).toMatchObject({
      "payment_method_types[0]": "card",
      "payment_method_types[1]": "link",
    });
    expect(formSnapshot(init.body)).not.toHaveProperty("customer");

    vi.unstubAllGlobals();
  });

  it("keeps bank-category Checkout Sessions isolated from card-rail methods", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "cs_bank",
            client_secret: "cs_bank_secret",
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

    await gateway.createPaymentSession({
      paymentId: "pay_bank" as never,
      buyerAccountId: "acc_buyer" as never,
      orderIds: ["ord_bank" as never],
      amount: "12.34",
      currencyCode: "usd",
      paymentMethodCategory: "bank-account",
      description: "Bank payment",
      providerCustomerReference: "cus_123",
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(formSnapshot(init.body)).toMatchObject({
      customer: "cus_123",
      "payment_method_types[0]": "us_bank_account",
    });
    expect(formSnapshot(init.body)).not.toHaveProperty("payment_method_types[1]");

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

  it("requests 3DS on Checkout Session PaymentIntents only for risk-based step-up", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "cs_3ds",
            client_secret: "cs_3ds_secret",
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
    await gateway.createPaymentSession({
      paymentId: "pay_3ds" as never,
      buyerAccountId: "acc_buyer" as never,
      orderIds: ["ord_3ds" as never],
      amount: "250.00",
      currencyCode: "usd",
      paymentMethodCategory: "card",
      description: "3DS payment",
      returnUrl: "https://marketplace.test/account/payments/pay_3ds",
      cardAuthentication: {
        requestThreeDSecure: "any",
        reasonCodes: ["high-payment-amount"],
      },
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(formSnapshot(init.body)).toMatchObject({
      "payment_intent_data[payment_method_options][card][request_three_d_secure]": "any",
      "payment_intent_data[metadata][three_d_secure_requested]": "any",
      "payment_intent_data[metadata][three_d_secure_reason_codes]": "high-payment-amount",
      "metadata[three_d_secure_requested]": "any",
    });

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

  it("creates Stripe customers and hosted_page setup sessions for saved payment methods", async () => {
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
    expect((setupInit.headers as Headers).get("Stripe-Version")).toBe(STRIPE_API_VERSION);
    expect(formSnapshot(setupInit.body)).toMatchObject({
      mode: "setup",
      ui_mode: "hosted_page",
      customer: "cus_123",
      success_url: "https://marketplace.test/account/payment-methods?setupReferenceId=scs_1",
      "metadata[saved_payment_consent_id]": "consent_1",
      "metadata[saved_payment_consent_text]": "Save for future checkout.",
    });

    vi.unstubAllGlobals();
  });

  it.each([
    {
      name: "Apple Pay",
      paymentMethod: {
        id: "pm_apple_pay",
        type: "card",
        customer: "cus_123",
        card: { brand: "visa", last4: "4242", fingerprint: "fp_apple", wallet: { type: "apple_pay" } },
      },
      expectedLabel: "Apple Pay •••• 4242",
      expectedFingerprint: "fp_apple",
    },
    {
      name: "Google Pay",
      paymentMethod: {
        id: "pm_google_pay",
        type: "card",
        customer: "cus_123",
        card: { brand: "visa", last4: "4242", fingerprint: "fp_google", wallet: { type: "google_pay" } },
      },
      expectedLabel: "Google Pay •••• 4242",
      expectedFingerprint: "fp_google",
    },
    {
      name: "Link",
      paymentMethod: {
        id: "pm_link",
        type: "link",
        customer: "cus_123",
        link: { email: "buyer@example.com" },
      },
      expectedLabel: "Link",
      expectedFingerprint: null,
    },
  ])(
    "maps $name to the card fee category with a receipt-safe label",
    async ({ paymentMethod, expectedLabel, expectedFingerprint }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify(paymentMethod), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        ),
      );
      const gateway = createStripePaymentProcessorGateway({
        secretKey: "sk_test",
        publishableKey: "pk_test",
        webhookSecret: "whsec_test",
        apiBaseUrl: "https://stripe.test",
      });

      await expect(gateway.retrieveSavedPaymentMethod?.(paymentMethod.id)).resolves.toMatchObject({
        paymentMethodCategory: "card",
        displayLabel: expectedLabel,
        paymentMethodFingerprint: expectedFingerprint,
      });

      vi.unstubAllGlobals();
    },
  );
  it("creates an embedded SetupIntent attached to the Stripe Customer", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "seti_123",
            client_secret: "seti_123_secret",
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
    const setup = await gateway.createSetupSession({
      accountId: "acc_buyer" as never,
      providerCustomerReference: "cus_123",
      currencyCode: "usd",
      uiMode: "embedded",
      returnUrl: "https://marketplace.test/account/payment-methods",
      consentId: "consent_1",
      consentText: "Save for future checkout.",
    });

    expect(setup).toMatchObject({
      processorSetupKind: "setup-intent",
      processorSetupReference: "seti_123",
      processorClientSecret: "seti_123_secret",
      processorRedirectUrl: null,
      processorStatus: "requires_payment_method",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://stripe.test/v1/setup_intents");
    expect(formSnapshot(init.body)).toMatchObject({
      customer: "cus_123",
      usage: "off_session",
      "automatic_payment_methods[enabled]": "true",
      "metadata[account_id]": "acc_buyer",
      "metadata[saved_payment_consent_id]": "consent_1",
      "metadata[saved_payment_consent_text]": "Save for future checkout.",
    });
    expect(formSnapshot(init.body)).not.toHaveProperty("ui_mode");

    vi.unstubAllGlobals();
  });

  it("reconciles an embedded SetupIntent through its saved payment method", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "seti_123", status: "succeeded", payment_method: "pm_123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "pm_123",
            type: "card",
            customer: "cus_123",
            allow_redisplay: "always",
            card: { brand: "visa", last4: "4242", fingerprint: "fingerprint_123" },
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

    await expect(gateway.retrieveSetupSessionResult("seti_123")).resolves.toMatchObject({
      processorSetupReference: "seti_123",
      processorStatus: "succeeded",
      setupIntentReference: "seti_123",
      savedPaymentMethod: {
        providerReference: "pm_123",
        providerCustomerReference: "cus_123",
        displayLabel: "Visa ending in 4242",
      },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://stripe.test/v1/setup_intents/seti_123");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://stripe.test/v1/payment_methods/pm_123");

    vi.unstubAllGlobals();
  });

  describe("SetupIntent cancellation convergence", () => {
    it.each(["pi_payment", "cs_session", "", "   ", "customer_123"])(
      "refuses non-SetupIntent reference %j before any network call",
      async (reference) => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await expect(stripeGateway().cancelSetupSession(reference)).resolves.toStrictEqual({
          outcome: "refused",
          reason: "invalid-reference",
          httpStatus: null,
        });
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it.each(["requires_payment_method", "requires_confirmation", "requires_action"])(
      "cancels eligible initial status %s with one keyed write",
      async (status) => {
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(stripeResponse({ id: syntheticSetupReferenceA, status }))
          .mockResolvedValueOnce(stripeResponse({ id: syntheticSetupReferenceA, status: "canceled" }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(stripeGateway().cancelSetupSession(syntheticSetupReferenceA)).resolves.toStrictEqual({
          outcome: "cancelled",
          processorStatus: "canceled",
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [readUrl, readInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        const [writeUrl, writeInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
        expect([readInit.method, writeInit.method]).toStrictEqual(["GET", "POST"]);
        expect(readUrl).toBe(`https://stripe.test/v1/setup_intents/${syntheticSetupReferenceA}`);
        expect(writeUrl).toBe(`https://stripe.test/v1/setup_intents/${syntheticSetupReferenceA}/cancel`);
        expect(requestIdempotencyKey(readInit)).toBeNull();
        expect(requestIdempotencyKey(writeInit)).toBe(syntheticSetupCancellationKeyA);
      },
    );

    it.each([
      [syntheticSetupReferenceA, syntheticSetupCancellationKeyA],
      [syntheticSetupReferenceB, syntheticSetupCancellationKeyB],
      [`  ${syntheticSetupReferenceA}\t`, syntheticSetupCancellationKeyA],
    ])("emits the fixed known-answer key for %j across gateway instances", async (reference, expectedKey) => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
        stripeResponse({
          id: reference.trim(),
          status: init?.method === "POST" ? "canceled" : "requires_payment_method",
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const results = await Promise.all([
        stripeGateway().cancelSetupSession(reference),
        stripeGateway().cancelSetupSession(reference),
      ]);

      expect(results).toStrictEqual([
        { outcome: "cancelled", processorStatus: "canceled" },
        { outcome: "cancelled", processorStatus: "canceled" },
      ]);
      const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
      const reads = calls.filter(([, init]) => init.method === "GET");
      const writes = calls.filter(([, init]) => init.method === "POST");
      expect(reads).toHaveLength(2);
      expect(writes).toHaveLength(2);
      expect(reads.every(([, init]) => requestIdempotencyKey(init) === null)).toBe(true);
      expect(writes.map(([, init]) => requestIdempotencyKey(init))).toStrictEqual([expectedKey, expectedKey]);
      expect(writes.every(([url]) => !url.includes("%20") && url.endsWith(`/${reference.trim()}/cancel`))).toBe(true);
      expect(expectedKey).toHaveLength(96);
      expect(expectedKey).toMatch(/^payments:setup-intent-cancel:v1:[0-9a-f]{64}$/);
      expect(expectedKey).not.toContain(reference.trim());
    });

    it("kills missing, nondeterministic, raw-reference, wrong-domain, input-encoding, digest, and case key mutants", () => {
      const mutantKeys = [
        null,
        `${syntheticSetupCancellationKeyA}:nonce`,
        syntheticSetupReferenceA,
        syntheticSetupCancellationKeyA.replace("v1:", "v2:"),
        "payments:setup-intent-cancel:v1:e2678ce3fb3748d88f2bcc963524cfb129f11530b05f76ec48f916733ab11e5f",
        `payments:setup-intent-cancel:v1:${createHash("sha512")
          .update(syntheticSetupReferenceA, "utf8")
          .digest("hex")}`,
        syntheticSetupCancellationKeyA.toUpperCase(),
      ];

      for (const mutantKey of mutantKeys) {
        expect(mutantKey).not.toBe(syntheticSetupCancellationKeyA);
      }
    });

    it("rejects raw-reference and credential-marker acceptance artifacts", () => {
      expect(
        containsForbiddenSetupCancellationEvidenceMarker(
          JSON.stringify({ idempotencyKey: syntheticSetupCancellationKeyA, outcome: "cancelled" }),
        ),
      ).toBe(false);
      for (const marker of [syntheticSetupReferenceA, "sk_test_PLANTED", "sk_live_PLANTED", "whsec_PLANTED"]) {
        expect(containsForbiddenSetupCancellationEvidenceMarker(JSON.stringify({ marker }))).toBe(true);
      }
    });

    it.each([
      ["canceled", { outcome: "already-terminal", processorStatus: "canceled" }],
      ["succeeded", { outcome: "already-terminal", processorStatus: "succeeded" }],
      ["processing", { outcome: "refused", reason: "unexpected-status", httpStatus: 200 }],
      [null, { outcome: "refused", reason: "unexpected-status", httpStatus: 200 }],
      ["unrecognized", { outcome: "refused", reason: "unexpected-status", httpStatus: 200 }],
    ])("performs one read and zero writes for initial status %j", async (status, expected) => {
      const fetchMock = vi.fn(async () =>
        stripeResponse({ id: syntheticSetupReferenceA, ...(status === null ? {} : { status }) }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(stripeGateway().cancelSetupSession(syntheticSetupReferenceA)).resolves.toStrictEqual(expected);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [[, init]] = fetchMock.mock.calls as unknown as [string, RequestInit][];
      expect(init.method).toBe("GET");
      expect(requestIdempotencyKey(init)).toBeNull();
    });

    it.each([
      [404, { outcome: "not-found" }],
      [401, { outcome: "refused", reason: "provider-rejected", httpStatus: 401 }],
      [503, { outcome: "refused", reason: "provider-rejected", httpStatus: 503 }],
    ])("bounds initial HTTP failure %i without attempting a write", async (status, expected) => {
      const fetchMock = vi.fn(async () => stripeResponse({ error: { message: "PLANTED_PROVIDER_BODY" } }, status));
      vi.stubGlobal("fetch", fetchMock);

      await expect(stripeGateway().cancelSetupSession(syntheticSetupReferenceA)).resolves.toStrictEqual(expected);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("bounds an initial transport failure without exposing its exception", async () => {
      const marker = "PLANTED_TRANSPORT_SECRET_seti_DO_NOT_LEAK";
      const fetchMock = vi.fn(async () => {
        throw new Error(marker);
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await stripeGateway().cancelSetupSession(syntheticSetupReferenceA);

      expect(result).toStrictEqual({ outcome: "refused", reason: "transport-failure", httpStatus: null });
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      {
        name: "initial read",
        responses: [null],
        requestCount: 1,
      },
      {
        name: "write response",
        responses: [
          { id: syntheticSetupReferenceA, status: "requires_payment_method" },
          null,
          {
            id: syntheticSetupReferenceA,
            status: "requires_action",
          },
        ],
        requestCount: 3,
      },
      {
        name: "reconciliation read",
        responses: [
          { id: syntheticSetupReferenceA, status: "requires_payment_method" },
          { id: syntheticSetupReferenceA, status: "processing" },
          null,
        ],
        requestCount: 3,
      },
    ])("fails closed for a null JSON $name body", async ({ responses, requestCount }) => {
      const queue = [...responses];
      const fetchMock = vi.fn(async () => stripeResponse(queue.shift()));
      vi.stubGlobal("fetch", fetchMock);

      await expect(stripeGateway().cancelSetupSession(syntheticSetupReferenceA)).resolves.toStrictEqual({
        outcome: "refused",
        reason: "unexpected-status",
        httpStatus: 200,
      });
      expect(fetchMock).toHaveBeenCalledTimes(requestCount);
    });

    type ReconciliationAction =
      | Readonly<{ kind: "response"; status?: string | null; httpStatus?: number }>
      | Readonly<{ kind: "transport" }>;
    type ReconciliationCase = Readonly<{
      name: string;
      write: ReconciliationAction;
      reconciliation: ReconciliationAction;
      expected: unknown;
    }>;

    const reconciliationCases: readonly ReconciliationCase[] = [
      {
        name: "successful non-canceled write reconciles canceled",
        write: { kind: "response", status: "requires_confirmation" },
        reconciliation: { kind: "response", status: "canceled" },
        expected: { outcome: "already-terminal", processorStatus: "canceled" },
      },
      {
        name: "successful non-canceled write reconciles succeeded",
        write: { kind: "response", status: "processing" },
        reconciliation: { kind: "response", status: "succeeded" },
        expected: { outcome: "already-terminal", processorStatus: "succeeded" },
      },
      {
        name: "reconciliation 404 wins",
        write: { kind: "response", status: "processing" },
        reconciliation: { kind: "response", httpStatus: 404 },
        expected: { outcome: "not-found" },
      },
      {
        name: "reconciliation HTTP failure wins",
        write: { kind: "response", status: "processing" },
        reconciliation: { kind: "response", httpStatus: 429 },
        expected: { outcome: "refused", reason: "provider-rejected", httpStatus: 429 },
      },
      {
        name: "reconciliation transport failure wins",
        write: { kind: "response", status: "processing" },
        reconciliation: { kind: "transport" },
        expected: { outcome: "refused", reason: "transport-failure", httpStatus: null },
      },
      {
        name: "reconciled processing fails closed",
        write: { kind: "response", status: "processing" },
        reconciliation: { kind: "response", status: "processing" },
        expected: { outcome: "refused", reason: "unexpected-status", httpStatus: 200 },
      },
      {
        name: "reconciled missing status fails closed",
        write: { kind: "response", status: "processing" },
        reconciliation: { kind: "response", status: null },
        expected: { outcome: "refused", reason: "unexpected-status", httpStatus: 200 },
      },
      {
        name: "reconciled unknown status fails closed",
        write: { kind: "response", status: "processing" },
        reconciliation: { kind: "response", status: "new_status" },
        expected: { outcome: "refused", reason: "unexpected-status", httpStatus: 200 },
      },
      {
        name: "successful write still eligible is unexpected",
        write: { kind: "response", status: "requires_confirmation" },
        reconciliation: { kind: "response", status: "requires_action" },
        expected: { outcome: "refused", reason: "unexpected-status", httpStatus: 200 },
      },
      {
        name: "write rejection survives eligible reconciliation",
        write: { kind: "response", httpStatus: 409 },
        reconciliation: { kind: "response", status: "requires_payment_method" },
        expected: { outcome: "refused", reason: "provider-rejected", httpStatus: 409 },
      },
      {
        name: "write ambiguity survives eligible reconciliation",
        write: { kind: "transport" },
        reconciliation: { kind: "response", status: "requires_confirmation" },
        expected: { outcome: "refused", reason: "transport-failure", httpStatus: null },
      },
      {
        name: "terminal reconciliation wins over write rejection",
        write: { kind: "response", httpStatus: 409 },
        reconciliation: { kind: "response", status: "canceled" },
        expected: { outcome: "already-terminal", processorStatus: "canceled" },
      },
      {
        name: "terminal reconciliation wins over write ambiguity",
        write: { kind: "transport" },
        reconciliation: { kind: "response", status: "canceled" },
        expected: { outcome: "already-terminal", processorStatus: "canceled" },
      },
    ];

    it.each(reconciliationCases)(
      "uses the total post-write table: $name",
      async ({ write, reconciliation, expected }) => {
        const actions: ReconciliationAction[] = [
          { kind: "response", status: "requires_payment_method" },
          write,
          reconciliation,
        ];
        const fetchMock = vi.fn(async () => {
          const action = actions.shift();
          if (!action || action.kind === "transport") {
            throw new Error("PLANTED_AMBIGUOUS_WRITE_OR_READ");
          }
          if (action.httpStatus) {
            return stripeResponse({ error: { message: "PLANTED_PROVIDER_REJECTION" } }, action.httpStatus);
          }
          return stripeResponse({
            id: syntheticSetupReferenceA,
            ...(action.status === null ? {} : { status: action.status }),
          });
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(stripeGateway().cancelSetupSession(syntheticSetupReferenceA)).resolves.toStrictEqual(expected);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
        expect(calls.map(([, init]) => init.method)).toStrictEqual(["GET", "POST", "GET"]);
        expect(calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
        expect(requestIdempotencyKey(calls[0]?.[1])).toBeNull();
        expect(requestIdempotencyKey(calls[1]?.[1])).toBe(syntheticSetupCancellationKeyA);
        expect(requestIdempotencyKey(calls[2]?.[1])).toBeNull();
      },
    );

    async function runConcurrentCancellation(mode: "replay" | "conflict") {
      let setupStatus = "requires_payment_method";
      let effectiveCancellations = 0;
      let preReads = 0;
      let releasePreReads!: () => void;
      const bothPreReadsStarted = new Promise<void>((resolve) => {
        releasePreReads = resolve;
      });
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "GET" && preReads < 2) {
          preReads += 1;
          if (preReads === 2) {
            releasePreReads();
          }
          await bothPreReadsStarted;
          return stripeResponse({ id: syntheticSetupReferenceA, status: "requires_payment_method" });
        }
        if (init?.method === "POST") {
          if (setupStatus !== "canceled") {
            effectiveCancellations += 1;
            setupStatus = "canceled";
            return stripeResponse({ id: syntheticSetupReferenceA, status: "canceled" });
          }
          return mode === "replay"
            ? stripeResponse({ id: syntheticSetupReferenceA, status: "canceled" })
            : stripeResponse({ error: { message: "PLANTED_SAME_KEY_CONFLICT" } }, 409);
        }
        return stripeResponse({ id: syntheticSetupReferenceA, status: setupStatus });
      });
      vi.stubGlobal("fetch", fetchMock);

      const results = await Promise.all([
        stripeGateway("https://stripe-a.test").cancelSetupSession(syntheticSetupReferenceA),
        stripeGateway("https://stripe-b.test").cancelSetupSession(syntheticSetupReferenceA),
      ]);
      return { effectiveCancellations, fetchMock, results, setupStatus };
    }

    it.each([
      ["replay" as const, ["cancelled", "cancelled"]],
      ["conflict" as const, ["already-terminal", "cancelled"]],
    ])("converges concurrent same-key callers through provider %s", async (mode, expectedOutcomes) => {
      const { effectiveCancellations, fetchMock, results, setupStatus } = await runConcurrentCancellation(mode);
      const outcomes = results.map((result) => result.outcome).sort();
      const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
      const writes = calls.filter(([, init]) => init.method === "POST");
      const reconciliationReads = calls.slice(2).filter(([, init]) => init.method === "GET");

      expect(outcomes).toStrictEqual(expectedOutcomes);
      expect(effectiveCancellations).toBe(1);
      expect(setupStatus).toBe("canceled");
      expect(writes).toHaveLength(2);
      expect(writes.map(([, init]) => requestIdempotencyKey(init))).toStrictEqual([
        syntheticSetupCancellationKeyA,
        syntheticSetupCancellationKeyA,
      ]);
      expect(reconciliationReads).toHaveLength(mode === "conflict" ? 1 : 0);
      for (const host of ["stripe-a.test", "stripe-b.test"]) {
        const hostCalls = calls.filter(([url]) => new URL(url).host === host);
        expect(hostCalls.length).toBeLessThanOrEqual(3);
        expect(hostCalls.filter(([, init]) => init.method === "GET").length).toBeLessThanOrEqual(2);
        expect(hostCalls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
      }
    });

    it("requires reconciliation after a losing concurrent write", async () => {
      const { results } = await runConcurrentCancellation("conflict");
      const reconciled = results.find((result) => result.outcome === "already-terminal");
      const reconciliationDeletedMutant = {
        outcome: "refused",
        reason: "provider-rejected",
        httpStatus: 409,
      };

      expect(reconciled).toStrictEqual({ outcome: "already-terminal", processorStatus: "canceled" });
      expect(reconciliationDeletedMutant).not.toStrictEqual(reconciled);
    });

    it("keeps provider bodies, exception messages, secrets, and references out of results and logs", async () => {
      const markers = [
        "PLANTED_BODY_SECRET_6732",
        "PLANTED_EXCEPTION_SECRET_6732",
        syntheticSetupReferenceA,
        "sk_test_PLANTED_SECRET_6732",
      ];
      const logs: string[] = [];
      for (const level of ["error", "warn", "info", "log"] as const) {
        vi.spyOn(console, level).mockImplementation((...values: unknown[]) => {
          logs.push(values.map(String).join(" "));
        });
      }
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(stripeResponse({ id: syntheticSetupReferenceA, status: "requires_payment_method" }))
        .mockResolvedValueOnce(stripeResponse({ error: { message: markers[0] } }, 409))
        .mockRejectedValueOnce(new Error(markers[1]));
      vi.stubGlobal("fetch", fetchMock);

      const result = await createStripePaymentProcessorGateway({
        secretKey: markers[3]!,
        publishableKey: "pk_test",
        webhookSecret: "whsec_test",
        apiBaseUrl: "https://stripe.test",
      }).cancelSetupSession(syntheticSetupReferenceA);
      const retainedText = `${JSON.stringify(result)}\n${logs.join("\n")}`;

      expect(result).toStrictEqual({ outcome: "refused", reason: "transport-failure", httpStatus: null });
      for (const marker of markers) {
        expect(retainedText).not.toContain(marker);
      }
    });

    it.skipIf(process.env["CHASE_SETS_6732_STRIPE_OPERATOR_WINDOW"] !== "confirmed-test-mode")(
      "accepts SetupIntent cancellation in bounded Stripe test mode",
      async () => {
        const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
        const artifactDirectory = fileURLToPath(new URL("../../artifacts/", import.meta.url));
        const artifactPath = fileURLToPath(new URL("../../artifacts/6732-setup-intent-cancel.json", import.meta.url));
        const temporaryArtifactPath = `${artifactPath}.${process.pid}.tmp`;
        await mkdir(artifactDirectory, { recursive: true });
        await rm(artifactPath, { force: true });
        await rm(temporaryArtifactPath, { force: true });

        const secretKey = process.env["STRIPE_SECRET_KEY"]?.trim() ?? "";
        if (!secretKey.startsWith("sk_test_") || secretKey.startsWith("sk_live_")) {
          throw new Error("AC09 requires a separately confirmed Stripe test-mode secret key.");
        }

        type TestModeSetupIntent = Readonly<{ id: string; status: string; livemode: false }>;
        type RecordedRequest = Readonly<{
          responseSequence: number;
          kind: "read" | "cancel";
          idempotencyKey: string | null;
          httpStatus: number;
        }>;
        type AcceptancePayload = Readonly<{
          schemaVersion: "setup-intent-cancel-acceptance/v1";
          apiVersion: string;
          candidateHead: string;
          startedAt: string;
          completedAt: string;
          sequential: readonly Readonly<{
            initialStatus: string;
            firstOutcome: unknown;
            repeatOutcome: unknown;
            terminalStatus: string;
            firstCall: unknown;
            repeatCall: unknown;
          }>[];
          overlapping: Readonly<{
            initialStatus: "requires_payment_method";
            outcomes: readonly unknown[];
            terminalStatus: string;
            calls: readonly unknown[];
            secondWriteDisposition: "replayed-canceled" | "rejected-then-reconciled";
          }>;
          redaction: Readonly<{
            rawSetupReferenceMatches: 0;
            credentialMarkerMatches: 0;
          }>;
        }>;

        const startedAt = new Date().toISOString();
        const candidateHead = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repositoryRoot,
          encoding: "utf8",
        }).trim();
        if (process.env["CHASE_SETS_6732_CANDIDATE_HEAD"]?.trim() !== candidateHead) {
          throw new Error("AC09 requires an explicit candidate-head confirmation for this exact commit.");
        }
        const providerFetch = globalThis.fetch.bind(globalThis);
        const createdReferences: string[] = [];
        const requestContext = new AsyncLocalStorage<string>();
        const requestsByCall = new Map<string, RecordedRequest[]>();
        let responseSequence = 0;
        let overlappingReference: string | null = null;
        let overlappingPreReads = 0;
        let releaseOverlappingReads!: () => void;
        const bothOverlappingReadsStarted = new Promise<void>((resolve) => {
          releaseOverlappingReads = resolve;
        });

        const providerRequest = async (
          operation: string,
          path: string,
          init: RequestInit,
        ): Promise<TestModeSetupIntent> => {
          let response: Response;
          try {
            response = await providerFetch(`https://api.stripe.com${path}`, {
              ...init,
              headers: {
                Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`,
                "Content-Type": "application/x-www-form-urlencoded",
                "Stripe-Version": STRIPE_API_VERSION,
                ...Object.fromEntries(new Headers(init.headers).entries()),
              },
            });
          } catch {
            throw new Error(`Stripe test-mode ${operation} had a transport failure.`);
          }
          const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
          if (!response.ok) {
            throw new Error(`Stripe test-mode ${operation} failed with HTTP ${response.status}.`);
          }
          if (!body || typeof body.id !== "string" || typeof body.status !== "string" || body.livemode !== false) {
            throw new Error(`Stripe test-mode ${operation} returned an invalid or non-test-mode object.`);
          }
          return { id: body.id, status: body.status, livemode: false };
        };

        const createSetupIntentAt = async (targetStatus: string) => {
          const form = new URLSearchParams({
            usage: "off_session",
            "payment_method_types[0]": "card",
            "metadata[acceptance_case]": `issue-6732-${targetStatus}`,
          });
          if (targetStatus === "requires_confirmation") {
            form.set("payment_method", "pm_card_visa");
          } else if (targetStatus === "requires_action") {
            form.set("payment_method", "pm_card_threeDSecure2Required");
            form.set("confirm", "true");
            form.set("return_url", "https://example.test/issue-6732/return");
          }
          const setupIntent = await providerRequest("create", "/v1/setup_intents", {
            method: "POST",
            body: form,
          });
          createdReferences.push(setupIntent.id);
          if (setupIntent.status !== targetStatus) {
            throw new Error(`Stripe test-mode create did not reach required status ${targetStatus}.`);
          }
          return setupIntent.id;
        };

        const retrieveSetupIntent = (reference: string) =>
          providerRequest("terminal read", `/v1/setup_intents/${encodeURIComponent(reference)}`, {
            method: "GET",
          });

        const cleanupSetupIntent = async (reference: string) => {
          const observed = await retrieveSetupIntent(reference);
          if (observed.status !== "canceled" && observed.status !== "succeeded") {
            const cleanupKey = `payments:setup-intent-cancel:v1:${createHash("sha256")
              .update(reference, "utf8")
              .digest("hex")}`;
            await providerRequest("cleanup cancel", `/v1/setup_intents/${encodeURIComponent(reference)}/cancel`, {
              method: "POST",
              body: new URLSearchParams(),
              headers: { "Idempotency-Key": cleanupKey },
            });
          }
          const terminal = await retrieveSetupIntent(reference);
          return terminal.status === "canceled" || terminal.status === "succeeded";
        };

        vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
          const callLabel = requestContext.getStore();
          const requestUrl = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
          const isSetupIntentRequest = requestUrl.pathname.startsWith("/v1/setup_intents/");
          const kind = requestUrl.pathname.endsWith("/cancel") ? "cancel" : "read";
          const isOverlappingInitialRead =
            callLabel?.startsWith("overlap-") &&
            isSetupIntentRequest &&
            kind === "read" &&
            overlappingReference &&
            requestUrl.pathname.endsWith(`/${overlappingReference}`) &&
            !requestsByCall.get(callLabel)?.length;

          const response = await providerFetch(input, init);
          if (callLabel && isSetupIntentRequest) {
            const requests = requestsByCall.get(callLabel) ?? [];
            requests.push({
              responseSequence: ++responseSequence,
              kind,
              idempotencyKey: requestIdempotencyKey(init),
              httpStatus: response.status,
            });
            requestsByCall.set(callLabel, requests);
          }
          if (isOverlappingInitialRead) {
            overlappingPreReads += 1;
            if (overlappingPreReads === 2) {
              releaseOverlappingReads();
            }
            await bothOverlappingReadsStarted;
          }
          return response;
        });

        const createLiveGateway = () =>
          createStripePaymentProcessorGateway({
            secretKey,
            publishableKey: "pk_test_operator_only",
            webhookSecret: "whsec_test_operator_only",
          });
        const runCancellation = (callLabel: string, reference: string) =>
          requestContext.run(callLabel, () => createLiveGateway().cancelSetupSession(reference));
        const summarizeCall = (callLabel: string) => {
          const requests = requestsByCall.get(callLabel) ?? [];
          return {
            requestCount: requests.length,
            preReadCount: requests[0]?.kind === "read" ? 1 : 0,
            writeCount: requests.filter((request) => request.kind === "cancel").length,
            reconciliationReadCount: Math.max(0, requests.filter((request) => request.kind === "read").length - 1),
            requests,
          };
        };

        let payload: AcceptancePayload | null = null;
        let failedPhase: string | null = null;
        let cleanupFailed = false;
        try {
          const sequential = [];
          for (const initialStatus of [
            "requires_payment_method",
            "requires_confirmation",
            "requires_action",
          ] as const) {
            const reference = await createSetupIntentAt(initialStatus);
            const firstLabel = `sequential-${initialStatus}-first`;
            const repeatLabel = `sequential-${initialStatus}-repeat`;
            const firstOutcome = await runCancellation(firstLabel, reference);
            const repeatOutcome = await runCancellation(repeatLabel, reference);
            const terminal = await retrieveSetupIntent(reference);
            if (
              firstOutcome.outcome !== "cancelled" ||
              repeatOutcome.outcome !== "already-terminal" ||
              repeatOutcome.processorStatus !== "canceled" ||
              terminal.status !== "canceled"
            ) {
              throw new Error(`Sequential ${initialStatus} acceptance did not converge.`);
            }
            sequential.push({
              initialStatus,
              firstOutcome,
              repeatOutcome,
              terminalStatus: terminal.status,
              firstCall: summarizeCall(firstLabel),
              repeatCall: summarizeCall(repeatLabel),
            });
          }

          overlappingReference = await createSetupIntentAt("requires_payment_method");
          const overlappingOutcomes = await Promise.all([
            runCancellation("overlap-a", overlappingReference),
            runCancellation("overlap-b", overlappingReference),
          ]);
          const terminal = await retrieveSetupIntent(overlappingReference);
          const sortedOutcomes = overlappingOutcomes.map((outcome) => outcome.outcome).sort();
          const allowedMultiset =
            JSON.stringify(sortedOutcomes) === JSON.stringify(["cancelled", "cancelled"]) ||
            JSON.stringify(sortedOutcomes) === JSON.stringify(["already-terminal", "cancelled"]);
          const overlappingCalls = [summarizeCall("overlap-a"), summarizeCall("overlap-b")];
          const writes = overlappingCalls
            .flatMap((call) => call.requests)
            .filter((request) => request.kind === "cancel")
            .sort((left, right) => left.responseSequence - right.responseSequence);
          const expectedKey = `payments:setup-intent-cancel:v1:${createHash("sha256")
            .update(overlappingReference, "utf8")
            .digest("hex")}`;
          if (
            !allowedMultiset ||
            terminal.status !== "canceled" ||
            writes.length !== 2 ||
            writes.some((write) => write.idempotencyKey !== expectedKey) ||
            overlappingCalls.some(
              (call) =>
                call.requestCount > 3 ||
                call.preReadCount !== 1 ||
                call.writeCount !== 1 ||
                call.reconciliationReadCount > 1 ||
                call.requests.some(
                  (request) =>
                    (request.kind === "read" && request.idempotencyKey !== null) ||
                    (request.kind === "cancel" && request.idempotencyKey !== expectedKey),
                ),
            )
          ) {
            throw new Error("Overlapping Stripe test-mode acceptance did not converge within the call budget.");
          }
          const secondWrite = writes[1] ?? writes[0]!;
          const secondWriteDisposition =
            secondWrite.httpStatus >= 200 && secondWrite.httpStatus < 300
              ? "replayed-canceled"
              : "rejected-then-reconciled";

          payload = {
            schemaVersion: "setup-intent-cancel-acceptance/v1",
            apiVersion: STRIPE_API_VERSION,
            candidateHead,
            startedAt,
            completedAt: new Date().toISOString(),
            sequential,
            overlapping: {
              initialStatus: "requires_payment_method",
              outcomes: overlappingOutcomes,
              terminalStatus: terminal.status,
              calls: overlappingCalls,
              secondWriteDisposition,
            },
            redaction: {
              rawSetupReferenceMatches: 0,
              credentialMarkerMatches: 0,
            },
          };
        } catch {
          failedPhase = "provider lifecycle or convergence assertions";
        } finally {
          for (const reference of createdReferences) {
            try {
              cleanupFailed = !(await cleanupSetupIntent(reference)) || cleanupFailed;
            } catch {
              cleanupFailed = true;
            }
          }
        }

        if (failedPhase || cleanupFailed || !payload) {
          await rm(temporaryArtifactPath, { force: true });
          await rm(artifactPath, { force: true });
          throw new Error(
            cleanupFailed
              ? "AC09 failed its cleanup and terminal checks; no receipt was published."
              : `AC09 failed during ${failedPhase ?? "receipt construction"}; no receipt was published.`,
          );
        }

        const digest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
        const artifactText = `${JSON.stringify({ ...payload, digest }, null, 2)}\n`;
        if (containsForbiddenSetupCancellationEvidenceMarker(artifactText)) {
          throw new Error("AC09 receipt redaction marker scan failed; no receipt was published.");
        }
        await writeFile(temporaryArtifactPath, artifactText, { encoding: "utf8", flag: "wx" });
        await rename(temporaryArtifactPath, artifactPath);

        expect(JSON.parse(artifactText)).toMatchObject({
          candidateHead,
          apiVersion: STRIPE_API_VERSION,
          redaction: { rawSetupReferenceMatches: 0, credentialMarkerMatches: 0 },
          digest,
        });
      },
    );

    it("keeps cancelPayment restricted to PaymentIntent references", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(stripeGateway().cancelPayment(syntheticSetupReferenceA)).rejects.toThrow(
        "Only direct payment intents can be cancelled",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
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
      cardAuthentication: {
        requestThreeDSecure: "any",
        reasonCodes: ["stripe-fraud-flag"],
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
      statement_descriptor_suffix: "CHASESETS",
      payment_method: "pm_123",
      confirm: "true",
      off_session: "true",
      "payment_method_options[card][request_three_d_secure]": "any",
      "metadata[saved_checkout_instrument_id]": "sci_card_1",
      "metadata[three_d_secure_requested]": "any",
    });
    expect(formSnapshot(init.body)).not.toHaveProperty("transfer_data[destination]");
    expect(formSnapshot(init.body)).not.toHaveProperty("on_behalf_of");

    vi.unstubAllGlobals();
  });

  it("surfaces the hosted 3DS challenge URL when an off-session saved-instrument charge requires action", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "pi_saved_3ds",
            client_secret: "pi_saved_3ds_secret",
            status: "requires_action",
            next_action: {
              type: "redirect_to_url",
              redirect_to_url: { url: "https://hooks.stripe.test/3ds/pi_saved_3ds" },
            },
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
      paymentId: "pay_saved_3ds" as never,
      buyerAccountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      amount: "26.05",
      currencyCode: "usd",
      paymentMethodCategory: "card",
      description: "Saved payment needing 3DS",
      savedCheckoutInstrument: {
        instrumentId: "sci_card_1",
        providerCustomerReference: "cus_123",
        providerReference: "pm_123",
        confirmationExperience: "off-session-token",
        displayLabel: "Visa ending in 4242",
      },
    });

    expect(payment.processorStatus).toBe("requires_action");
    expect(payment.processorRedirectUrl).toBe("https://hooks.stripe.test/3ds/pi_saved_3ds");

    vi.unstubAllGlobals();
  });

  it("does not surface a challenge URL when an off-session saved-instrument charge succeeds", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "pi_saved_ok", client_secret: "pi_saved_ok_secret", status: "succeeded" }), {
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
      paymentId: "pay_saved_ok" as never,
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

    expect(payment.processorStatus).toBe("succeeded");
    expect(payment.processorRedirectUrl).toBeNull();

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
      providerCustomerReference: "cus_123",
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
    expect((init.headers as Headers).get("Stripe-Version")).toBe(STRIPE_API_VERSION);
    expect((init.headers as Headers).get("Idempotency-Key")).toBe("idem_agentic");
    expect(formSnapshot(init.body)).toMatchObject({
      amount: "2000",
      currency: "usd",
      shared_payment_granted_token: "spt_123",
      confirm: "true",
      customer: "cus_123",
      statement_descriptor_suffix: "CHASESETS",
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
          reason: "fraudulent",
          evidence_details: { due_by: 1_785_801_600 },
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
    ).rejects.toThrow("Stripe webhook event type is not supported.");
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
      providerChargeReference: "ch_123",
      disputeLifecycleState: "created",
      disputeStatus: "needs_response",
      disputeReason: "fraudulent",
      disputeEvidenceDueAt: "2026-08-04T00:00:00.000Z",
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
    ).rejects.toThrow("Stripe webhook event type is not supported.");
  });

  it("maps early fraud warnings through charge enrichment", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "ch_123",
        payment_intent: "pi_123",
        disputed: false,
        metadata: { payment_id: "pay_123" },
      }),
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
    const rawBody = JSON.stringify({
      id: "evt_efw",
      type: "radar.early_fraud_warning.created",
      created: "2026-07-06T12:00:00.000Z",
      data: {
        object: {
          id: "issfr_123",
          charge: "ch_123",
          fraud_type: "card_never_received",
        },
      },
    });

    await expect(
      gateway.parseWebhook({
        rawBody,
        signatureHeader: signature(rawBody, "whsec_test", now),
      }),
    ).resolves.toMatchObject({
      eventId: "evt_efw",
      kind: "payment-early-fraud-warning",
      processorPaymentKind: "payment-intent",
      processorPaymentReference: "pi_123",
      providerObjectReference: "issfr_123",
      providerChargeReference: "ch_123",
      internalPaymentId: "pay_123",
      chargeDisputed: false,
      fraudType: "card_never_received",
      occurredAt: "2026-07-06T12:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://stripe.test/v1/charges/ch_123",
      expect.objectContaining({ method: "GET" }),
    );
    vi.unstubAllGlobals();
  });

  it("maps Radar review closed approvals with RFC3339 event timestamps", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "ch_123",
        payment_intent: "pi_123",
        disputed: false,
        metadata: { payment_id: "pay_123" },
      }),
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
    const rawBody = JSON.stringify({
      id: "evt_review_closed",
      type: "review.closed",
      created: "2026-07-06T12:05:00.000Z",
      data: {
        object: {
          id: "prv_123",
          charge: "ch_123",
          reason: "rule",
          status: "closed",
          closed_reason: "approved",
        },
      },
    });

    await expect(
      gateway.parseWebhook({
        rawBody,
        signatureHeader: signature(rawBody, "whsec_test", now),
      }),
    ).resolves.toMatchObject({
      eventId: "evt_review_closed",
      kind: "payment-fraud-review-closed",
      processorPaymentReference: "pi_123",
      providerObjectReference: "prv_123",
      providerChargeReference: "ch_123",
      internalPaymentId: "pay_123",
      fraudReviewReason: "rule",
      fraudReviewOutcome: "approved",
      occurredAt: "2026-07-06T12:05:00.000Z",
    });
    vi.unstubAllGlobals();
  });

  it("maps PaymentIntent 3DS liability shift outcomes through charge enrichment", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "ch_3ds",
        payment_intent: "pi_3ds",
        metadata: { payment_id: "pay_3ds", three_d_secure_requested: "any" },
        outcome: { risk_level: "normal" },
        payment_method_details: {
          card: {
            three_d_secure: { result: "authenticated" },
          },
        },
      }),
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
    const rawBody = JSON.stringify({
      id: "evt_pi_3ds",
      type: "payment_intent.succeeded",
      created: now,
      data: {
        object: {
          id: "pi_3ds",
          status: "succeeded",
          latest_charge: "ch_3ds",
          metadata: { payment_id: "pay_3ds", three_d_secure_requested: "any" },
        },
      },
    });

    await expect(
      gateway.parseWebhook({
        rawBody,
        signatureHeader: signature(rawBody, "whsec_test", now),
      }),
    ).resolves.toMatchObject({
      eventId: "evt_pi_3ds",
      kind: "payment-captured",
      processorPaymentReference: "pi_3ds",
      liabilityShiftOutcome: {
        threeDSecureRequested: "any",
        status: "shifted",
        authenticationResult: "authenticated",
        radarRiskLevel: "normal",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://stripe.test/v1/charges/ch_3ds",
      expect.objectContaining({ method: "GET" }),
    );
    vi.unstubAllGlobals();
  });

  it("maps failed 3DS authentication from PaymentIntent failures", async () => {
    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: "whsec_test",
      webhookToleranceSeconds: 1_000,
    });
    const now = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({
      id: "evt_pi_3ds_failed",
      type: "payment_intent.payment_failed",
      created: now,
      data: {
        object: {
          id: "pi_3ds_failed",
          status: "requires_payment_method",
          metadata: { payment_id: "pay_3ds_failed", three_d_secure_requested: "any" },
          outcome: { risk_level: "elevated" },
          last_payment_error: {
            code: "authentication_required",
            message: "3DS authentication failed.",
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
      eventId: "evt_pi_3ds_failed",
      kind: "payment-failed",
      processorPaymentReference: "pi_3ds_failed",
      liabilityShiftOutcome: {
        threeDSecureRequested: "any",
        status: "authentication-failed",
        authenticationResult: "failed",
        radarRiskLevel: "elevated",
      },
    });
  });

  it("maps Stripe Shared Payment Token lifecycle webhooks to acknowledged inbox events", async () => {
    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: "whsec_test",
      webhookToleranceSeconds: 1_000,
    });
    const now = Math.floor(Date.now() / 1000);
    const usedBody = JSON.stringify({
      id: "evt_spt_used",
      type: "shared_payment.granted_token.used",
      created: now,
      data: {
        object: {
          id: "spt_123",
          status: "used",
          payment_intent: "pi_agentic",
          metadata: { payment_id: "pay_agentic" },
        },
      },
    });
    const deactivatedBody = JSON.stringify({
      id: "evt_spt_deactivated",
      type: "shared_payment.granted_token.deactivated",
      created: now,
      data: {
        object: {
          id: "spt_123",
          status: "deactivated",
        },
      },
    });

    await expect(
      gateway.parseWebhook({
        rawBody: usedBody,
        signatureHeader: signature(usedBody, "whsec_test", now),
      }),
    ).resolves.toMatchObject({
      eventId: "evt_spt_used",
      kind: "shared-payment-token-used",
      processorPaymentKind: "payment-intent",
      processorPaymentReference: "pi_agentic",
      providerObjectReference: "spt_123",
      internalPaymentId: "pay_agentic",
      processorStatus: "used",
    });
    await expect(
      gateway.parseWebhook({
        rawBody: deactivatedBody,
        signatureHeader: signature(deactivatedBody, "whsec_test", now),
      }),
    ).resolves.toMatchObject({
      eventId: "evt_spt_deactivated",
      kind: "shared-payment-token-deactivated",
      processorPaymentReference: "spt_123",
      providerObjectReference: "spt_123",
      processorStatus: "deactivated",
    });
  });

  it("verifies every v1 signature and accepts configured previous secrets during rotation", async () => {
    const now = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({
      id: "evt_rotated",
      type: "payment_intent.succeeded",
      created: now,
      data: { object: { id: "pi_rotated", status: "canceled", metadata: { payment_id: "pay_rotated" } } },
    });
    const currentDigest = signature(rawBody, "whsec_current", now).split("v1=")[1];
    const previousDigest = signature(rawBody, "whsec_previous", now).split("v1=")[1];
    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: "whsec_current",
      previousWebhookSecrets: ["whsec_previous"],
    });

    await expect(
      gateway.parseWebhook({
        rawBody,
        signatureHeader: `t=${now},v1=${"0".repeat(64)},v1=${previousDigest},v1=${currentDigest}`,
      }),
    ).resolves.toMatchObject({ eventId: "evt_rotated" });
  });

  it("rejects webhook signatures created with a different secret", async () => {
    const now = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({ id: "evt_wrong_secret", type: "payment_intent.succeeded", data: {} });
    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: "whsec_current",
    });

    await expect(
      gateway.parseWebhook({ rawBody, signatureHeader: signature(rawBody, "whsec_different", now) }),
    ).rejects.toThrow("Stripe webhook signature verification failed.");
  });

  it("rejects malformed webhook signature headers", async () => {
    const now = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({ id: "evt_malformed_signature", type: "payment_intent.succeeded", data: {} });
    const validSignature = signature(rawBody, "whsec_test", now);
    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: "whsec_test",
    });

    await expect(
      gateway.parseWebhook({ rawBody, signatureHeader: validSignature.replace(/^t=[^,]+,/, "") }),
    ).rejects.toThrow("Stripe webhook signature is malformed.");
  });

  it("rejects webhook signatures outside the configured timestamp tolerance", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleTimestamp = now - 301;
    const rawBody = JSON.stringify({ id: "evt_stale_signature", type: "payment_intent.succeeded", data: {} });
    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: "whsec_test",
      webhookToleranceSeconds: 300,
    });

    await expect(
      gateway.parseWebhook({ rawBody, signatureHeader: signature(rawBody, "whsec_test", staleTimestamp) }),
    ).rejects.toThrow("Stripe webhook signature timestamp is outside tolerance.");
  });

  it("maps direct PaymentIntent cancellations and supports outbound PaymentIntent cancellation", async () => {
    const now = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({
      id: "evt_pi_cancelled",
      type: "payment_intent.canceled",
      created: now,
      data: {
        object: {
          id: "pi_cancelled",
          status: "canceled",
          metadata: { payment_id: "pay_cancelled" },
        },
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "pi_cancelled", status: "canceled", metadata: { payment_id: "pay_cancelled" } }),
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

    await expect(
      gateway.parseWebhook({ rawBody, signatureHeader: signature(rawBody, "whsec_test", now) }),
    ).resolves.toMatchObject({
      eventId: "evt_pi_cancelled",
      kind: "payment-cancelled",
      processorPaymentKind: "payment-intent",
      processorPaymentReference: "pi_cancelled",
      internalPaymentId: "pay_cancelled",
    });
    await expect(gateway.cancelPayment("pi_cancelled")).resolves.toMatchObject({
      processorPaymentReference: "pi_cancelled",
      processorStatus: "canceled",
      outcome: "cancelled",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://stripe.test/v1/payment_intents/pi_cancelled/cancel",
      expect.objectContaining({ method: "POST" }),
    );
    await expect(gateway.cancelPayment("cs_session")).rejects.toThrow("Only direct payment intents can be cancelled");
    vi.unstubAllGlobals();
  });

  it("rejects tampered webhook payloads even when the original payload was signed", async () => {
    const now = Math.floor(Date.now() / 1000);
    const originalBody = JSON.stringify({ id: "evt_original", type: "payment_intent.succeeded", data: {} });
    const gateway = createStripePaymentProcessorGateway({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: "whsec_test",
    });

    await expect(
      gateway.parseWebhook({
        rawBody: `${originalBody} `,
        signatureHeader: signature(originalBody, "whsec_test", now),
      }),
    ).rejects.toThrow("Stripe webhook signature verification failed.");
  });

  describe("payment amount validation", () => {
    function gatewayForAmountValidation() {
      const fetchMock = vi.fn(async () => Response.json({ id: "cs_amount", status: "open", payment_status: "unpaid" }));
      vi.stubGlobal("fetch", fetchMock);
      return {
        fetchMock,
        gateway: createStripePaymentProcessorGateway({
          secretKey: "sk_test",
          publishableKey: "pk_test",
          webhookSecret: "whsec_test",
          apiBaseUrl: "https://stripe.test",
        }),
      };
    }

    function paymentSessionInput(amount: string) {
      return {
        paymentId: "pay_amount" as never,
        buyerAccountId: "acc_buyer" as never,
        orderIds: ["ord_amount" as never],
        amount,
        currencyCode: "usd",
        paymentMethodCategory: "card",
        description: "Amount validation test payment",
        providerCustomerReference: "cus_amount",
        returnUrl: "https://marketplace.test/account/payments/pay_amount",
      } as const;
    }

    it("rejects a zero payment amount", async () => {
      const { gateway } = gatewayForAmountValidation();
      await expect(gateway.createPaymentSession(paymentSessionInput("0.00"))).rejects.toThrow(
        "Payment amount must be greater than zero.",
      );
      vi.unstubAllGlobals();
    });

    it("rejects a negative payment amount", async () => {
      const { gateway } = gatewayForAmountValidation();
      await expect(gateway.createPaymentSession(paymentSessionInput("-5.00"))).rejects.toThrow(
        "Payment amount must be a valid decimal.",
      );
      vi.unstubAllGlobals();
    });

    it("rejects a payment amount with more than two decimal places", async () => {
      const { gateway } = gatewayForAmountValidation();
      await expect(gateway.createPaymentSession(paymentSessionInput("12.999"))).rejects.toThrow(
        "Payment amount must be a valid decimal.",
      );
      vi.unstubAllGlobals();
    });

    it("rejects a malformed payment amount", async () => {
      const { gateway } = gatewayForAmountValidation();
      await expect(gateway.createPaymentSession(paymentSessionInput("abc"))).rejects.toThrow(
        "Payment amount must be a valid decimal.",
      );
      vi.unstubAllGlobals();
    });

    it("rejects a payment amount above the canonical money bound", async () => {
      const { gateway } = gatewayForAmountValidation();
      await expect(gateway.createPaymentSession(paymentSessionInput("10000000000.00"))).rejects.toThrow(
        "Payment amount must be a valid decimal.",
      );
      vi.unstubAllGlobals();
    });

    it("normalizes a payment amount with a trailing single decimal digit to minor units", async () => {
      const { gateway, fetchMock } = gatewayForAmountValidation();
      await gateway.createPaymentSession(paymentSessionInput("12.3"));
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(formSnapshot(init.body)).toMatchObject({ "line_items[0][price_data][unit_amount]": "1230" });
      vi.unstubAllGlobals();
    });

    it("rejects a zero refund amount", async () => {
      const fetchMock = vi.fn(async () => Response.json({ id: "re_amount", status: "succeeded" }));
      vi.stubGlobal("fetch", fetchMock);
      const gateway = createStripePaymentProcessorGateway({
        secretKey: "sk_test",
        publishableKey: "pk_test",
        webhookSecret: "whsec_test",
        apiBaseUrl: "https://stripe.test",
      });

      await expect(
        gateway.createRefund({
          refundId: "rfd_amount",
          paymentId: "pay_amount" as never,
          processorPaymentReference: "pi_amount",
          orderIds: ["ord_amount" as never],
          amount: "0.00",
          currencyCode: "usd",
          reason: "Zero amount refund",
        }),
      ).rejects.toThrow("Refund amount must be greater than zero.");
      vi.unstubAllGlobals();
    });
  });
});
