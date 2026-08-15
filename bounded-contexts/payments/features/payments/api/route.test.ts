import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildPaymentsApi } from "../../../api";
import type { PaymentsApiEnv } from "./route";
import { createAccountPaymentRoutes, createPaymentProcessorWebhookRoutes } from "./route";
import type { PaymentServices } from "./runtime";
import { PaymentsDomainError } from "../../../support/runtime-support/common";
import { ProviderWebhookError } from "@chase-sets/http/provider-errors";
import {
  isPaymentProviderModeResponse,
  type PaymentProviderModeObservation,
  type PaymentProviderModeResponse,
} from "./contracts";
import type { PaymentsServices } from "../../../support/runtime-support/services";

const providerModeObservation = {
  mode: "test",
  paymentProcessorKind: "stripe",
  moneyMovementKind: "stripe",
  deploymentEnvironment: "test",
} as const satisfies PaymentProviderModeObservation;

function buildMountedPaymentsApp(
  observation?: unknown,
  options: Readonly<{
    authActivity?: () => void;
    databaseActivity?: () => void;
    paymentServices?: PaymentServices;
  }> = {},
) {
  const paymentServices = options.paymentServices ?? createServices();
  const resolvedObservation = arguments.length === 0 ? providerModeObservation : observation;
  const app = new Hono<PaymentsApiEnv>();
  app.use("/api/marketplace/account/*", async (_context, next) => {
    options.authActivity?.();
    await next();
  });
  app.route(
    "/api/marketplace",
    buildPaymentsApi({
      payments: paymentServices,
      db: { query: options.databaseActivity },
      providerModeObservation: resolvedObservation,
    } as unknown as PaymentsServices),
  );
  return app;
}

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
        provider_customer_reference: "cus_buyer",
        provider_reference: "pm_1",
        display_label: "Visa ending in 4242",
        confirmation_experience: "trusted-payment-step",
        readiness: "ready",
        allow_redisplay: "always",
        consent_id: "consent_1",
        consent_text: "Save for future checkout.",
        removed_at: null,
        is_default: true,
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
      },
    ]),
    ensureProviderCustomer: vi.fn(async () => ({
      account_id: "acc_buyer",
      provider: "stripe",
      provider_customer_reference: "cus_buyer",
      display_name: null,
      email: null,
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
    })),
    createSavedCheckoutSetupSession: vi.fn(async () => ({
      setup_reference_id: "scs_1",
      account_id: "acc_buyer",
      provider: "stripe",
      provider_customer_reference: "cus_buyer",
      processor_setup_reference: "cs_setup_1",
      processor_client_secret: "cs_setup_1_secret",
      processor_redirect_url: "https://checkout.stripe.test/setup/cs_setup_1",
      processor_status: "open",
      consent_id: "consent_1",
      consent_text: "Save for future checkout.",
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
      completed_at: null,
    })),
    reconcileSavedCheckoutSetupSession: vi.fn(async () => null),
    setSavedCheckoutInstrumentDefault: vi.fn(async () => null),
    removeSavedCheckoutInstrument: vi.fn(async () => null),
    reconcileSavedCheckoutInstruments: vi.fn(async () => ({ checked: 1, updated: 1, removed: 0 })),
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
    listAccountOrderInputs: vi.fn(async () => [
      {
        order_id: "ord_1",
        buyer_account_id: "acc_buyer",
        buyer_email: "buyer@example.com",
        seller_account_id: "acc_seller",
        sales_tax_amount: "0.00",
        total_amount: "24.99",
        marketplace_sales_fee_amount: "1.00",
        marketplace_checkout_fee_amount: "0.50",
        seller_net_amount: "23.49",
        seller_item_net_amount: "23.49",
        shipping_allowance_amount: "1.00",
        shipping_overage_amount: "3.99",
        seller_shipping_payout_amount: "1.00",
        seller_payout_amount: "24.49",
        shipping_allowance_percentage_bps: 500,
        terms_schedule_id: null,
        terms_agreement_id: null,
        terms_resolved_at: "2026-04-29T00:00:00.000Z",
        status: "pending-payment",
      },
    ]),
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
    listPaymentsNeedingReconciliation: vi.fn(async () => []),
    scanPaymentsNeedingReconciliation: vi.fn(async () => ({
      checked: 0,
      repaired: 0,
      attention: 0,
      payment_ids: [],
      provider_operations_checked: 0,
      provider_operations_resolved: 0,
      attention_items: [],
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
        isGuestCheckout: false,
        orderIds: ["ord_1"],
        currencyCode: "usd",
        requestedBalanceCreditAmount: null,
        paymentMethodCategory: null,
        marketplaceCheckoutFeeQuoteFingerprint: null,
        savedCheckoutInstrumentId: null,
        savePaymentMethodForFuture: false,
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

  it("rate limits repeated account payment creation", async () => {
    const services = createServices();
    const app = buildAccountApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_limited_payment_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view", "orders.manage"],
      },
      services,
    });

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await app.fetch(
        new Request("http://payments.test/account/payments", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": `203.0.113.${attempt}`,
          },
          body: JSON.stringify({ orderIds: ["ord_1"] }),
        }),
      );
      expect(response.status).toBe(201);
    }

    const limited = await app.fetch(
      new Request("http://payments.test/account/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "203.0.113.200",
        },
        body: JSON.stringify({ orderIds: ["ord_1"] }),
      }),
    );

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    await expect(limited.json()).resolves.toMatchObject({
      error: {
        code: "rate_limited",
        surface: "payments.payment.create.account",
      },
    });
  });

  it("preserves temporary order readiness error codes for checkout payment start", async () => {
    const services = createServices();
    vi.mocked(services.createAccountPayment).mockRejectedValue(
      new PaymentsDomainError(
        "Order ord_1 is not eligible for payment in status pending-reservation.",
        "order_not_payment_ready",
      ),
    );
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

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "order_not_payment_ready",
        message: "Order ord_1 is not eligible for payment in status pending-reservation.",
      },
    });
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
        isGuestCheckout: false,
        orderIds: ["ord_1"],
        currencyCode: "usd",
        sourceContext: "checkout",
        sourceReferenceId: "chk_1",
        requestedBalanceCreditAmount: null,
        paymentMethodCategory: null,
        marketplaceCheckoutFeeQuoteFingerprint: null,
        savedCheckoutInstrumentId: null,
        savePaymentMethodForFuture: false,
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

  it("creates saved payment setup sessions as sanitized command snapshots", async () => {
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
      new Request("http://payments.test/account/payment-methods/setup-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnUrlPath: "/account/payment-methods" }),
      }),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({
      setup_reference_id: "scs_1",
      processor_setup_reference: "cs_setup_1",
      processor_client_secret: "cs_setup_1_secret",
      processor_redirect_url: "https://checkout.stripe.test/setup/cs_setup_1",
      processor_status: "open",
    });
    expect(services.createSavedCheckoutSetupSession).toHaveBeenCalledWith(
      expect.objectContaining({ uiMode: "embedded" }),
    );
    expect(JSON.stringify(body)).not.toContain("provider_customer_reference");
    expect(JSON.stringify(body)).not.toContain("consent_text");
  });

  it("returns setup reconciliation as a sanitized saved-method snapshot", async () => {
    const services = createServices();
    vi.mocked(services.reconcileSavedCheckoutSetupSession).mockResolvedValueOnce({
      instrument_id: "sci_card_1",
      account_id: "acc_buyer",
      payment_method_category: "card",
      provider: "stripe",
      provider_customer_reference: "cus_buyer",
      provider_reference: "pm_1",
      display_label: "Visa ending in 4242",
      confirmation_experience: "off-session-token",
      readiness: "ready",
      allow_redisplay: "always",
      consent_id: "consent_1",
      consent_text: "Save for future checkout.",
      removed_at: null,
      is_default: true,
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
    } as never);
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
      new Request("http://payments.test/account/payment-methods/setup-sessions/cs_setup_1/reconcile", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      instrument: {
        instrument_id: "sci_card_1",
        account_id: "acc_buyer",
        payment_method_category: "card",
        provider: "stripe",
        display_label: "Visa ending in 4242",
        confirmation_experience: "off-session-token",
        readiness: "ready",
        allow_redisplay: "always",
        is_default: true,
        consent_id: "consent_1",
        removed_at: null,
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
      },
    });
    expect(JSON.stringify(body)).not.toContain("provider_reference");
    expect(JSON.stringify(body)).not.toContain("provider_customer_reference");
  });

  it("returns saved payment method default and removal snapshots without provider credentials", async () => {
    const services = createServices();
    const updatedInstrument = {
      instrument_id: "sci_card_1",
      account_id: "acc_buyer",
      payment_method_category: "card",
      provider: "stripe",
      provider_customer_reference: "cus_buyer",
      provider_reference: "pm_1",
      display_label: "Visa ending in 4242",
      confirmation_experience: "off-session-token",
      readiness: "ready",
      allow_redisplay: "always",
      consent_id: "consent_1",
      consent_text: "Save for future checkout.",
      removed_at: null,
      is_default: true,
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
    };
    vi.mocked(services.setSavedCheckoutInstrumentDefault).mockResolvedValueOnce(updatedInstrument as never);
    vi.mocked(services.removeSavedCheckoutInstrument).mockResolvedValueOnce({
      ...updatedInstrument,
      readiness: "removed",
      removed_at: "2026-04-02T00:00:00.000Z",
      updated_at: "2026-04-02T00:00:00.000Z",
    } as never);
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

    const defaultResponse = await app.fetch(
      new Request("http://payments.test/account/payment-methods/sci_card_1/default", { method: "POST" }),
    );
    const removeResponse = await app.fetch(
      new Request("http://payments.test/account/payment-methods/sci_card_1/remove", { method: "POST" }),
    );

    expect(defaultResponse.status).toBe(200);
    expect(removeResponse.status).toBe(200);
    const defaultBody = await defaultResponse.json();
    const removeBody = await removeResponse.json();
    expect(defaultBody).toMatchObject({
      instrument_id: "sci_card_1",
      is_default: true,
      readiness: "ready",
    });
    expect(removeBody).toMatchObject({
      instrument_id: "sci_card_1",
      readiness: "removed",
      removed_at: "2026-04-02T00:00:00.000Z",
    });
    expect(JSON.stringify({ defaultBody, removeBody })).not.toContain("provider_reference");
    expect(JSON.stringify({ defaultBody, removeBody })).not.toContain("provider_customer_reference");
  });

  it("returns payment method reconciliation with the authoritative list snapshot", async () => {
    const services = createServices();
    vi.mocked(services.listSavedCheckoutInstruments).mockResolvedValueOnce([
      {
        instrument_id: "sci_card_1",
        account_id: "acc_buyer",
        payment_method_category: "card",
        provider: "stripe",
        provider_customer_reference: "cus_buyer",
        provider_reference: "pm_1",
        display_label: "Visa ending in 4242",
        confirmation_experience: "off-session-token",
        readiness: "removed",
        allow_redisplay: "always",
        consent_id: "consent_1",
        consent_text: "Save for future checkout.",
        removed_at: "2026-04-02T00:00:00.000Z",
        is_default: false,
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-02T00:00:00.000Z",
      } as never,
    ]);
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
      new Request("http://payments.test/account/payment-methods/reconcile", { method: "POST" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      checked: 1,
      updated: 1,
      removed: 0,
      items: [
        {
          instrument_id: "sci_card_1",
          account_id: "acc_buyer",
          payment_method_category: "card",
          provider: "stripe",
          display_label: "Visa ending in 4242",
          confirmation_experience: "off-session-token",
          readiness: "removed",
          allow_redisplay: "always",
          is_default: false,
          consent_id: "consent_1",
          removed_at: "2026-04-02T00:00:00.000Z",
          created_at: "2026-04-01T00:00:00.000Z",
          updated_at: "2026-04-02T00:00:00.000Z",
        },
      ],
    });
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

  it("returns a retryable error when provider webhook processing fails after verification", async () => {
    const services = {
      ...createServices(),
      processWebhook: vi.fn(async () => {
        throw new Error("simulated payment webhook commit conflict");
      }),
    };
    const app = new Hono().route("/provider", createPaymentProcessorWebhookRoutes(services));

    const response = await app.fetch(
      new Request("http://payments.test/provider/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "evt_1" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "provider_webhook_handler_failure",
        message: "Provider webhook handler failed.",
        failure_class: "handler-failure",
        retryable: true,
      },
    });
  });

  it.each([
    ["unknown-event", "Unknown event", "evt_unknown", "checkout.session.async_payment_succeeded"],
    ["schema-mismatch", "Schema mismatch", null, null],
    ["inbox-conflict", "Inbox conflict", "evt_duplicate", "payment_intent.succeeded"],
  ] as const)("acknowledges %s without asking Stripe to retry", async (failureClass, message, eventId, eventKind) => {
    const services = {
      ...createServices(),
      processWebhook: vi.fn(async () => {
        throw new ProviderWebhookError(failureClass, message, eventId, eventKind, false);
      }),
    };
    const app = new Hono().route("/provider", createPaymentProcessorWebhookRoutes(services));

    const response = await app.fetch(
      new Request("http://payments.test/provider/webhooks", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      ignored: true,
      failure_class: failureClass,
    });
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

  it("returns Payments-owned order inputs for account payment routes", async () => {
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

    const response = await app.fetch(new Request("http://payments.test/account/order-inputs?orderIds=ord_1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      orders: [
        {
          order_id: "ord_1",
          buyer_email: "buyer@example.com",
          sales_tax_amount: "0.00",
          total_amount: "24.99",
          seller_payout_amount: "24.49",
          status: "pending-payment",
        },
      ],
    });
    expect(services.listAccountOrderInputs).toHaveBeenCalledWith({
      accountId: "acc_buyer",
      orderIds: ["ord_1"],
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
        isGuestCheckout: true,
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

  it("does not expose standalone provider diagnostics to account callers", async () => {
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
      services: createServices(),
    });

    const routes = [
      "/account/provider-health",
      "/account/provider-idempotency",
      "/account/provider-events/evt_1",
      "/account/reconciliation/runs",
    ];

    for (const route of routes) {
      const response = await app.fetch(new Request(`http://payments.test${route}`));

      expect(response.status).toBe(404);
    }
  });

  it("does not expose standalone refund creation outside owning recovery facts", async () => {
    const refundServices = {
      issueRefund: vi.fn(),
      projectors: [],
    };
    const app = new Hono<PaymentsApiEnv>();

    app.use("*", async (c, next) => {
      c.set("actor", {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view", "orders.manage"],
      });
      c.set("context", {
        tenantId: "tnt_identity" as never,
        audit: {
          performedByUserId: "usr_1" as never,
          forAccountId: "acc_buyer" as never,
        },
      });
      await next();
    });
    app.route(
      "/",
      buildPaymentsApi({
        payments: createServices(),
        refunds: refundServices,
      } as never),
    );

    const response = await app.fetch(
      new Request("http://payments.test/account/payments/pay_1/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: "10.00",
          orderIds: ["ord_1"],
          reason: "Manual refund",
        }),
      }),
    );

    expect(response.status).toBe(404);
    expect(refundServices.issueRefund).not.toHaveBeenCalled();
  });
});

