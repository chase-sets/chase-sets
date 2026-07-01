import { createHmac } from "node:crypto";
import type { ProviderAdapterError } from "@chase-sets/http/provider-errors";
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
  it("fails closed when Accounts v1 is selected before the v1 strategy is implemented", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const adapter = createStripeConnectMoneyMovementGateway({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      accountsApi: "v1",
      apiBaseUrl: "https://stripe.test",
    });

    const operation = adapter.ensurePayoutAccount({
      accountId: "acc_seller" as never,
      currencyCode: "usd",
      contactEmail: "seller@example.test",
      countryCode: "US",
      idempotencyKey: "account-key",
    });

    await expect(operation).rejects.toMatchObject({
      name: "ProviderAdapterError",
      category: "configuration",
      message:
        "Stripe Connect Accounts v1 is selected but the Accounts v1 provisioning strategy is not implemented yet.",
    } satisfies Partial<ProviderAdapterError>);
    expect(fetchMock).not.toHaveBeenCalled();
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
