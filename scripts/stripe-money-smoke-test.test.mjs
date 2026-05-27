import { describe, expect, it } from "vitest";
import { envReport, runEdgeCheck, runSellerFlow } from "./stripe-money-smoke-test.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createSmokeFetch(calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const path = new URL(String(url)).pathname;

    if (path === "/health") {
      return jsonResponse({ ok: true });
    }
    if (path === "/api/auth/password-sign-in") {
      const body = JSON.parse(init.body ?? "{}");
      if (body.email === "stripe-smoke@example.test") {
        return jsonResponse({ type: "session-started", sessionToken: "session_seller_login" });
      }
      return jsonResponse({ type: "session-started", sessionToken: "session_admin" });
    }
    if (path === "/api/auth/register") {
      return jsonResponse(
        {
          type: "session-started",
          sessionToken: "session_seller",
          accountId: "acc_smoke_seller",
        },
        201,
      );
    }
    if (path === "/api/payments/provider/webhooks") {
      return jsonResponse({ error: { code: "validation_failed" } }, 400);
    }
    if (path === "/api/settlement/provider/money-movement/webhooks") {
      return jsonResponse({ error: { code: "validation_failed" } }, 400);
    }
    if (path === "/api/settlement/account-status") {
      return jsonResponse({
        wallet: {
          can_use_balance_credit: true,
          available_balance_amount: "25.00",
        },
      });
    }
    if (path === "/api/settlement/payout-readiness") {
      return jsonResponse({ status: "ready" });
    }
    if (path === "/api/marketplace/account/marketplace-checkout-fee-policy") {
      return jsonResponse({ policy_version: "marketplace-checkout-fee-v1" });
    }
    if (path === "/api/marketplace/account/provider-health") {
      return jsonResponse({ provider_name: "stripe" });
    }
    if (path === "/api/settlement/provider-health") {
      return jsonResponse({ provider_name: "stripe" });
    }
    if (
      path === "/api/marketplace/account/provider-idempotency" ||
      path === "/api/settlement/payouts/provider-idempotency"
    ) {
      return jsonResponse({ items: [], total: 0, count: 0 });
    }
    if (path === "/api/settlement/payouts/platform-balance-forecast") {
      return jsonResponse({ currency_code: "usd", available_amount: "100.00" });
    }
    if (path === "/api/marketplace/account/checkout/status") {
      return jsonResponse({
        can_start_payment: true,
        wallet_credit: {
          applied_amount: "10.00",
        },
        marketplace_checkout_fee: {
          quote_fingerprint: "quote-1",
          processor_amount: "0.00",
        },
      });
    }
    if (path === "/api/marketplace/account/payments") {
      return jsonResponse(
        {
          payment_id: "pay_smoke",
          processor_payment_kind: "balance-credit",
        },
        201,
      );
    }
    if (path === "/api/settlement/payout-setup/onboarding-session") {
      return jsonResponse({ url: "https://connect.stripe.test/setup" }, 201);
    }
    if (path === "/api/settlement/payout-setup/refresh") {
      return jsonResponse({ status: "ready" });
    }
    if (path === "/api/settlement/payouts/preview") {
      return jsonResponse({ can_request: true });
    }
    if (path === "/api/settlement/payouts") {
      return jsonResponse({ id: "po_smoke", status: "requested" }, 201);
    }

    return jsonResponse({ error: { code: "not_found", path } }, 404);
  };
}

