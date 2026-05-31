import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PaymentsApiEnv } from "./route";
import { createAccountPaymentRoutes, createPaymentProcessorWebhookRoutes } from "./route";
import type { PaymentServices } from "./runtime";

const checkoutFeeQuote = {
  payment_method_category: "card" as const,
  external_basis_amount: "24.99",
  marketplace_checkout_fee_amount: "1.06",
  marketplace_checkout_fee_reduction_amount: "0.00",
  total_amount: "26.05",
  processor_amount: "26.05",
  policy_version: "marketplace-checkout-fee-v1",
  quote_fingerprint: "marketplace-checkout-fee-v1|card|24.99|0.00|24.99|1.06|26.05|26.05",
  quoted_at: "2026-04-01T00:00:00.000Z",
};

function buildAccountApp(
  options: Readonly<{
    actor: PaymentsApiEnv["Variables"]["actor"];
    services: PaymentServices;
  }>,
) {
  const app = new Hono<PaymentsApiEnv>();

  app.use("*", async (c, next) => {
    c.set("actor", options.actor);
    c.set(
      "context",
      options.actor
        ? {
            tenantId: "tnt_identity" as never,
            audit: {
              performedByUserId: options.actor.userId as never,
              forAccountId: options.actor.accountId as never,
            },
          }
        : null,
    );
    await next();
  });

  app.route("/account", createAccountPaymentRoutes(options.services));

  return app;
}

function createServices(): PaymentServices {
  return {
    commandHandler: vi.fn(async () => ({
      state: {} as never,
      version: 1,
      newEvents: [],
      storedEvents: [],
    })),
    recoverCheckoutPayment: vi.fn(async () => ({
      payment_id: "pay_recovered",
      buyer_account_id: "acc_buyer",
      order_ids: ["ord_1"],
      amount: "24.99",
      balance_credit_amount: "0.00",
      processor_amount: "24.99",
      marketplace_sales_fee_amount: "1.00",
      marketplace_checkout_fee_amount: "0.50",
      marketplace_checkout_fee_policy_version: "marketplace-checkout-fee-v1",
      marketplace_checkout_fee_quote_fingerprint: "quote_1",
      payment_method_category: "card",
      saved_checkout_instrument_id: null,
      seller_net_amount: "23.49",
      currency_code: "usd",
      processor_name: "stripe",
      processor_payment_kind: "checkout-session",
      processor_payment_reference: "pi_recovered",
      processor_client_secret: "pi_recovered_secret",
      processor_redirect_url: null,
      processor_status: "requires_payment_method",
      status: "pending-confirmation",
      failure_code: null,
      failure_message: null,
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
      captured_at: null,
      failed_at: null,
      cancelled_at: null,
      processor_publishable_key: "pk_test_123",
      provider_events: [],
    })),
    createAccountPayment: vi.fn(async () => ({
      payment_id: "pay_1",
      buyer_account_id: "acc_buyer",
      order_ids: ["ord_1"],
      amount: "24.99",
      balance_credit_amount: "0.00",
      processor_amount: "24.99",
      marketplace_sales_fee_amount: "1.00",
      marketplace_checkout_fee_amount: "0.50",
      marketplace_checkout_fee_policy_version: "marketplace-checkout-fee-v1",
      marketplace_checkout_fee_quote_fingerprint: "quote_1",
      payment_method_category: "card",
      saved_checkout_instrument_id: null,
      seller_net_amount: "23.49",
      currency_code: "usd",
      processor_name: "stripe",
      processor_payment_kind: "checkout-session",
      processor_payment_reference: "pi_1",
      processor_client_secret: "pi_1_secret_1",
      processor_redirect_url: null,
      processor_status: "requires_payment_method",
      status: "pending-confirmation",
      failure_code: null,
      failure_message: null,
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
      captured_at: null,
      failed_at: null,
      cancelled_at: null,
      processor_publishable_key: "pk_test_123",
      provider_events: [],
    })),
    listSavedCheckoutInstruments: vi.fn(async () => [
      {
        instrument_id: "sci_card_1",
        account_id: "acc_buyer",
        payment_method_category: "card",
        provider: "stripe",
        provider_reference: "pm_1",
        display_label: "Visa ending in 4242",
        confirmation_experience: "trusted-payment-step",
        readiness: "ready",
        is_default: true,
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
      },
    ]),
    getAccountPayment: vi.fn(async () => null),
    getPaymentMoneyTimeline: vi.fn(async () => null),
    getMarketplaceCheckoutFeePolicy: vi.fn(async () => ({
      policy_version: "marketplace-checkout-fee-v1",
      effective_at: "2026-05-03T00:00:00.000Z",
      enabled_jurisdictions: ["US"],
      base: {
        percentage_bps: 290,
        fixed_amount: "0.30",
      },
      method_adjustments: [
        {
          payment_method_category: "card",
          percentage_bps_delta: 0,
          fixed_amount_delta: "0.00",
          resulting_percentage_bps: 290,
          resulting_fixed_amount: "0.30",
        },
      ],
      unsupported_methods_default: "no-positive-fee",
      quote_audit: {
        confirmation_required: true,
        stale_response_code: 409,
        stale_response_error: "fee_quote_stale",
        snapshot_fields: ["marketplace_checkout_fee_amount"],
      },
    })),
    getCheckoutStatus: vi.fn(async () => ({
      order_ids: ["ord_1"],
      currency_code: "usd",
      amount: "24.99",
      marketplace_checkout_fee: checkoutFeeQuote,
      payment_method_quotes: [checkoutFeeQuote],
      wallet_credit: {
        requested_amount: "0.00",
        applied_amount: "0.00",
        external_amount: "24.99",
      },
      can_start_payment: true,
      unavailable_reasons: [],
      unavailable_reason_details: [],
    })),
    getCheckoutRecoveryOptions: vi.fn(async () => ({
      recovery_reference_id: "acc_buyer:ord_1:usd:0.00",
      can_recover: true,
      recommended_action: "start-payment",
      checkout_status: {
        order_ids: ["ord_1"],
        currency_code: "usd",
        amount: "24.99",
        marketplace_checkout_fee: checkoutFeeQuote,
        payment_method_quotes: [checkoutFeeQuote],
        wallet_credit: {
          requested_amount: "0.00",
          applied_amount: "0.00",
          external_amount: "24.99",
        },
        can_start_payment: true,
        unavailable_reasons: [],
        unavailable_reason_details: [],
      },
    })),
    getProviderEvent: vi.fn(async () => null),
    listProviderIdempotencyKeys: vi.fn(async () => []),
    listPaymentsNeedingReconciliation: vi.fn(async () => []),
    listReconciliationRuns: vi.fn(async () => []),
    getProviderHealth: vi.fn(async () => ({
      provider_name: "stripe",
      confirmation_experience: "processor-managed-form",
      dynamic_payment_methods: true,
      sensitive_payment_details_handled_by_provider: true,
      webhook_signature_required: true,
    })),
    scanPaymentsNeedingReconciliation: vi.fn(async () => ({
      checked: 0,
      attention: 0,
      payment_ids: [],
    })),
    processWebhook: vi.fn(async () => ({ received: true, ignored: false })),
    publicConfig: {
      processorName: "stripe",
      publishableKey: "pk_test_123",
      confirmationExperience: "processor-managed-form",
      dynamicPaymentMethods: true,
      sensitivePaymentDetailsHandledByProcessor: true,
    },
    projectors: [],
  } as unknown as PaymentServices;
}

