import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStripeConnectMoneyMovementGateway } from "./index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stripeSignature(rawBody: string, secret: string, timestamp = 1_776_000_000) {
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

describe("money movement adapters", () => {
  it("Stripe adapter requests Accounts v2 transfer and payout capabilities", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://stripe.test/v2/core/accounts");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toBeInstanceOf(Headers);
      const headers = init?.headers as Headers;
      expect(headers.get("Stripe-Version")).toBe("2026-02-25.clover");
      expect(headers.get("Idempotency-Key")).toBe("account-key");
      expect(String(init?.body)).toContain("stripe_transfers");
      expect(String(init?.body)).toContain("payouts");

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
        idempotencyKey: "account-key",
      }),
    ).resolves.toMatchObject({
      providerReference: "acct_123",
      transferCapabilityStatus: "active",
      payoutCapabilityStatus: "active",
      payoutDestinationStatus: "ready",
    });
  });

  it("Stripe webhook parser maps payout failures to provider-neutral events", async () => {
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
      providerPayoutReference: "po_123",
      providerStatus: "failed",
      failureCode: "account_closed",
      failureMessage: "The account is closed.",
      occurredAt: "2026-04-12T13:20:00.000Z",
    });
  });
});
