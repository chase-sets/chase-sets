import { describe, expect, it } from "vitest";
import {
  envReport,
  runEdgeCheck,
  runSellerFlow,
  validateStripeDeliveredWebhookProofForRun,
  validateStripeKeyModeForRun,
} from "./stripe-money-smoke-test.mjs";

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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
    if (path === "/api/identity/current-actor-display") {
      return jsonResponse({ account: { account_id: "acc_platform_admin" } });
    }
    if (path === "/api/identity/invitations") {
      return jsonResponse({ invitationId: "ivt_stripe_money_smoke_test" }, 201, {
        "chase-sets-commit-receipt": encodeURIComponent(
          JSON.stringify([
            {
              sourceContextName: "identity",
              maxGlobalPosition: "42",
              eventIds: ["evt_identity_invitation"],
            },
          ]),
        ),
      });
    }
    if (path === "/api/platform/projections/refresh") {
      return jsonResponse({
        projectionGroups: [
          {
            targetContextName: "auth",
            projectionName: "auth-identity-invitation-projection",
            subscriptions: [{ sourceContextName: "identity", lastGlobalPosition: "42" }],
          },
        ],
      });
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
      if (
        !String(init.headers?.["Stripe-Signature"] ?? init.headers?.get?.("Stripe-Signature") ?? "").includes("invalid")
      ) {
        return jsonResponse({ received: true, ignored: true });
      }
      return jsonResponse({ error: { code: "validation_failed" } }, 400);
    }
    if (path === "/api/settlement/provider/money-movement/webhooks") {
      if (
        !String(init.headers?.["Stripe-Signature"] ?? init.headers?.get?.("Stripe-Signature") ?? "").includes("invalid")
      ) {
        return jsonResponse({ received: true, ignored: true });
      }
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
    if (path === "/api/settlement/provider-health") {
      return jsonResponse({ provider_name: "stripe" });
    }
    if (path === "/api/settlement/payouts/provider-idempotency") {
      return jsonResponse({ items: [], total: 0, count: 0 });
    }
    if (path === "/api/settlement/payouts/platform-balance-forecast") {
      return jsonResponse({ currency_code: "usd", available_amount: "100.00" });
    }
    if (path === "/account/payouts/setup") {
      return new Response("<html><body>Payout setup</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
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
    if (path === "/api/settlement/payout-setup/embedded-session") {
      return jsonResponse(
        {
          providerReference: "acct_embedded_smoke",
          clientSecret: "acs_embedded_smoke_secret",
          expiresAt: "2026-06-01T15:00:00.000Z",
          components: ["payout-setup"],
        },
        201,
      );
    }
    if (path === "/api/settlement/payout-setup/refresh") {
      return jsonResponse({
        account_id: "acc_smoke_seller",
        status: "ready",
        provider_reference: "acct_embedded_smoke",
        payout_account_dashboard: "none",
        losses_collector: "application",
        fees_collector: "application",
        requirements_collector: "application",
        requirements: [],
      });
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
        "STRIPE_CONNECT_WEBHOOK_SECRET",
      ],
      readinessErrors: [
        "Missing required environment: PLATFORM_API_BASE_URL.",
        "Missing required environment: STRIPE_SECRET_KEY.",
        "Missing required environment: STRIPE_PUBLISHABLE_KEY.",
        "Missing required environment: STRIPE_WEBHOOK_SECRET.",
        "Missing required environment: STRIPE_CONNECT_WEBHOOK_SECRET.",
      ],
      testModeKeysLikely: false,
    });

    expect(
      envReport({
        PLATFORM_API_BASE_URL: "https://api.preview.test",
        STRIPE_SECRET_KEY: "sk_test_123",
        STRIPE_PUBLISHABLE_KEY: "pk_test_123",
        STRIPE_WEBHOOK_SECRET: "whsec_test",
        STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_test",
      }),
    ).toMatchObject({
      missing: [],
      readinessErrors: [],
      stripeKeyMode: "test",
      smokeEnvironment: "unspecified",
      testModeKeysLikely: true,
      liveModeKeysLikely: false,
      stripeDeliveredWebhookProof: {
        required: false,
        status: "not-provided",
        paymentWebhookDeliveryEventId: null,
        connectWebhookDeliveryEventId: null,
        evidenceReference: null,
      },
    });
  });

  it("requires an explicit Stripe-delivered webhook evidence reference when staging demands provider delivery proof", () => {
    const stagingEnv = {
      PLATFORM_API_BASE_URL: "https://marketplace.staging.chasesets.com",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_PUBLISHABLE_KEY: "pk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_test",
      STRIPE_MONEY_SMOKE_ENVIRONMENT: "staging",
      STRIPE_MONEY_SMOKE_REQUIRE_DELIVERED_WEBHOOKS: "true",
    };

    expect(envReport(stagingEnv)).toMatchObject({
      smokeEnvironment: "staging",
      stripeDeliveredWebhookProof: {
        required: true,
        status: "missing-required-proof",
      },
      readinessErrors: [
        "Set STRIPE_WEBHOOK_DELIVERY_EVIDENCE_REFERENCE before running a smoke test that requires Stripe-delivered webhook proof. Raw Stripe evt_ identifiers belong in the private evidence record, not GitHub Environment configuration.",
      ],
    });
    expect(() => validateStripeDeliveredWebhookProofForRun(stagingEnv)).toThrow(
      /STRIPE_WEBHOOK_DELIVERY_EVIDENCE_REFERENCE/,
    );

    expect(
      envReport({
        ...stagingEnv,
        STRIPE_WEBHOOK_DELIVERY_EVIDENCE_REFERENCE: "STAGING-STRIPE-WEBHOOKS-2026-06-01",
      }),
    ).toMatchObject({
      readinessErrors: [],
      stripeDeliveredWebhookProof: {
        required: true,
        status: "provided",
        paymentWebhookDeliveryEventId: null,
        connectWebhookDeliveryEventId: null,
        evidenceReference: "STAGING-STRIPE-WEBHOOKS-2026-06-01",
      },
    });
  });

  it("requires an explicit production proof reference before live-key smoke runs", () => {
    const liveEnv = {
      PLATFORM_API_BASE_URL: "https://chasesets.com",
      STRIPE_SECRET_KEY: "sk_live_123",
      STRIPE_PUBLISHABLE_KEY: "pk_live_123",
      STRIPE_WEBHOOK_SECRET: "whsec_live",
      STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_live",
    };

    expect(envReport(liveEnv)).toMatchObject({
      stripeKeyMode: "live",
      testModeKeysLikely: false,
      liveModeKeysLikely: true,
      liveModeAllowed: false,
      readinessErrors: ["Set STRIPE_MONEY_SMOKE_ALLOW_LIVE=true before running this smoke test with Stripe live keys."],
    });
    expect(() => validateStripeKeyModeForRun(liveEnv)).toThrow(/STRIPE_MONEY_SMOKE_ALLOW_LIVE=true/);
    expect(() =>
      validateStripeKeyModeForRun({
        ...liveEnv,
        STRIPE_MONEY_SMOKE_ALLOW_LIVE: "true",
      }),
    ).toThrow(/PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE/);
    expect(() =>
      validateStripeKeyModeForRun({
        ...liveEnv,
        STRIPE_MONEY_SMOKE_ALLOW_LIVE: "true",
        PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE: "STRIPE-LIVE-PROOF-2026-05-30",
      }),
    ).not.toThrow();
  });

  it("reports check-env readiness errors for live keys until all production proof safeguards are present", () => {
    const liveReadyEnv = {
      PLATFORM_API_BASE_URL: "https://marketplace.chasesets.com",
      STRIPE_SECRET_KEY: "sk_live_123",
      STRIPE_PUBLISHABLE_KEY: "pk_live_123",
      STRIPE_WEBHOOK_SECRET: "whsec_live",
      STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_live",
      STRIPE_MONEY_SMOKE_ALLOW_LIVE: "true",
      PRODUCTION_MARKETPLACE_PROOF_REFERENCE: "PRODUCTION-PROOF-2026-05-30",
    };

    expect(envReport(liveReadyEnv)).toMatchObject({
      missing: [],
      readinessErrors: [],
      stripeKeyMode: "live",
      liveModeAllowed: true,
    });

    expect(
      envReport({
        ...liveReadyEnv,
        STRIPE_SECRET_KEY: "sk_live_123",
        STRIPE_PUBLISHABLE_KEY: "pk_test_123",
      }).readinessErrors,
    ).toContain("This smoke test requires matching Stripe test keys or matching Stripe live keys.");
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
      signedPaymentWebhookAccepted: false,
      signedMoneyMovementWebhookAccepted: false,
      webhookChecks: {
        signedProbe: {
          unsignedPaymentWebhookRejected: true,
          unsignedMoneyMovementWebhookRejected: true,
          signedPaymentWebhookAccepted: false,
          signedMoneyMovementWebhookAccepted: false,
        },
        stripeDelivered: {
          required: false,
          status: "not-provided",
          paymentWebhookDeliveryEventId: null,
          connectWebhookDeliveryEventId: null,
          evidenceReference: null,
        },
      },
    });

    expect(calls.map((call) => new URL(call.url).pathname)).toContain("/api/payments/provider/webhooks");
    expect(calls.map((call) => new URL(call.url).pathname)).toContain(
      "/api/settlement/provider/money-movement/webhooks",
    );
  });

  it("accepts correctly signed payment and money movement webhook probes in edge checks", async () => {
    const calls = [];
    await expect(
      runEdgeCheck("https://api.preview.test", {
        fetchImpl: createSmokeFetch(calls),
        env: {
          STRIPE_WEBHOOK_SECRET: "whsec_payment_test",
          STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_test",
        },
      }),
    ).resolves.toMatchObject({
      signedPaymentWebhookAccepted: true,
      signedMoneyMovementWebhookAccepted: true,
    });

    const paymentWebhookCalls = calls.filter(
      (call) => new URL(call.url).pathname === "/api/payments/provider/webhooks",
    );
    const moneyMovementWebhookCalls = calls.filter(
      (call) => new URL(call.url).pathname === "/api/settlement/provider/money-movement/webhooks",
    );
    expect(paymentWebhookCalls).toHaveLength(2);
    expect(moneyMovementWebhookCalls).toHaveLength(2);
    expect(JSON.parse(paymentWebhookCalls[1].init.body)).toMatchObject({
      type: "product.created",
    });
    expect(JSON.parse(moneyMovementWebhookCalls[1].init.body)).toMatchObject({
      type: "product.created",
    });
  });

  it("covers seller health, balance-credit checkout, embedded setup, preview, and requested payout", async () => {
    const calls = [];
    const result = await runSellerFlow("https://api.preview.test", {
      fetchImpl: createSmokeFetch(calls),
      env: {
        PLATFORM_API_AUTHORIZATION: "Bearer preview",
        SMOKE_ORDER_IDS: "ord_1,ord_2",
        SMOKE_BALANCE_CREDIT_AMOUNT: "10.00",
        SMOKE_CREATE_PAYMENT: "true",
        SMOKE_REQUEST_PAYOUT: "true",
      },
    });

    expect(result).toMatchObject({
      walletBalanceCreditAvailable: true,
      settlementProviderHealth: "ok",
      providerIdempotencySurfaces: "ok",
      checkout: {
        createPayment: "ok",
        paymentId: "pay_smoke",
        processorPaymentKind: "balance-credit",
      },
      setupPage: {
        status: "ok",
        statusCode: 200,
      },
      embeddedSetupSession: {
        status: "created",
        providerReference: "acct_embedded_smoke",
        clientSecretPresent: true,
        components: ["payout-setup"],
        expiresAt: "2026-06-01T15:00:00.000Z",
      },
      readinessRefresh: {
        status: "ok",
        readinessStatus: "ready",
        providerReference: "acct_embedded_smoke",
        payoutAccountDashboard: "none",
        lossesCollector: "application",
        feesCollector: "application",
        requirementsCollector: "application",
        requirementsCount: 0,
      },
      embeddedDashboardNone: {
        status: "verified",
        providerReference: "acct_embedded_smoke",
        accountSessionCreated: true,
        component: "payout-setup",
        payoutAccountDashboard: "none",
        lossesCollector: "application",
        feesCollector: "application",
        requirementsCollector: "application",
      },
      payoutPreview: {
        status: "available",
        canRequest: true,
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
        "/api/settlement/payout-setup/embedded-session",
        "/api/settlement/payouts",
      ]),
    );
    const refreshCall = calls.find((call) => new URL(call.url).pathname === "/api/settlement/payout-setup/refresh");
    expect(JSON.parse(refreshCall.init.body)).toMatchObject({
      providerReference: "acct_embedded_smoke",
    });
    expect(JSON.stringify(result)).not.toContain("acs_embedded_smoke_secret");
  });

  it("fails seller flow when embedded setup refresh reports Express dashboard posture", async () => {
    const calls = [];
    await expect(
      runSellerFlow("https://api.preview.test", {
        fetchImpl: async (url, init) => {
          const path = new URL(String(url)).pathname;
          if (path === "/api/settlement/payout-setup/refresh") {
            return jsonResponse({
              account_id: "acc_smoke_seller",
              status: "pending",
              provider_reference: "acct_embedded_smoke",
              payout_account_dashboard: "express",
              losses_collector: "application",
              fees_collector: "application",
              requirements_collector: "stripe",
              requirements: ["external_account"],
            });
          }
          return createSmokeFetch(calls)(url, init);
        },
        env: {
          PLATFORM_API_AUTHORIZATION: "Bearer preview",
          SMOKE_PAYOUT_READINESS_ATTEMPTS: "1",
        },
      }),
    ).rejects.toThrow(/dashboard posture to be none, got express/);
  });

  it("fails seller flow when embedded setup refresh does not match the Account Session provider reference", async () => {
    const calls = [];
    await expect(
      runSellerFlow("https://api.preview.test", {
        fetchImpl: async (url, init) => {
          const path = new URL(String(url)).pathname;
          if (path === "/api/settlement/payout-setup/refresh") {
            return jsonResponse({
              account_id: "acc_smoke_seller",
              status: "ready",
              provider_reference: "acct_stale_readiness",
              payout_account_dashboard: "none",
              losses_collector: "application",
              fees_collector: "application",
              requirements_collector: "application",
              requirements: [],
            });
          }
          return createSmokeFetch(calls)(url, init);
        },
        env: {
          PLATFORM_API_AUTHORIZATION: "Bearer preview",
          SMOKE_PAYOUT_READINESS_ATTEMPTS: "1",
        },
      }),
    ).rejects.toThrow(/to match embedded Account Session providerReference acct_embedded_smoke/);
  });

  it("fails seller flow when embedded setup refresh reports Stripe-owned requirements collection", async () => {
    const calls = [];
    await expect(
      runSellerFlow("https://api.preview.test", {
        fetchImpl: async (url, init) => {
          const path = new URL(String(url)).pathname;
          if (path === "/api/settlement/payout-setup/refresh") {
            return jsonResponse({
              account_id: "acc_smoke_seller",
              status: "pending",
              provider_reference: "acct_embedded_smoke",
              payout_account_dashboard: "none",
              losses_collector: "application",
              fees_collector: "application",
              requirements_collector: "stripe",
              requirements: ["external_account"],
            });
          }
          return createSmokeFetch(calls)(url, init);
        },
        env: {
          PLATFORM_API_AUTHORIZATION: "Bearer preview",
          SMOKE_PAYOUT_READINESS_ATTEMPTS: "1",
        },
      }),
    ).rejects.toThrow(/requirements collector to be application, got stripe/);
  });

  it("retries payout setup refresh until embedded dashboard-none readiness is projected", async () => {
    const calls = [];
    let refreshAttempts = 0;
    const result = await runSellerFlow("https://api.preview.test", {
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === "/api/settlement/payout-setup/refresh") {
          refreshAttempts += 1;
          if (refreshAttempts === 1) {
            return jsonResponse({
              account_id: "acc_smoke_seller",
              status: "not-started",
              provider_reference: null,
              payout_account_dashboard: "unknown",
              losses_collector: "unknown",
              fees_collector: "unknown",
              requirements_collector: "unknown",
              requirements: [],
            });
          }
        }
        return createSmokeFetch(calls)(url, init);
      },
      env: {
        PLATFORM_API_AUTHORIZATION: "Bearer preview",
        SMOKE_PAYOUT_READINESS_ATTEMPTS: "2",
        SMOKE_PAYOUT_READINESS_RETRY_DELAY_MS: "1",
      },
    });

    expect(refreshAttempts).toBe(2);
    expect(calls.filter((call) => new URL(call.url).pathname === "/api/settlement/payout-setup/refresh")).toHaveLength(
      1,
    );
    expect(result.embeddedDashboardNone).toMatchObject({
      status: "verified",
      providerReference: "acct_embedded_smoke",
      payoutAccountDashboard: "none",
      lossesCollector: "application",
      feesCollector: "application",
      requirementsCollector: "application",
    });
  });

  it("fails seller flow when the payout setup page route does not load", async () => {
    const calls = [];
    await expect(
      runSellerFlow("https://marketplace.preview.test", {
        fetchImpl: async (url, init) => {
          const path = new URL(String(url)).pathname;
          if (path === "/account/payouts/setup") {
            return jsonResponse({ error: { code: "not_found" } }, 404);
          }
          return createSmokeFetch(calls)(url, init);
        },
        env: {
          PLATFORM_API_AUTHORIZATION: "Bearer preview",
        },
      }),
    ).rejects.toThrow(/payout setup page/);
  });

  it("reports safe payout preview blocking reasons without requesting a payout", async () => {
    const calls = [];
    const result = await runSellerFlow("https://marketplace.preview.test", {
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === "/api/settlement/payouts/preview") {
          return jsonResponse({
            can_request: false,
            unavailable_reasons: ["payout-setup-incomplete"],
            unavailable_reason_details: [
              {
                code: "payout-setup-incomplete",
                message: "Finish payout setup before requesting payouts.",
              },
            ],
          });
        }
        return createSmokeFetch(calls)(url, init);
      },
      env: {
        PLATFORM_API_AUTHORIZATION: "Bearer preview",
        SMOKE_REQUEST_PAYOUT: "false",
      },
    });

    expect(result.payoutPreview).toMatchObject({
      status: "blocked",
      canRequest: false,
      unavailableReasons: ["payout-setup-incomplete"],
      unavailableReasonDetails: [
        {
          code: "payout-setup-incomplete",
          message: "Finish payout setup before requesting payouts.",
        },
      ],
    });
    expect(calls.map((call) => new URL(call.url).pathname)).not.toContain("/api/settlement/payouts");
  });

  it("can sign in with preview admin credentials when no bearer or cookie is supplied", async () => {
    const calls = [];
    const result = await runSellerFlow("https://marketplace.preview.test", {
      fetchImpl: createSmokeFetch(calls),
      env: {
        PLATFORM_AUTH_BASE_URL: "https://admin.preview.test",
        PLATFORM_ADMIN_EMAIL: "admin@example.test",
        PLATFORM_ADMIN_PASSWORD: "correct horse battery staple",
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
        PLATFORM_ADMIN_EMAIL: "admin@example.test",
        PLATFORM_ADMIN_PASSWORD: "correct horse battery staple",
        SMOKE_REGISTER_SELLER: "true",
        SMOKE_SELLER_EMAIL: "stripe-smoke@example.test",
        SMOKE_SELLER_PASSWORD: "preview smoke password",
      },
    });

    expect(result.accountStatus).toBe("ok");
    expect(calls.slice(0, 5).map((call) => new URL(call.url).pathname)).toEqual([
      "/api/auth/password-sign-in",
      "/api/identity/current-actor-display",
      "/api/identity/invitations",
      "/api/platform/projections/refresh",
      "/api/auth/register",
    ]);
    const invitationBody = JSON.parse(calls[2].init.body);
    expect(invitationBody).toMatchObject({
      accountId: "acc_platform_admin",
      email: "stripe-smoke@example.test",
      roleKey: "viewer",
    });
    expect(invitationBody.invitationId).toMatch(/^ivt_stripe_money_smoke_/);
    const registrationBody = JSON.parse(calls[4].init.body);
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
    const sellerSignInCall = calls.find((call) => {
      if (call.url !== "https://marketplace.preview.test/api/auth/password-sign-in") {
        return false;
      }
      return JSON.parse(call.init.body).email === "stripe-smoke@example.test";
    });
    expect(sellerSignInCall).toBeUndefined();
    const accountStatusCall = calls.find(
      (call) => call.url === "https://marketplace.preview.test/api/settlement/account-status",
    );
    expect(accountStatusCall.init.headers.get("Authorization")).toBe("Bearer session_seller");
  });

  it("waits for throwaway seller invitation projection catch-up before registration", async () => {
    const calls = [];
    let refreshCount = 0;
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/platform/projections/refresh") {
        refreshCount += 1;
        calls.push({ url: String(url), init });
        return jsonResponse({
          projectionGroups: [
            {
              targetContextName: "auth",
              projectionName: "auth-identity-invitation-projection",
              subscriptions: [{ sourceContextName: "identity", lastGlobalPosition: refreshCount === 1 ? "41" : "42" }],
            },
          ],
        });
      }
      return createSmokeFetch(calls)(url, init);
    };

    const result = await runSellerFlow("https://marketplace.preview.test", {
      fetchImpl,
      env: {
        PLATFORM_AUTH_BASE_URL: "https://marketplace.preview.test",
        PLATFORM_ADMIN_EMAIL: "admin@example.test",
        PLATFORM_ADMIN_PASSWORD: "correct horse battery staple",
        SMOKE_REGISTER_SELLER: "true",
        SMOKE_SELLER_EMAIL: "stripe-smoke@example.test",
        SMOKE_SELLER_PASSWORD: "preview smoke password",
        SMOKE_INVITATION_PROJECTION_TIMEOUT_MS: "1000",
        SMOKE_INVITATION_PROJECTION_POLL_MS: "1",
      },
    });

    expect(result.accountStatus).toBe("ok");
    expect(calls.slice(0, 6).map((call) => new URL(call.url).pathname)).toEqual([
      "/api/auth/password-sign-in",
      "/api/identity/current-actor-display",
      "/api/identity/invitations",
      "/api/platform/projections/refresh",
      "/api/platform/projections/refresh",
      "/api/auth/register",
    ]);
  });

  it("uses Terraform admin credential fallbacks when registering a throwaway seller", async () => {
    const calls = [];
    const result = await runSellerFlow("https://marketplace.preview.test", {
      fetchImpl: createSmokeFetch(calls),
      env: {
        PLATFORM_AUTH_BASE_URL: "https://marketplace.preview.test",
        TF_VAR_platform_admin_email: "admin@example.test",
        TF_VAR_platform_admin_password: "correct horse battery staple",
        SMOKE_REGISTER_SELLER: "true",
        SMOKE_SELLER_EMAIL: "stripe-smoke@example.test",
        SMOKE_SELLER_PASSWORD: "preview smoke password",
      },
    });

    expect(result.accountStatus).toBe("ok");
    expect(calls.slice(0, 5).map((call) => new URL(call.url).pathname)).toEqual([
      "/api/auth/password-sign-in",
      "/api/identity/current-actor-display",
      "/api/identity/invitations",
      "/api/platform/projections/refresh",
      "/api/auth/register",
    ]);
  });

  it("fails before seller registration when invitation admin credentials are missing", async () => {
    const calls = [];

    await expect(
      runSellerFlow("https://marketplace.preview.test", {
        fetchImpl: createSmokeFetch(calls),
        env: {
          PLATFORM_AUTH_BASE_URL: "https://marketplace.preview.test",
          SMOKE_REGISTER_SELLER: "true",
          SMOKE_SELLER_EMAIL: "stripe-smoke@example.test",
          SMOKE_SELLER_PASSWORD: "preview smoke password",
        },
      }),
    ).rejects.toThrow(
      "Missing PLATFORM_ADMIN_EMAIL or TF_VAR_platform_admin_email, PLATFORM_ADMIN_PASSWORD or TF_VAR_platform_admin_password.",
    );

    expect(calls.map((call) => new URL(call.url).pathname)).not.toContain("/api/auth/register");
  });
});
