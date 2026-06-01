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

      expect(String(input)).toBe("https://stripe.test/v2/core/accounts");
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

      return new Response(
        JSON.stringify({
          id: "acct_123",
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
    });
    expect(calls).toEqual(["https://stripe.test/v2/core/accounts", "https://stripe.test/v1/balance_settings"]);
  });

  it("Stripe adapter creates embedded payout setup account sessions", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });

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
        expect(body.get("components[account_onboarding][features][disable_stripe_user_authentication]")).toBe("false");
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
        "https://stripe.test/v2/core/accounts/acct_123?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements",
      );
      return new Response(
        JSON.stringify({
          id: "acct_123",
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
        missingRequirements: ["external_account"],
      },
    });
    expect(calls).toHaveLength(2);
  });

  it("Stripe adapter maps restricted capabilities to blocked provider-neutral readiness", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://stripe.test/v1/balance_settings") {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      expect(String(input)).toBe("https://stripe.test/v2/core/accounts");
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({
          id: "acct_restricted",
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

  it("Stripe adapter creates embedded payout account management sessions", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
      expect(body.get("components[account_management][features][disable_stripe_user_authentication]")).toBe("false");
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
  });

  it("Stripe adapter creates recipient onboarding account links with nested v2 parameters", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });

      if (String(input) === "https://stripe.test/v2/core/account_links") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toBeInstanceOf(Headers);
        const headers = init?.headers as Headers;
        expect(headers.get("Stripe-Version")).toBe("2026-03-25.dahlia");
        expect(headers.get("Content-Type")).toBe("application/json");
        expect(headers.get("Idempotency-Key")).toBe("onboarding-key");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          account: "acct_123",
          use_case: {
            type: "account_onboarding",
            account_onboarding: {
              configurations: ["recipient"],
              return_url: "https://example.test/return",
              refresh_url: "https://example.test/refresh",
              collection_options: {
                fields: "eventually_due",
                future_requirements: "include",
              },
            },
          },
        });

        return new Response(
          JSON.stringify({
            url: "https://connect.stripe.test/setup",
            expires_at: "2026-04-12T13:30:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      expect(String(input)).toBe(
        "https://stripe.test/v2/core/accounts/acct_123?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements",
      );
      return new Response(
        JSON.stringify({
          id: "acct_123",
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
      adapter.createOnboardingSession({
        accountId: "acc_seller" as never,
        providerReference: "acct_123",
        returnUrl: "https://example.test/return",
        refreshUrl: "https://example.test/refresh",
        idempotencyKey: "onboarding-key",
      }),
    ).resolves.toMatchObject({
      url: "https://connect.stripe.test/setup",
      providerReference: "acct_123",
      expiresAt: "2026-04-12T13:30:00.000Z",
    });
    expect(calls).toHaveLength(2);
  });

  it("Stripe adapter creates hosted account management sessions through the adapter", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://stripe.test/v1/accounts/acct_123/login_links");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toBeInstanceOf(Headers);
      const headers = init?.headers as Headers;
      expect(headers.get("Stripe-Version")).toBe("2026-03-25.dahlia");
      expect(headers.get("Idempotency-Key")).toBe("manage-key");
      expect(String(init?.body)).toContain("redirect_url=https%3A%2F%2Fexample.test%2Faccount%2Fpayouts");

      return new Response(
        JSON.stringify({
          url: "https://connect.stripe.test/express/acct_123",
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
      adapter.createAccountManagementSession({
        accountId: "acc_seller" as never,
        providerReference: "acct_123",
        returnUrl: "https://example.test/account/payouts",
        idempotencyKey: "manage-key",
      }),
    ).resolves.toEqual({
      providerReference: "acct_123",
      url: "https://connect.stripe.test/express/acct_123",
      expiresAt: null,
    });
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
        "https://stripe.test/v2/core/accounts/acct_123?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements",
      );
      return new Response(
        JSON.stringify({
          id: "acct_123",
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
      created: 1_776_000_000,
      data: {
        object: {
          id: "acct_123",
          requirements: { currently_due: ["external_account"] },
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
      providerEventId: "evt_account_requirements",
      providerReference: "acct_123",
      readiness: {
        providerReference: "acct_123",
        onboardingStatus: "pending",
        transferCapabilityStatus: "active",
        payoutCapabilityStatus: "pending",
        payoutDestinationStatus: "missing",
        missingRequirements: ["external_account", "individual.verification.document"],
      },
      occurredAt: "2026-04-12T13:20:00.000Z",
    });
    expect(calls).toHaveLength(1);
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