describe("payments routes", () => {
  it("creates an account payment for the current account", async () => {
    const services = createServices();
    const app = buildAccountApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view", "orders.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://payments.test/account/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: ["ord_1"] }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      payment_id: "pay_1",
      order_ids: ["ord_1"],
    });
    expect(services.createAccountPayment).toHaveBeenCalledWith(
      {
        accountId: "acc_buyer",
        orderIds: ["ord_1"],
        currencyCode: "usd",
        requestedBalanceCreditAmount: null,
        paymentMethodCategory: null,
        marketplaceCheckoutFeeQuoteFingerprint: null,
        savedCheckoutInstrumentId: null,
        returnUrlBase: "http://payments.test",
        returnUrlPath: null,
        clientRiskContext: {
          ipAddress: null,
          userAgent: null,
        },
      },
      expect.any(Object),
    );
  });

  it("passes checkout source metadata into account payment creation", async () => {
    const services = createServices();
    const app = buildAccountApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view", "orders.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://payments.test/account/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderIds: ["ord_1"],
          sourceContext: "checkout",
          sourceReferenceId: "chk_1",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.createAccountPayment).toHaveBeenCalledWith(
      {
        accountId: "acc_buyer",
        orderIds: ["ord_1"],
        currencyCode: "usd",
        sourceContext: "checkout",
        sourceReferenceId: "chk_1",
        requestedBalanceCreditAmount: null,
        paymentMethodCategory: null,
        marketplaceCheckoutFeeQuoteFingerprint: null,
        savedCheckoutInstrumentId: null,
        returnUrlBase: "http://payments.test",
        returnUrlPath: null,
        clientRiskContext: {
          ipAddress: null,
          userAgent: null,
        },
      },
      expect.any(Object),
    );
  });

  it("passes requested balance credit into account payment creation", async () => {
    const services = createServices();
    const app = buildAccountApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view", "orders.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://payments.test/account/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderIds: ["ord_1"],
          requestedBalanceCreditAmount: "7.25",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.createAccountPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedBalanceCreditAmount: "7.25",
      }),
      expect.any(Object),
    );
  });

  it("passes a selected saved checkout instrument into account payment creation", async () => {
    const services = createServices();
    const app = buildAccountApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view", "orders.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://payments.test/account/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderIds: ["ord_1"],
          paymentMethodCategory: "card",
          savedCheckoutInstrumentId: "sci_card_1",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.createAccountPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMethodCategory: "card",
        savedCheckoutInstrumentId: "sci_card_1",
      }),
      expect.any(Object),
    );
  });

  it("returns saved checkout instruments without processor references", async () => {
    const services = createServices();
    const app = buildAccountApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view"],
      },
      services,
    });

    const response = await app.fetch(new Request("http://payments.test/account/checkout/saved-instruments"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        {
          instrument_id: "sci_card_1",
          account_id: "acc_buyer",
          payment_method_category: "card",
          provider: "stripe",
          display_label: "Visa ending in 4242",
          confirmation_experience: "trusted-payment-step",
          readiness: "ready",
          is_default: true,
          created_at: "2026-04-01T00:00:00.000Z",
          updated_at: "2026-04-01T00:00:00.000Z",
        },
      ],
    });
    expect(services.listSavedCheckoutInstruments).toHaveBeenCalledWith("acc_buyer");
  });

  it("rejects account payment creation without order permissions", async () => {
    const app = buildAccountApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "viewer",
        permissions: ["orders.view"],
      },
      services: createServices(),
    });

    const response = await app.fetch(
      new Request("http://payments.test/account/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: ["ord_1"] }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "authorization_forbidden",
        message: "Forbidden.",
      },
    });
  });

  it("accepts provider webhooks without marketplace auth context", async () => {
    const services = createServices();
    const app = new Hono().route("/provider", createPaymentProcessorWebhookRoutes(services));

    const response = await app.fetch(
      new Request("http://payments.test/provider/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "evt_1" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, ignored: false });
    expect(services.processWebhook).toHaveBeenCalled();
  });

  it("returns checkout recovery options for the current account", async () => {
    const services = createServices();
    const app = buildAccountApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view"],
      },
      services,
    });

    const response = await app.fetch(new Request("http://payments.test/account/checkout/recovery?orderIds=ord_1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      recovery_reference_id: "acc_buyer:ord_1:usd:0.00",
    });
    expect(services.getCheckoutRecoveryOptions).toHaveBeenCalledWith({
      accountId: "acc_buyer",
      orderIds: ["ord_1"],
      currencyCode: "usd",
      requestedBalanceCreditAmount: null,
      paymentMethodCategory: null,
    });
  });

  it("passes an explicit return path into checkout payment recovery", async () => {
    const services = createServices();
    const app = buildAccountApp({
      actor: {
        sessionId: "guest:tok_1",
        tenantId: "tnt_identity",
        userId: "usr_guest_checkout",
        accountId: "acc_guest",
        membershipId: "guest:tok_1",
        roleKey: "guest-buyer",
        permissions: ["guest-checkout.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://payments.test/account/checkout/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderIds: ["ord_1"],
          currencyCode: "usd",
          requestedBalanceCreditAmount: "3.25",
          paymentMethodCategory: "bank-account",
          marketplaceCheckoutFeeQuoteFingerprint: "quote_bank_retry",
          savedCheckoutInstrumentId: "sci_bank_1",
          returnUrlPath: "/checkout/payments/:paymentId",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.recoverCheckoutPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_guest",
        orderIds: ["ord_1"],
        currencyCode: "usd",
        requestedBalanceCreditAmount: "3.25",
        paymentMethodCategory: "bank-account",
        marketplaceCheckoutFeeQuoteFingerprint: "quote_bank_retry",
        savedCheckoutInstrumentId: "sci_bank_1",
        returnUrlBase: "http://payments.test",
        returnUrlPath: "/checkout/payments/:paymentId",
      }),
      expect.any(Object),
    );
  });

  it("returns the active Marketplace Checkout Fee policy for operators", async () => {
    const services = createServices();
    const app = buildAccountApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view"],
      },
      services,
    });

    const response = await app.fetch(new Request("http://payments.test/account/marketplace-checkout-fee-policy"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      policy_version: "marketplace-checkout-fee-v1",
      enabled_jurisdictions: ["US"],
      quote_audit: {
        stale_response_error: "fee_quote_stale",
      },
    });
  });

  it("returns payment timelines for the current account", async () => {
    const services = createServices();
    vi.mocked(services.getPaymentMoneyTimeline).mockResolvedValueOnce({
      payment_id: "pay_1",
      account_id: "acc_buyer",
      items: [
        {
          occurred_at: "2026-04-01T00:00:00.000Z",
          kind: "payment-created",
          label: "Payment started",
          reference: "pay_1",
          amount: "24.99",
          currency_code: "usd",
        },
      ],
    });
    const app = buildAccountApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view"],
      },
      services,
    });

    const response = await app.fetch(new Request("http://payments.test/account/payments/pay_1/timeline"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      payment_id: "pay_1",
      items: [expect.objectContaining({ kind: "payment-created" })],
    });
  });

  it("returns provider health only for order managers", async () => {
    const services = createServices();
    const app = buildAccountApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.manage"],
      },
      services,
    });

    const response = await app.fetch(new Request("http://payments.test/account/provider-health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sensitive_payment_details_handled_by_provider: true,
      webhook_signature_required: true,
    });
  });
});
