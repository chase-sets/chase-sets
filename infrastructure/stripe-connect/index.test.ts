import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStripeConnectMoneyMovementGateway } from "./index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function stripeSignature(rawBody: string, secret: string, timestamp = 1_776_000_000) {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

describe("money movement adapters", () => {
  it("Stripe adapter creates Accounts v1 payout accounts with platform-held transfer readiness", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      if (String(input) === "https://stripe.test/v1/balance_settings") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toBeInstanceOf(Headers);
        const headers = init?.headers as Headers;
        expect(headers.get("Stripe-Account")).toBe("acct_v1");
        expect(headers.get("Idempotency-Key")).toBe("account-key:manual-payouts");
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (String(input) === "https://stripe.test/v1/accounts") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toBeInstanceOf(Headers);
        const headers = init?.headers as Headers;
        expect(headers.get("Stripe-Version")).toBe("2026-03-25.dahlia");
        expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
        expect(headers.get("Idempotency-Key")).toBe("account-key");
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("country")).toBe("US");
        expect(body.get("email")).toBe("seller@example.test");
        expect(body.get("capabilities[transfers][requested]")).toBe("true");
        expect(body.get("controller[stripe_dashboard][type]")).toBe("none");
        expect(body.get("controller[losses][payments]")).toBe("application");
        expect(body.get("controller[fees][payer]")).toBe("application");
        expect(body.get("controller[requirement_collection]")).toBe("application");
        expect(body.get("metadata[chase_sets_account_id]")).toBe("acc_seller");
        expect(body.get("metadata[funds_strategy]")).toBe("platform-held-on-demand-payout");
        expect(body.has("type")).toBe(false);

        return new Response(JSON.stringify({ id: "acct_v1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      expect(String(input)).toBe("https://stripe.test/v1/accounts/acct_v1");
      return new Response(
        JSON.stringify({
          id: "acct_v1",
          controller: {
            stripe_dashboard: { type: "none" },
            losses: { payments: "application" },
            fees: { payer: "application" },
            requirement_collection: "application",
          },
          capabilities: {
            transfers: "active",
          },
          payouts_enabled: true,
          requirements: { currently_due: [] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      accountsApi: "v1",
      apiBaseUrl: "https://stripe.test",
    });

    await expect(
      adapter.ensurePayoutAccount({
        accountId: "acc_seller" as never,
        currencyCode: "usd",
        contactEmail: " seller@example.test ",
        countryCode: "US",
        idempotencyKey: "account-key",
      }),
    ).resolves.toMatchObject({
      providerReference: "acct_v1",
      transferCapabilityStatus: "active",
      payoutCapabilityStatus: "active",
      payoutDestinationStatus: "ready",
      payoutAccountDashboard: "none",
      lossesCollector: "application",
      feesCollector: "application",
      requirementsCollector: "application",
      missingRequirements: [],
    });
    expect(calls).toEqual([
      "https://stripe.test/v1/accounts",
      "https://stripe.test/v1/accounts/acct_v1",
      "https://stripe.test/v1/balance_settings",
    ]);
  });

  it("Stripe adapter maps incompatible Accounts v1 controller posture to provider-neutral blockers", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://stripe.test/v1/accounts/acct_incompatible");
      return new Response(
        JSON.stringify({
          id: "acct_incompatible",
          controller: {
            stripe_dashboard: { type: "express" },
            losses: { payments: "stripe" },
            fees: { payer: "account" },
            requirement_collection: "stripe",
          },
          capabilities: {
            transfers: "active",
          },
          payouts_enabled: true,
          requirements: { currently_due: [] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      accountsApi: "v1",
      apiBaseUrl: "https://stripe.test",
    });

    await expect(
      adapter.refreshPayoutReadiness({
        accountId: "acc_seller" as never,
        providerReference: "acct_incompatible",
      }),
    ).resolves.toMatchObject({
      providerReference: "acct_incompatible",
      transferCapabilityStatus: "active",
      payoutCapabilityStatus: "active",
      payoutDestinationStatus: "pending",
      payoutAccountDashboard: "express",
      lossesCollector: "stripe",
      feesCollector: "unknown",
      requirementsCollector: "stripe",
      missingRequirements: [
        "provider_dashboard_posture",
        "provider_fee_payer_posture",
        "provider_loss_liability_posture",
        "provider_requirement_collection_posture",
      ],
    });
  });

  it("Stripe adapter surfaces Accounts v1 provider errors without falling back to Accounts v2", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      expect(String(input)).toBe("https://stripe.test/v1/accounts");
      return new Response(
        JSON.stringify({
          error: {
            message: "controller.requirement_collection is not supported for this platform account.",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      accountsApi: "v1",
      apiBaseUrl: "https://stripe.test",
    });

    await expect(
      adapter.ensurePayoutAccount({
        accountId: "acc_seller" as never,
        currencyCode: "usd",
        idempotencyKey: "provider-error-key",
      }),
    ).rejects.toMatchObject({
      name: "ProviderAdapterError",
      category: "capability_missing",
      providerStatus: 400,
      message: "controller.requirement_collection is not supported for this platform account.",
    });
    expect(calls).toEqual(["https://stripe.test/v1/accounts"]);
  });

  it("Stripe adapter requests Accounts v2 transfer and payout capabilities", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      if (String(input) === "https://stripe.test/v1/balance_settings") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toBeInstanceOf(Headers);
        const headers = init?.headers as Headers;
        expect(headers.get("Stripe-Account")).toBe("acct_123");
        expect(headers.get("Idempotency-Key")).toBe("account-key:manual-payouts");
        expect(String(init?.body)).toContain("payments%5Bpayouts%5D%5Bschedule%5D%5Binterval%5D=manual");
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (String(input) === "https://stripe.test/v2/core/accounts") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toBeInstanceOf(Headers);
        const headers = init?.headers as Headers;
        expect(headers.get("Stripe-Version")).toBe("2026-03-25.dahlia");
        expect(headers.get("Content-Type")).toBe("application/json");
        expect(headers.get("Idempotency-Key")).toBe("account-key");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          contact_email: "seller@example.test",
          identity: {
            country: "US",
          },
          metadata: {
            chase_sets_account_id: "acc_seller",
          },
          configuration: {
            recipient: {
              capabilities: {
                stripe_balance: {
                  stripe_transfers: { requested: true },
                },
              },
            },
          },
          defaults: {
            responsibilities: {
              fees_collector: "application",
              losses_collector: "application",
            },
          },
          dashboard: "none",
        });
        expect(JSON.parse(String(init?.body)).defaults.responsibilities).not.toHaveProperty("requirements_collector");

        return new Response(JSON.stringify({ id: "acct_123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      expect(String(input)).toBe(
        "https://stripe.test/v2/core/accounts/acct_123?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements&include%5B2%5D=defaults",
      );
      return new Response(
        JSON.stringify({
          id: "acct_123",
          dashboard: "none",
          defaults: {
            responsibilities: {
              fees_collector: "application",
              losses_collector: "application",
              requirements_collector: "application",
            },
          },
          requirements: { currently_due: [] },
          configuration: {
            recipient: {
              capabilities: {
                stripe_balance: {
                  stripe_transfers: { status: "active" },
                  payouts: { status: "active" },
                },
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      apiBaseUrl: "https://stripe.test",
    });

    await expect(
      adapter.ensurePayoutAccount({
        accountId: "acc_seller" as never,
        currencyCode: "usd",
        contactEmail: "seller@example.test",
        countryCode: "US",
        idempotencyKey: "account-key",
      }),
    ).resolves.toMatchObject({
      providerReference: "acct_123",
      transferCapabilityStatus: "active",
      payoutCapabilityStatus: "active",
      payoutDestinationStatus: "ready",
      payoutAccountDashboard: "none",
      lossesCollector: "application",
      feesCollector: "application",
      requirementsCollector: "application",
    });
    expect(calls).toEqual([
      "https://stripe.test/v2/core/accounts",
      "https://stripe.test/v2/core/accounts/acct_123?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements&include%5B2%5D=defaults",
      "https://stripe.test/v1/balance_settings",
    ]);
  });

  it("Stripe adapter creates embedded payout setup account sessions", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });

      if (String(input) === "https://stripe.test/v2/core/accounts/acct_123") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toBeInstanceOf(Headers);
        const headers = init?.headers as Headers;
        expect(headers.get("Stripe-Version")).toBe("2026-03-25.dahlia");
        expect(headers.get("Content-Type")).toBe("application/json");
        expect(headers.get("Idempotency-Key")).toBe("embedded-setup-key:contact-email");
        expect(JSON.parse(String(init?.body))).toEqual({
          contact_email: "seller@example.test",
        });

        return new Response(JSON.stringify({ id: "acct_123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (String(input) === "https://stripe.test/v1/account_sessions") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toBeInstanceOf(Headers);
        const headers = init?.headers as Headers;
        expect(headers.get("Stripe-Version")).toBe("2026-03-25.dahlia");
        expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
        expect(headers.get("Idempotency-Key")).toBe("embedded-setup-key");
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("account")).toBe("acct_123");
        expect(body.get("components[account_onboarding][enabled]")).toBe("true");
        expect(body.get("components[account_onboarding][features][external_account_collection]")).toBe("true");
        expect(body.get("components[account_onboarding][features][disable_stripe_user_authentication]")).toBe("true");
        expect([...body.keys()].some((key) => key.startsWith("components[account_management]"))).toBe(false);

        return new Response(
          JSON.stringify({
            client_secret: "acs_secret_setup",
            expires_at: 1_777_000_000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      expect(String(input)).toBe(
        "https://stripe.test/v2/core/accounts/acct_123?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements&include%5B2%5D=defaults",
      );
      return new Response(
        JSON.stringify({
          id: "acct_123",
          dashboard: "express",
          defaults: {
            responsibilities: {
              fees_collector: "application",
              losses_collector: "application",
              requirements_collector: "application",
            },
          },
          requirements: { currently_due: ["external_account"] },
          configuration: {
            recipient: {
              capabilities: {
                stripe_balance: {
                  stripe_transfers: { status: "active" },
                  payouts: { status: "pending" },
                },
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      apiBaseUrl: "https://stripe.test",
    });

    await expect(
      adapter.createPayoutSetupSession({
        accountId: "acc_seller" as never,
        providerReference: "acct_123",
        contactEmail: " seller@example.test ",
        idempotencyKey: "embedded-setup-key",
      }),
    ).resolves.toMatchObject({
      providerReference: "acct_123",
      clientSecret: "acs_secret_setup",
      expiresAt: "2026-04-24T03:06:40.000Z",
      components: ["payout-setup"],
      readiness: {
        providerReference: "acct_123",
        onboardingStatus: "pending",
        transferCapabilityStatus: "active",
        payoutCapabilityStatus: "pending",
        payoutDestinationStatus: "missing",
        payoutAccountDashboard: "express",
        lossesCollector: "application",
        feesCollector: "application",
        requirementsCollector: "application",
        missingRequirements: ["external_account"],
      },
    });
    expect(calls.map((call) => call.input)).toEqual([
      "https://stripe.test/v2/core/accounts/acct_123",
      "https://stripe.test/v2/core/accounts/acct_123?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements&include%5B2%5D=defaults",
      "https://stripe.test/v1/account_sessions",
    ]);
  });

  it("Stripe adapter creates hosted payout setup account links", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });

      if (String(input) === "https://stripe.test/v2/core/accounts/acct_123") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toBeInstanceOf(Headers);
        const headers = init?.headers as Headers;
        expect(headers.get("Idempotency-Key")).toBe("hosted-setup-key:contact-email");
        expect(JSON.parse(String(init?.body))).toEqual({
          contact_email: "seller@example.test",
        });

        return new Response(JSON.stringify({ id: "acct_123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (String(input) === "https://stripe.test/v1/account_links") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toBeInstanceOf(Headers);
        const headers = init?.headers as Headers;
        expect(headers.get("Stripe-Version")).toBe("2026-03-25.dahlia");
        expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
        expect(headers.get("Idempotency-Key")).toBe("hosted-setup-key");
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("account")).toBe("acct_123");
        expect(body.get("type")).toBe("account_onboarding");
        expect(body.get("return_url")).toBe("https://app.test/account/payouts/setup/return");
        expect(body.get("refresh_url")).toBe("https://app.test/account/payouts/setup/refresh");

        return new Response(
          JSON.stringify({
            url: "https://connect.stripe.com/setup/c/acct_123/link_test",
            expires_at: 1_777_000_000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      expect(String(input)).toBe(
        "https://stripe.test/v2/core/accounts/acct_123?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements&include%5B2%5D=defaults",
      );
      return new Response(
        JSON.stringify({
          id: "acct_123",
          dashboard: "none",
          defaults: {
            responsibilities: {
              fees_collector: "application",
              losses_collector: "application",
              requirements_collector: "application",
            },
          },
          requirements: { currently_due: ["external_account"] },
          configuration: {
            recipient: {
              capabilities: {
                stripe_balance: {
                  stripe_transfers: { status: "active" },
                  payouts: { status: "pending" },
                },
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      apiBaseUrl: "https://stripe.test",
    });

    await expect(
      adapter.createPayoutSetupLink({
        accountId: "acc_seller" as never,
        providerReference: "acct_123",
        contactEmail: " seller@example.test ",
        returnUrl: "https://app.test/account/payouts/setup/return",
        refreshUrl: "https://app.test/account/payouts/setup/refresh",
        idempotencyKey: "hosted-setup-key",
      }),
    ).resolves.toMatchObject({
      providerReference: "acct_123",
      url: "https://connect.stripe.com/setup/c/acct_123/link_test",
      expiresAt: "2026-04-24T03:06:40.000Z",
      readiness: {
        providerReference: "acct_123",
        onboardingStatus: "pending",
        missingRequirements: ["external_account"],
      },
    });
    expect(calls.map((call) => call.input)).toEqual([
      "https://stripe.test/v2/core/accounts/acct_123",
      "https://stripe.test/v2/core/accounts/acct_123?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements&include%5B2%5D=defaults",
      "https://stripe.test/v1/account_links",
    ]);
  });

  it("Stripe adapter creates Accounts v1 embedded payout setup account sessions", async () => {
    const calls: Array<{ input: string; method: string | undefined }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), method: init?.method });

      if (String(input) === "https://stripe.test/v1/accounts/acct_v1" && init?.method === "POST") {
        expect(init?.headers).toBeInstanceOf(Headers);
        const headers = init?.headers as Headers;
        expect(headers.get("Stripe-Version")).toBe("2026-03-25.dahlia");
        expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
        expect(headers.get("Idempotency-Key")).toBe("embedded-v1-setup-key:contact-email");
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("email")).toBe("seller@example.test");

        return new Response(JSON.stringify({ id: "acct_v1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (String(input) === "https://stripe.test/v1/accounts/acct_v1") {
        expect(init?.method).toBe("GET");
        return new Response(
          JSON.stringify({
            id: "acct_v1",
            controller: {
              stripe_dashboard: { type: "none" },
              losses: { payments: "application" },
              fees: { payer: "application" },
              requirement_collection: "application",
            },
            capabilities: {
              transfers: "pending",
            },
            payouts_enabled: false,
            requirements: { currently_due: ["external_account"] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      expect(String(input)).toBe("https://stripe.test/v1/account_sessions");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toBeInstanceOf(Headers);
      const headers = init?.headers as Headers;
      expect(headers.get("Stripe-Version")).toBe("2026-03-25.dahlia");
      expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
      expect(headers.get("Idempotency-Key")).toBe("embedded-v1-setup-key");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("account")).toBe("acct_v1");
      expect(body.get("components[account_onboarding][enabled]")).toBe("true");
      expect(body.get("components[account_onboarding][features][external_account_collection]")).toBe("true");
      expect(body.get("components[account_onboarding][features][disable_stripe_user_authentication]")).toBe("true");
      expect([...body.keys()].some((key) => key.startsWith("components[account_management]"))).toBe(false);

      return new Response(
        JSON.stringify({
          client_secret: "acs_secret_v1_setup",
          expires_at: 1_777_000_000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      accountsApi: "v1",
      apiBaseUrl: "https://stripe.test",
    });

    await expect(
      adapter.createPayoutSetupSession({
        accountId: "acc_seller" as never,
        providerReference: "acct_v1",
        contactEmail: " seller@example.test ",
        idempotencyKey: "embedded-v1-setup-key",
      }),
    ).resolves.toMatchObject({
      providerReference: "acct_v1",
      clientSecret: "acs_secret_v1_setup",
      expiresAt: "2026-04-24T03:06:40.000Z",
      components: ["payout-setup"],
      readiness: {
        providerReference: "acct_v1",
        onboardingStatus: "pending",
        transferCapabilityStatus: "pending",
        payoutCapabilityStatus: "inactive",
        payoutDestinationStatus: "missing",
        payoutAccountDashboard: "none",
        lossesCollector: "application",
        feesCollector: "application",
        requirementsCollector: "application",
        missingRequirements: ["external_account"],
      },
    });
    expect(calls).toEqual([
      { input: "https://stripe.test/v1/accounts/acct_v1", method: "POST" },
      { input: "https://stripe.test/v1/accounts/acct_v1", method: "GET" },
      { input: "https://stripe.test/v1/account_sessions", method: "POST" },
    ]);
  });

  it("Stripe adapter creates Accounts v1 embedded payout account management sessions", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));

      if (String(input) === "https://stripe.test/v1/accounts/acct_v1") {
        expect(init?.method).toBe("GET");
        return new Response(
          JSON.stringify({
            id: "acct_v1",
            controller: {
              stripe_dashboard: { type: "none" },
              losses: { payments: "application" },
              fees: { payer: "application" },
              requirement_collection: "application",
            },
            capabilities: {
              transfers: "active",
            },
            payouts_enabled: true,
            requirements: { currently_due: [] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      expect(String(input)).toBe("https://stripe.test/v1/account_sessions");
      expect(init?.method).toBe("POST");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("account")).toBe("acct_v1");
      expect(body.get("components[account_management][enabled]")).toBe("true");
      expect(body.get("components[account_management][features][external_account_collection]")).toBe("true");
      expect(body.get("components[account_management][features][disable_stripe_user_authentication]")).toBe("true");
      expect([...body.keys()].some((key) => key.startsWith("components[account_onboarding]"))).toBe(false);

      return new Response(
        JSON.stringify({
          client_secret: "acs_secret_v1_manage",
          expires_at: 1_777_000_000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      accountsApi: "v1",
      apiBaseUrl: "https://stripe.test",
    });

    await expect(
      adapter.createPayoutAccountManagementSession({
        accountId: "acc_seller" as never,
        providerReference: "acct_v1",
        idempotencyKey: "embedded-v1-manage-key",
      }),
    ).resolves.toEqual({
      providerReference: "acct_v1",
      clientSecret: "acs_secret_v1_manage",
      expiresAt: "2026-04-24T03:06:40.000Z",
      components: ["payout-account-management"],
    });
    expect(calls).toEqual(["https://stripe.test/v1/accounts/acct_v1", "https://stripe.test/v1/account_sessions"]);
  });

  it.each([
    ["expired", "account_session_expired", "Stripe account session expired.", "configuration"],
    ["incomplete", "account_session_incomplete", "Account requirements are incomplete.", "capability_missing"],
    ["rejected", "account_session_rejected", "Stripe rejected the account session.", "provider_declined"],
  ] as const)(
    "Stripe adapter surfaces Accounts v1 %s account session provider errors",
    async (_name, code, message, category) => {
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "https://stripe.test/v1/accounts/acct_v1") {
          expect(init?.method).toBe("GET");
          return new Response(
            JSON.stringify({
              id: "acct_v1",
              controller: {
                stripe_dashboard: { type: "none" },
                losses: { payments: "application" },
                fees: { payer: "application" },
                requirement_collection: "application",
              },
              capabilities: {
                transfers: "pending",
              },
              payouts_enabled: false,
              requirements: { currently_due: ["external_account"] },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        expect(String(input)).toBe("https://stripe.test/v1/account_sessions");
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ error: { code, message } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;
      const adapter = createStripeConnectMoneyMovementGateway({
        secretKey: "sk_test",
        webhookSecret: "whsec_test",
        accountsApi: "v1",
        apiBaseUrl: "https://stripe.test",
      });

      await expect(
        adapter.createPayoutSetupSession({
          accountId: "acc_seller" as never,
          providerReference: "acct_v1",
          idempotencyKey: "embedded-v1-error-key",
        }),
      ).rejects.toMatchObject({
        name: "ProviderAdapterError",
        category,
        providerStatus: 400,
        message,
      });
    },
  );

  it("Stripe adapter keeps embedded Stripe user authentication for Stripe-collected accounts", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));

      if (
        String(input) ===
        "https://stripe.test/v2/core/accounts/acct_stripe_collected?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements&include%5B2%5D=defaults"
      ) {
        return new Response(
          JSON.stringify({
            id: "acct_stripe_collected",
            dashboard: "express",
            defaults: {
              responsibilities: {
                fees_collector: "stripe",
                losses_collector: "stripe",
                requirements_collector: "stripe",
              },
            },
            requirements: { currently_due: ["external_account"] },
            configuration: {
              recipient: {
                capabilities: {
                  stripe_balance: {
                    stripe_transfers: { status: "active" },
                    payouts: { status: "pending" },
                  },
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      expect(String(input)).toBe("https://stripe.test/v1/account_sessions");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("account")).toBe("acct_stripe_collected");
      expect(body.get("components[account_onboarding][features][disable_stripe_user_authentication]")).toBe("false");

      return new Response(
        JSON.stringify({
          client_secret: "acs_secret_stripe_collected",
          expires_at: 1_777_000_000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      apiBaseUrl: "https://stripe.test",
    });

    await expect(
      adapter.createPayoutSetupSession({
        accountId: "acc_seller" as never,
        providerReference: "acct_stripe_collected",
        idempotencyKey: "embedded-setup-key",
      }),
    ).resolves.toMatchObject({
      providerReference: "acct_stripe_collected",
      clientSecret: "acs_secret_stripe_collected",
      readiness: {
        requirementsCollector: "stripe",
      },
    });
    expect(calls).toEqual([
      "https://stripe.test/v2/core/accounts/acct_stripe_collected?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements&include%5B2%5D=defaults",
      "https://stripe.test/v1/account_sessions",
    ]);
  });

  it("Stripe adapter maps restricted capabilities to blocked provider-neutral readiness", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://stripe.test/v1/balance_settings") {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (String(input) === "https://stripe.test/v2/core/accounts") {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ id: "acct_restricted" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      expect(String(input)).toBe(
        "https://stripe.test/v2/core/accounts/acct_restricted?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements&include%5B2%5D=defaults",
      );
      return new Response(
        JSON.stringify({
          id: "acct_restricted",
          dashboard: "none",
          defaults: {
            responsibilities: {
              fees_collector: "application",
              losses_collector: "application",
              requirements_collector: "application",
            },
          },
          requirements: { currently_due: ["external_account"] },
          configuration: {
            recipient: {
              capabilities: {
                stripe_balance: {
                  stripe_transfers: { status: "restricted" },
                  payouts: { status: "restricted" },
                },
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      apiBaseUrl: "https://stripe.test",
    });

    await expect(
      adapter.ensurePayoutAccount({
        accountId: "acc_seller" as never,
        currencyCode: "usd",
        idempotencyKey: "restricted-key",
      }),
    ).resolves.toMatchObject({
      providerReference: "acct_restricted",
      transferCapabilityStatus: "inactive",
      payoutCapabilityStatus: "inactive",
      payoutDestinationStatus: "missing",
      missingRequirements: ["external_account"],
    });
  });

  it("Stripe adapter maps Accounts v2 requirement entries into payout setup blockers", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://stripe.test/v1/balance_settings") {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (String(input) === "https://stripe.test/v2/core/accounts") {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ id: "acct_entries" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      expect(String(input)).toBe(
        "https://stripe.test/v2/core/accounts/acct_entries?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements&include%5B2%5D=defaults",
      );
      return new Response(
        JSON.stringify({
          id: "acct_entries",
          dashboard: "none",
          defaults: {
            responsibilities: {
              fees_collector: "application",
              losses_collector: "application",
              requirements_collector: "application",
            },
          },
          requirements: {
            entries: [
              {
                minimum_deadline: { status: "currently_due" },
                reference: { type: "payment_method", resource: "pm_test" },
                impact: {
                  restricts_capabilities: [
                    {
                      configuration: "recipient",
                      capability: "stripe_balance.payouts",
                      deadline: { status: "past_due" },
                    },
                  ],
                },
              },
              {
                minimum_deadline: { status: "currently_due" },
                reference: { type: "person", resource: "person_test" },
                requested_reasons: [{ code: "routine_onboarding" }],
              },
            ],
          },
          configuration: {
            recipient: {
              capabilities: {
                stripe_balance: {
                  stripe_transfers: { status: "pending" },
                  payouts: { status: "pending" },
                },
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      apiBaseUrl: "https://stripe.test",
    });

    await expect(
      adapter.ensurePayoutAccount({
        accountId: "acc_seller" as never,
        currencyCode: "usd",
        idempotencyKey: "entries-key",
      }),
    ).resolves.toMatchObject({
      providerReference: "acct_entries",
      onboardingStatus: "pending",
      transferCapabilityStatus: "pending",
      payoutCapabilityStatus: "pending",
      payoutDestinationStatus: "missing",
      missingRequirements: ["identity_and_business", "payout_account"],
    });
  });

  it("Stripe adapter treats capability status details with required provider info as setup blockers", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://stripe.test/v1/balance_settings") {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (String(input) === "https://stripe.test/v2/core/accounts") {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ id: "acct_status_details" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(
        JSON.stringify({
          id: "acct_status_details",
          dashboard: "none",
          defaults: {
            responsibilities: {
              fees_collector: "application",
              losses_collector: "application",
              requirements_collector: "application",
            },
          },
          requirements: { entries: [] },
          configuration: {
            recipient: {
              capabilities: {
                stripe_balance: {
                  stripe_transfers: {
                    status: "pending",
                    status_details: [{ code: "requirements_past_due", resolution: "provide_info" }],
                  },
                  payouts: {
                    status: "pending",
                    status_details: [{ code: "requirements_past_due", resolution: "provide_info" }],
                  },
                },
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      apiBaseUrl: "https://stripe.test",
    });

    await expect(
      adapter.ensurePayoutAccount({
        accountId: "acc_seller" as never,
        currencyCode: "usd",
        idempotencyKey: "status-detail-key",
      }),
    ).resolves.toMatchObject({
      onboardingStatus: "pending",
      missingRequirements: ["identity_and_business", "payout_account"],
    });
  });

  it("Stripe adapter preserves platform-held transfer and connected-account payout calls in Accounts v1 mode", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });

      if (String(input) === "https://stripe.test/v1/transfers") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toBeInstanceOf(Headers);
        const headers = init?.headers as Headers;
        expect(headers.get("Stripe-Version")).toBe("2026-03-25.dahlia");
        expect(headers.get("Idempotency-Key")).toBe("transfer-key");
        expect(headers.get("Stripe-Account")).toBeNull();
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("amount")).toBe("1250");
        expect(body.get("currency")).toBe("usd");
        expect(body.get("destination")).toBe("acct_v1");
        expect(body.get("transfer_group")).toBe("payout:pyo_123");
        expect(body.get("metadata[funds_strategy]")).toBe("platform-held-on-demand-payout");
        expect(body.get("metadata[payout_id]")).toBe("pyo_123");
        expect(body.get("metadata[account_id]")).toBe("acc_seller");
        expect(body.get("metadata[source_balance]")).toBe("platform");

        return new Response(JSON.stringify({ id: "tr_platform_to_connected", status: "pending" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (String(input) === "https://stripe.test/v1/balance_settings") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toBeInstanceOf(Headers);
        const headers = init?.headers as Headers;
        expect(headers.get("Stripe-Account")).toBe("acct_v1");
        expect(headers.get("Idempotency-Key")).toBe("payout-key:manual-payouts");
        expect(String(init?.body)).toContain("payments%5Bpayouts%5D%5Bschedule%5D%5Binterval%5D=manual");

        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      expect(String(input)).toBe("https://stripe.test/v1/payouts");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toBeInstanceOf(Headers);
      const headers = init?.headers as Headers;
      expect(headers.get("Stripe-Version")).toBe("2026-03-25.dahlia");
      expect(headers.get("Stripe-Account")).toBe("acct_v1");
      expect(headers.get("Idempotency-Key")).toBe("payout-key");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("amount")).toBe("1250");
      expect(body.get("currency")).toBe("usd");
      expect(body.get("metadata[funds_strategy]")).toBe("platform-held-on-demand-payout");
      expect(body.get("metadata[transfer_group]")).toBe("payout:pyo_123");
      expect(body.get("metadata[payout_id]")).toBe("pyo_123");
      expect(body.get("metadata[account_id]")).toBe("acc_seller");

      return new Response(JSON.stringify({ id: "po_connected", status: "pending" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      accountsApi: "v1",
      apiBaseUrl: "https://stripe.test",
    });

    await expect(
      adapter.transferPlatformBalanceToConnectedAccount({
        payoutId: "pyo_123" as never,
        accountId: "acc_seller" as never,
        providerReference: "acct_v1",
        amount: "12.50",
        currencyCode: "usd",
        idempotencyKey: "transfer-key",
      }),
    ).resolves.toEqual({
      providerTransferReference: "tr_platform_to_connected",
      providerStatus: "pending",
    });

    await expect(
      adapter.createConnectedAccountPayout({
        payoutId: "pyo_123" as never,
        accountId: "acc_seller" as never,
        providerReference: "acct_v1",
        amount: "12.50",
        currencyCode: "usd",
        idempotencyKey: "payout-key",
      }),
    ).resolves.toEqual({
      providerPayoutReference: "po_connected",
      providerStatus: "pending",
    });

    expect(calls.map((call) => call.input)).toEqual([
      "https://stripe.test/v1/transfers",
      "https://stripe.test/v1/balance_settings",
      "https://stripe.test/v1/payouts",
    ]);
  });

  it("Stripe adapter creates embedded payout account management sessions", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });

      if (
        String(input) ===
        "https://stripe.test/v2/core/accounts/acct_123?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements&include%5B2%5D=defaults"
      ) {
        return new Response(
          JSON.stringify({
            id: "acct_123",
            dashboard: "none",
            defaults: {
              responsibilities: {
                fees_collector: "application",
                losses_collector: "application",
                requirements_collector: "application",
              },
            },
            requirements: { currently_due: [] },
            configuration: {
              recipient: {
                capabilities: {
                  stripe_balance: {
                    stripe_transfers: { status: "active" },
                    payouts: { status: "active" },
                  },
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      expect(String(input)).toBe("https://stripe.test/v1/account_sessions");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toBeInstanceOf(Headers);
      const headers = init?.headers as Headers;
      expect(headers.get("Stripe-Version")).toBe("2026-03-25.dahlia");
      expect(headers.get("Idempotency-Key")).toBe("embedded-manage-key");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("account")).toBe("acct_123");
      expect(body.get("components[account_management][enabled]")).toBe("true");
      expect(body.get("components[account_management][features][external_account_collection]")).toBe("true");
      expect(body.get("components[account_management][features][disable_stripe_user_authentication]")).toBe("true");
      expect([...body.keys()].some((key) => key.startsWith("components[account_onboarding]"))).toBe(false);

      return new Response(
        JSON.stringify({
          client_secret: "acs_secret_manage",
          expires_at: "2026-04-24T03:06:40.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      apiBaseUrl: "https://stripe.test",
    });

    await expect(
      adapter.createPayoutAccountManagementSession({
        accountId: "acc_seller" as never,
        providerReference: "acct_123",
        idempotencyKey: "embedded-manage-key",
      }),
    ).resolves.toEqual({
      providerReference: "acct_123",
      clientSecret: "acs_secret_manage",
      expiresAt: "2026-04-24T03:06:40.000Z",
      components: ["payout-account-management"],
    });
    expect(calls.map((call) => call.input)).toEqual([
      "https://stripe.test/v2/core/accounts/acct_123?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements&include%5B2%5D=defaults",
      "https://stripe.test/v1/account_sessions",
    ]);
  });

  it("Stripe adapter surfaces provider error messages", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "Accounts v2 is not enabled." } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    ) as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      apiBaseUrl: "https://stripe.test",
    });

    await expect(
      adapter.ensurePayoutAccount({
        accountId: "acc_seller" as never,
        currencyCode: "usd",
        idempotencyKey: "account-key",
      }),
    ).rejects.toThrow("Accounts v2 is not enabled.");
  });

  it("Stripe webhook parser maps payout failures to provider-neutral events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-12T13:21:00.000Z"));
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
    });
    const rawBody = JSON.stringify({
      type: "payout.failed",
      created: 1_776_000_000,
      data: {
        object: {
          id: "po_123",
          status: "failed",
          failure_code: "account_closed",
          failure_message: "The account is closed.",
        },
      },
    });

    await expect(
      adapter.parseMoneyMovementWebhook({
        rawBody,
        signatureHeader: stripeSignature(rawBody, "whsec_test"),
      }),
    ).resolves.toEqual({
      kind: "payout-failed",
      providerEventId: "stripe:payout.failed:po_123",
      providerPayoutReference: "po_123",
      providerStatus: "failed",
      failureCode: "account_closed",
      failureMessage: "The account is closed.",
      occurredAt: "2026-04-12T13:20:00.000Z",
    });
  });

  it("Stripe webhook parser retrieves full account readiness so webhooks match manual refresh shape", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-12T13:21:00.000Z"));
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      expect(String(input)).toBe(
        "https://stripe.test/v2/core/accounts/acct_123?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements&include%5B2%5D=defaults",
      );
      return new Response(
        JSON.stringify({
          id: "acct_123",
          dashboard: "none",
          defaults: {
            responsibilities: {
              fees_collector: "application",
              losses_collector: "application",
              requirements_collector: "application",
            },
          },
          requirements: {
            currently_due: ["external_account"],
            eventually_due: ["individual.verification.document"],
          },
          configuration: {
            recipient: {
              capabilities: {
                stripe_balance: {
                  stripe_transfers: { status: "active" },
                  payouts: { status: "pending" },
                },
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      apiBaseUrl: "https://stripe.test",
    });
    const rawBody = JSON.stringify({
      id: "evt_account_requirements",
      type: "v2.core.account[requirements].updated",
      created: "2026-04-12T13:20:00.000Z",
      related_object: {
        id: "acct_123",
      },
    });

    await expect(
      adapter.parseMoneyMovementWebhook({
        rawBody,
        signatureHeader: stripeSignature(rawBody, "whsec_test"),
      }),
    ).resolves.toEqual({
      kind: "payout-readiness-updated",
      providerEventId: "evt_account_requirements",
      providerReference: "acct_123",
      readiness: {
        providerReference: "acct_123",
        contactEmail: null,
        onboardingStatus: "pending",
        transferCapabilityStatus: "active",
        payoutCapabilityStatus: "pending",
        payoutDestinationStatus: "missing",
        payoutDestinationFingerprint: null,
        payoutAccountDashboard: "none",
        lossesCollector: "application",
        feesCollector: "application",
        requirementsCollector: "application",
        missingRequirements: ["external_account", "individual.verification.document"],
      },
      occurredAt: "2026-04-12T13:20:00.000Z",
    });
    expect(calls).toHaveLength(1);
  });

  it("Stripe webhook parser ignores malformed Accounts v2 readiness envelopes without retryable errors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-12T13:21:00.000Z"));
    globalThis.fetch = vi.fn(async () => {
      throw new Error("malformed readiness envelopes should not fetch Stripe accounts");
    }) as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      apiBaseUrl: "https://stripe.test",
    });
    const rawBody = JSON.stringify({
      id: "evt_account_requirements_missing_reference",
      type: "v2.core.account.updated",
      created: "not-a-date",
    });

    await expect(
      adapter.parseMoneyMovementWebhook({
        rawBody,
        signatureHeader: stripeSignature(rawBody, "whsec_test"),
      }),
    ).resolves.toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("Stripe webhook parser maps Accounts v1 account.updated into blocked provider-neutral readiness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-12T13:21:00.000Z"));
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      expect(String(input)).toBe("https://stripe.test/v1/accounts/acct_v1");
      return new Response(
        JSON.stringify({
          id: "acct_v1",
          controller: {
            stripe_dashboard: { type: "express" },
            losses: { payments: "stripe" },
            fees: { payer: "account" },
            requirement_collection: "stripe",
          },
          capabilities: {
            transfers: "active",
          },
          payouts_enabled: true,
          requirements: { currently_due: ["external_account"] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      accountsApi: "v1",
      apiBaseUrl: "https://stripe.test",
    });
    const rawBody = JSON.stringify({
      id: "evt_account_v1",
      type: "account.updated",
      created: 1_776_000_000,
      account: "acct_v1",
      data: {
        object: {
          id: "acct_v1",
          object: "account",
        },
      },
    });

    await expect(
      adapter.parseMoneyMovementWebhook({
        rawBody,
        signatureHeader: stripeSignature(rawBody, "whsec_test"),
      }),
    ).resolves.toEqual({
      kind: "payout-readiness-updated",
      providerEventId: "evt_account_v1",
      providerReference: "acct_v1",
      readiness: {
        providerReference: "acct_v1",
        contactEmail: null,
        onboardingStatus: "pending",
        transferCapabilityStatus: "active",
        payoutCapabilityStatus: "active",
        payoutDestinationStatus: "missing",
        payoutDestinationFingerprint: null,
        payoutAccountDashboard: "express",
        lossesCollector: "stripe",
        feesCollector: "unknown",
        requirementsCollector: "stripe",
        missingRequirements: [
          "external_account",
          "provider_dashboard_posture",
          "provider_fee_payer_posture",
          "provider_loss_liability_posture",
          "provider_requirement_collection_posture",
        ],
      },
      occurredAt: "2026-04-12T13:20:00.000Z",
    });
    expect(calls).toEqual(["https://stripe.test/v1/accounts/acct_v1"]);
  });

  it("Stripe webhook parser rejects stale signatures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-12T14:00:00.000Z"));
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
    });
    const rawBody = JSON.stringify({
      type: "payout.paid",
      created: 1_776_000_000,
      data: { object: { id: "po_123", status: "paid" } },
    });

    await expect(
      adapter.parseMoneyMovementWebhook({
        rawBody,
        signatureHeader: stripeSignature(rawBody, "whsec_test"),
      }),
    ).rejects.toThrow("Stripe webhook signature timestamp is outside tolerance.");
  });
});