describe("payment provider mode observation", () => {
  it("serves payment provider mode at the Payments root", async () => {
    const beforeRequest = Date.now();
    const response = await buildMountedPaymentsApp().request("/api/marketplace/payment-provider-mode");
    const body = (await response.json()) as PaymentProviderModeResponse;
    const afterRequest = Date.now();

    expect(response.status).toBe(200);
    expect(Object.keys(body)).toEqual([
      "mode",
      "paymentProcessorKind",
      "moneyMovementKind",
      "deploymentEnvironment",
      "observedAt",
    ]);
    expect(body).toMatchObject(providerModeObservation);
    expect(isPaymentProviderModeResponse(body)).toBe(true);
    expect(Date.parse(body.observedAt)).toBeGreaterThanOrEqual(beforeRequest);
    expect(Date.parse(body.observedAt)).toBeLessThanOrEqual(afterRequest);
  });

  it("does not create an account payment provider mode alias", async () => {
    const authActivity = vi.fn();
    const response = await buildMountedPaymentsApp(providerModeObservation, { authActivity }).request(
      "/api/marketplace/account/payment-provider-mode",
    );

    expect(response.status).toBe(404);
    expect(authActivity).toHaveBeenCalledTimes(1);
  });

  it("reports the merged 6829 provider test-mode observation without contacting Stripe", async () => {
    const paymentServices = createServices();
    const stripeTransport = vi.mocked(paymentServices.createAccountPayment);
    const connectOnlyObservation = {
      mode: "test",
      paymentProcessorKind: "fake",
      moneyMovementKind: "stripe",
      deploymentEnvironment: "preview",
    } as const satisfies PaymentProviderModeObservation;
    const response = await buildMountedPaymentsApp(connectOnlyObservation, { paymentServices }).request(
      "/api/marketplace/payment-provider-mode",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject(connectOnlyObservation);
    expect(stripeTransport).not.toHaveBeenCalled();
  });

  it("closes payment provider mode observation", () => {
    const valid = {
      ...providerModeObservation,
      observedAt: "2026-08-15T10:11:12.123Z",
    } satisfies PaymentProviderModeResponse;
    const connectOnly = {
      mode: "test",
      paymentProcessorKind: "fake",
      moneyMovementKind: "stripe",
      deploymentEnvironment: "staging",
      observedAt: "2026-08-15T10:11:12-05:00",
    } satisfies PaymentProviderModeResponse;
    const unconfigured = {
      mode: "unconfigured",
      paymentProcessorKind: "fake",
      moneyMovementKind: "fake",
      deploymentEnvironment: "local",
      observedAt: "2026-08-15T10:11:12Z",
    } satisfies PaymentProviderModeResponse;
    const live = {
      mode: "live",
      paymentProcessorKind: "stripe",
      moneyMovementKind: "stripe",
      deploymentEnvironment: "production",
      observedAt: "2026-08-15T10:11:12+00:00",
    } satisfies PaymentProviderModeResponse;

    for (const candidate of [valid, connectOnly, unconfigured, live]) {
      expect(isPaymentProviderModeResponse(candidate)).toBe(true);
    }

    const mutationMatrix: readonly Readonly<{
      name: string;
      bypassMutant: string;
      candidate: unknown;
      bypassed: unknown;
    }>[] = [
      {
        name: "unknown mode",
        bypassMutant: "mode-enum-check-removed",
        candidate: { ...valid, mode: "sandbox" },
        bypassed: valid,
      },
      {
        name: "unknown payment processor kind",
        bypassMutant: "payment-processor-kind-enum-check-removed",
        candidate: { ...valid, paymentProcessorKind: "sandbox" },
        bypassed: valid,
      },
      {
        name: "unknown money movement kind",
        bypassMutant: "money-movement-kind-enum-check-removed",
        candidate: { ...valid, moneyMovementKind: "sandbox" },
        bypassed: valid,
      },
      {
        name: "unknown deployment environment",
        bypassMutant: "deployment-environment-enum-check-removed",
        candidate: { ...valid, deploymentEnvironment: "sandbox" },
        bypassed: valid,
      },
      {
        name: "missing member",
        bypassMutant: "required-member-check-removed",
        candidate: Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "moneyMovementKind")),
        bypassed: valid,
      },
      {
        name: "extra member",
        bypassMutant: "unknown-member-check-removed",
        candidate: { ...valid, providerAuthority: "planted-secret-marker" },
        bypassed: valid,
      },
      {
        name: "date only",
        bypassMutant: "instant-format-check-removed",
        candidate: { ...valid, observedAt: "2026-08-15" },
        bypassed: valid,
      },
      {
        name: "offset-less timestamp",
        bypassMutant: "timezone-check-removed",
        candidate: { ...valid, observedAt: "2026-08-15T10:11:12" },
        bypassed: valid,
      },
      {
        name: "impossible calendar instant",
        bypassMutant: "calendar-check-removed",
        candidate: { ...valid, observedAt: "2026-02-30T10:11:12Z" },
        bypassed: valid,
      },
      {
        name: "out-of-range hour",
        bypassMutant: "hour-bound-check-removed",
        candidate: { ...valid, observedAt: "2026-08-15T24:11:12Z" },
        bypassed: valid,
      },
      {
        name: "out-of-range minute",
        bypassMutant: "minute-bound-check-removed",
        candidate: { ...valid, observedAt: "2026-08-15T10:60:12Z" },
        bypassed: valid,
      },
      {
        name: "out-of-range second",
        bypassMutant: "second-bound-check-removed",
        candidate: { ...valid, observedAt: "2026-08-15T10:11:60Z" },
        bypassed: valid,
      },
      {
        name: "out-of-range offset hour",
        bypassMutant: "offset-hour-bound-check-removed",
        candidate: { ...valid, observedAt: "2026-08-15T10:11:12+24:00" },
        bypassed: valid,
      },
      {
        name: "out-of-range offset minute",
        bypassMutant: "offset-minute-bound-check-removed",
        candidate: { ...valid, observedAt: "2026-08-15T10:11:12+05:60" },
        bypassed: valid,
      },
      {
        name: "both fake reported as test",
        bypassMutant: "gateway-mode-consistency-check-removed",
        candidate: { ...unconfigured, mode: "test" },
        bypassed: unconfigured,
      },
      {
        name: "Stripe gateway reported as unconfigured",
        bypassMutant: "configured-mode-check-removed",
        candidate: { ...valid, mode: "unconfigured" },
        bypassed: valid,
      },
      {
        name: "live outside production",
        bypassMutant: "live-environment-check-removed",
        candidate: { ...live, deploymentEnvironment: "staging" },
        bypassed: live,
      },
      {
        name: "test in production",
        bypassMutant: "test-environment-check-removed",
        candidate: { ...valid, deploymentEnvironment: "production" },
        bypassed: valid,
      },
    ];

    for (const mutation of mutationMatrix) {
      expect(isPaymentProviderModeResponse(mutation.candidate), mutation.name).toBe(false);
      expect(isPaymentProviderModeResponse(mutation.bypassed), mutation.bypassMutant).toBe(true);
    }
  });

  it("fails closed when provider observation is missing", async () => {
    const base = { ...providerModeObservation } as Record<string, unknown>;
    const missingObservations = [
      { name: "entire observation", observation: undefined, defaulted: providerModeObservation },
      ...Object.keys(base).map((field) => ({
        name: `missing ${field}`,
        observation: Object.fromEntries(Object.entries(base).filter(([key]) => key !== field)),
        defaulted: { ...base, [field]: base[field] },
      })),
    ];

    for (const candidate of missingObservations) {
      const response = await buildMountedPaymentsApp(candidate.observation).request(
        "/api/marketplace/payment-provider-mode",
      );
      expect(response.status, candidate.name).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "payment_provider_mode_observation_unavailable",
          message: "Request failed.",
        },
      });

      const defaultingMutant = await buildMountedPaymentsApp(candidate.defaulted).request(
        "/api/marketplace/payment-provider-mode",
      );
      expect(defaultingMutant.status, `${candidate.name} defaulting mutant`).toBe(200);
    }
  });

  it("performs no database auth or provider activity", async () => {
    const marker = "PLANTED_STRIPE_SECRET_MARKER";
    const databaseActivity = vi.fn();
    const authActivity = vi.fn();
    const paymentServices = createServices();
    const providerActivity = vi.mocked(paymentServices.createAccountPayment);
    const logs: string[] = [];
    const logSpies = ["error", "warn", "log"].map((level) =>
      vi.spyOn(console, level as "error" | "warn" | "log").mockImplementation((...values: unknown[]) => {
        logs.push(values.map(String).join(" "));
      }),
    );
    const hostileObservation = Object.defineProperties(
      {},
      {
        mode: {
          enumerable: true,
          get() {
            throw new Error(marker);
          },
        },
        paymentProcessorKind: { enumerable: true, value: "stripe" },
        moneyMovementKind: { enumerable: true, value: "stripe" },
        deploymentEnvironment: { enumerable: true, value: "test" },
      },
    );

    try {
      const response = await buildMountedPaymentsApp(hostileObservation, {
        authActivity,
        databaseActivity,
        paymentServices,
      }).request("/api/marketplace/payment-provider-mode");
      const body = await response.text();
      const headers = JSON.stringify(Object.fromEntries(response.headers.entries()));

      expect(response.status).toBe(500);
      expect(`${body}\n${headers}\n${logs.join("\n")}`).not.toContain(marker);
      expect(databaseActivity).not.toHaveBeenCalled();
      expect(authActivity).not.toHaveBeenCalled();
      expect(providerActivity).not.toHaveBeenCalled();
    } finally {
      for (const spy of logSpies) {
        spy.mockRestore();
      }
    }
  });
});