describe("stripe money smoke test", () => {
  it("reports required env and checks Stripe test-mode key shapes", () => {
    expect(envReport({})).toMatchObject({
      missing: [
        "PLATFORM_API_BASE_URL",
        "STRIPE_SECRET_KEY",
        "STRIPE_PUBLISHABLE_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_CONNECT_RETURN_URL",
        "STRIPE_CONNECT_REFRESH_URL",
      ],
      testModeKeysLikely: false,
    });

    expect(
      envReport({
        PLATFORM_API_BASE_URL: "https://api.preview.test",
        STRIPE_SECRET_KEY: "sk_test_123",
        STRIPE_PUBLISHABLE_KEY: "pk_test_123",
        STRIPE_WEBHOOK_SECRET: "whsec_test",
        STRIPE_CONNECT_RETURN_URL: "https://marketplace.preview.test/account/payouts",
        STRIPE_CONNECT_REFRESH_URL: "https://marketplace.preview.test/account/payouts/setup",
      }),
    ).toMatchObject({
      missing: [],
      testModeKeysLikely: true,
    });
  });

  it("rejects unsigned payment and money movement webhooks in edge checks", async () => {
    const calls = [];
    await expect(
      runEdgeCheck("https://api.preview.test", {
        fetchImpl: createSmokeFetch(calls),
      }),
    ).resolves.toEqual({
      health: "ok",
      unsignedPaymentWebhookRejected: true,
      unsignedMoneyMovementWebhookRejected: true,
    });

    expect(calls.map((call) => new URL(call.url).pathname)).toContain("/api/payments/provider/webhooks");
    expect(calls.map((call) => new URL(call.url).pathname)).toContain(
      "/api/settlement/provider/money-movement/webhooks",
    );
  });

  it("covers seller health, balance-credit checkout, onboarding, preview, and requested payout", async () => {
    const calls = [];
    const result = await runSellerFlow("https://api.preview.test", {
      fetchImpl: createSmokeFetch(calls),
      env: {
        PLATFORM_API_AUTHORIZATION: "Bearer preview",
        STRIPE_CONNECT_RETURN_URL: "https://marketplace.preview.test/account/payouts",
        STRIPE_CONNECT_REFRESH_URL: "https://marketplace.preview.test/account/payouts/setup",
        SMOKE_ORDER_IDS: "ord_1,ord_2",
        SMOKE_BALANCE_CREDIT_AMOUNT: "10.00",
        SMOKE_CREATE_PAYMENT: "true",
        SMOKE_REQUEST_PAYOUT: "true",
      },
    });

    expect(result).toMatchObject({
      walletBalanceCreditAvailable: true,
      paymentProviderHealth: "ok",
      settlementProviderHealth: "ok",
      providerIdempotencySurfaces: "ok",
      checkout: {
        createPayment: "ok",
        paymentId: "pay_smoke",
        processorPaymentKind: "balance-credit",
      },
      payoutRequest: {
        status: "ok",
        payoutId: "po_smoke",
      },
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(
      expect.arrayContaining([
        "/api/settlement/account-status",
        "/api/marketplace/account/checkout/status",
        "/api/marketplace/account/payments",
        "/api/settlement/payouts",
      ]),
    );
  });

  it("can sign in with preview admin credentials when no bearer or cookie is supplied", async () => {
    const calls = [];
    const result = await runSellerFlow("https://marketplace.preview.test", {
      fetchImpl: createSmokeFetch(calls),
      env: {
        PLATFORM_AUTH_BASE_URL: "https://admin.preview.test",
        PLATFORM_ADMIN_EMAIL: "admin@example.test",
        PLATFORM_ADMIN_PASSWORD: "correct horse battery staple",
        STRIPE_CONNECT_RETURN_URL: "https://marketplace.preview.test/account/payouts",
        STRIPE_CONNECT_REFRESH_URL: "https://marketplace.preview.test/account/payouts/setup",
      },
    });

    expect(result.accountStatus).toBe("ok");
    expect(calls[0]).toMatchObject({
      url: "https://admin.preview.test/api/auth/password-sign-in",
    });
    const accountStatusCall = calls.find(
      (call) => call.url === "https://marketplace.preview.test/api/settlement/account-status",
    );
    expect(accountStatusCall.init.headers.get("Authorization")).toBe("Bearer session_admin");
  });

  it("can register a throwaway preview seller before running the seller flow", async () => {
    const calls = [];
    const result = await runSellerFlow("https://marketplace.preview.test", {
      fetchImpl: createSmokeFetch(calls),
      env: {
        PLATFORM_AUTH_BASE_URL: "https://marketplace.preview.test",
        SMOKE_REGISTER_SELLER: "true",
        SMOKE_SELLER_EMAIL: "stripe-smoke@example.test",
        SMOKE_SELLER_PASSWORD: "preview smoke password",
        STRIPE_CONNECT_RETURN_URL: "https://marketplace.preview.test/account/payouts",
        STRIPE_CONNECT_REFRESH_URL: "https://marketplace.preview.test/account/payouts/setup",
      },
    });

    expect(result.accountStatus).toBe("ok");
    expect(calls[0]).toMatchObject({
      url: "https://marketplace.preview.test/api/auth/register",
    });
    const registrationBody = JSON.parse(calls[0].init.body);
    expect(registrationBody).toMatchObject({
      email: "stripe-smoke@example.test",
      displayName: "Stripe Preview Smoke stripe smoke",
      consents: [
        {
          policyKey: "terms-of-service",
          policyVersion: "v1",
        },
      ],
    });
    const signInCall = calls.find((call) => call.url === "https://marketplace.preview.test/api/auth/password-sign-in");
    expect(signInCall).toBeUndefined();
    const accountStatusCall = calls.find(
      (call) => call.url === "https://marketplace.preview.test/api/settlement/account-status",
    );
    expect(accountStatusCall.init.headers.get("Authorization")).toBe("Bearer session_seller");
  });
});
