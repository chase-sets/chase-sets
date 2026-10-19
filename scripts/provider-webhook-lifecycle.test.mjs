import { describe, expect, it } from "vitest";
import {
  assertStripeTestKey,
  createProviderWebhooks,
  deleteProviderWebhooks,
  proveStripePaymentWebhookContract,
} from "./provider-webhook-lifecycle.mjs";
import { STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS } from "./stripe-webhook-events.mjs";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function enabledEvents(call) {
  return new URLSearchParams(call.init.body).getAll("enabled_events[]");
}

function expectNoV2EventsSentToV1Endpoints(calls) {
  for (const call of calls.filter((entry) => entry.url.endsWith("/v1/webhook_endpoints"))) {
    expect(enabledEvents(call).filter((event) => event.startsWith("v2."))).toEqual([]);
  }
}

async function createWithRecordedCalls(overrides) {
  const calls = [];
  const bodies = [
    { id: "we_payment", secret: "whsec_payment" },
    { id: "we_connect", secret: "whsec_connect" },
    { id: "hook_easypost" },
  ];
  await createProviderWebhooks(
    { ...input, ...overrides },
    {
      randomBytes: () => Buffer.from("easy-secret"),
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response(bodies.shift());
      },
    },
  );
  return calls;
}

const input = {
  namespace: "chase-sets-verify-123-1",
  baseUrl: "https://verify-123-1-marketplace.preview.chasesets.com",
  stripeApiKey: "sk_test_fixture",
  easyPostApiKey: "EZTKfixture",
};

describe("provider webhook lifecycle", () => {
  it("retains row 8 unrestricted test-key admission and bounded restricted-key refusal", () => {
    expect(() => assertStripeTestKey({ stripeApiKey: "sk_test_fixture" })).not.toThrow();
    expect(() => assertStripeTestKey({ stripeApiKey: "rk_test_fixture" })).toThrow("Stripe test-mode key");
    expect(() => assertStripeTestKey({ stripeApiKey: "sk_testfixture" })).toThrow("Stripe test-mode key");
  });

  it("refuses live provider credentials", async () => {
    await expect(createProviderWebhooks({ ...input, stripeApiKey: "sk_live_fixture" })).rejects.toThrow(
      "Stripe test-mode key",
    );
    await expect(deleteProviderWebhooks({ ...input, easyPostApiKey: "EZAKfixture" })).rejects.toThrow(
      "EasyPost test-mode key",
    );
  });

  it("creates isolated Stripe account, Stripe Connect, and EasyPost endpoints", async () => {
    const calls = [];
    const bodies = [
      { id: "we_payment", secret: "whsec_payment" },
      { id: "we_connect", secret: "whsec_connect" },
      { id: "hook_easypost" },
    ];
    const result = await createProviderWebhooks(input, {
      randomBytes: () => Buffer.from("easy-secret"),
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response(bodies.shift());
      },
    });

    expect(result.endpoints).toEqual([
      { provider: "stripe", id: "we_payment" },
      { provider: "stripe", id: "we_connect" },
      { provider: "easypost", id: "hook_easypost" },
    ]);
    expect(result.ok).toBe(true);
    expect(new URLSearchParams(calls[0].init.body).get("url")).toContain("/api/payments/provider/webhooks");
    expect(new URLSearchParams(calls[0].init.body).getAll("enabled_events[]")).toEqual(
      STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS,
    );
    expect(new URLSearchParams(calls[1].init.body).get("connect")).toBe("true");
    expect(JSON.parse(calls[2].init.body).webhook).toMatchObject({
      url: expect.stringContaining("/api/fulfillment/provider/postage/webhooks"),
      webhook_secret: Buffer.from("easy-secret").toString("hex"),
    });
  });

  it("proves Stripe test-mode create and update acceptance, then deletes the proof endpoint", async () => {
    const calls = [];
    const fetch = async (url, init = {}) => {
      calls.push({ url, init });
      if (init.method === "DELETE") return response({ id: "we_proof", deleted: true });
      return response({
        id: "we_proof",
        livemode: false,
        enabled_events: [...STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS],
      });
    };

    const result = await proveStripePaymentWebhookContract(
      { namespace: "run-123", stripeApiKey: "sk_test_fixture" },
      { fetch },
    );

    expect(result).toEqual({
      ok: true,
      schemaVersion: "provider-webhook-lifecycle/v1",
      mode: "test",
      eventCount: 21,
      create: { id: "we_proof", accepted: true },
      update: { id: "we_proof", accepted: true },
      delete: { id: "we_proof", deleted: true },
    });
    expect(calls.map((call) => call.init.method)).toEqual(["POST", "POST", "DELETE"]);
    expect(new URLSearchParams(calls[0].init.body).getAll("enabled_events[]")).toEqual(
      STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS,
    );
    expect(new URLSearchParams(calls[1].init.body).getAll("enabled_events[]")).toEqual(
      STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS,
    );
  });

  it("deletes a test-mode proof endpoint when Stripe rejects its update response", async () => {
    const methods = [];
    await expect(
      proveStripePaymentWebhookContract(
        { namespace: "run-123", stripeApiKey: "sk_test_fixture" },
        {
          fetch: async (_url, init = {}) => {
            methods.push(init.method);
            if (init.method === "DELETE") return response({ id: "we_proof", deleted: true });
            if (methods.length === 1) {
              return response({
                id: "we_proof",
                livemode: false,
                enabled_events: [...STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS],
              });
            }
            return response({ id: "we_proof", livemode: false, enabled_events: ["payment_intent.succeeded"] });
          },
        },
      ),
    ).rejects.toThrow("update response did not echo");
    expect(methods).toEqual(["POST", "POST", "DELETE"]);
  });

  it("deletes only endpoints whose exact URL belongs to the verification host", async () => {
    const deleted = [];
    const fetch = async (url, init = {}) => {
      if ((init.method ?? "GET") === "DELETE") {
        deleted.push(url);
        return response({ deleted: true });
      }
      if (url.includes("stripe.com")) {
        return response({
          data: [
            { id: "we_owned", url: `${input.baseUrl}/api/payments/provider/webhooks` },
            { id: "we_shared", url: "https://marketplace.staging.chasesets.com/api/payments/provider/webhooks" },
          ],
        });
      }
      return response({
        webhooks: [
          { id: "hook_owned", url: `${input.baseUrl}/api/fulfillment/provider/postage/webhooks` },
          { id: "hook_other", url: "https://example.test/hook" },
        ],
      });
    };

    const result = await deleteProviderWebhooks(input, { fetch });
    expect(result.deleted).toEqual([
      { provider: "stripe", id: "we_owned" },
      { provider: "easypost", id: "hook_owned" },
    ]);
    expect(deleted).toHaveLength(2);
  });

  it("rolls back endpoints already created when a later registration fails", async () => {
    const methods = [];
    let call = 0;
    await expect(
      createProviderWebhooks(input, {
        fetch: async (_url, init) => {
          methods.push(init.method);
          call += 1;
          if (call === 1) return response({ id: "we_partial", secret: "whsec_partial" });
          if (call === 2) return response({ error: "nope" }, 500);
          return response({ deleted: true });
        },
      }),
    ).rejects.toThrow("returned 500");
    expect(methods).toEqual(["POST", "POST", "DELETE"]);
  });

  it("sends the v2-mode Connect endpoint only money-movement events", async () => {
    const calls = await createWithRecordedCalls({ stripeConnectAccountsApi: "v2" });

    expect(new URLSearchParams(calls[1].init.body).get("connect")).toBe("true");
    expect(enabledEvents(calls[1])).toEqual(["payout.paid", "payout.failed"]);
    expect(enabledEvents(calls[0])).toEqual(STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS);
    expectNoV2EventsSentToV1Endpoints(calls);
  });

  it("defaults to the v2 posture when no Connect Accounts API is selected", async () => {
    const calls = await createWithRecordedCalls({});

    expect(enabledEvents(calls[1])).toEqual(["payout.paid", "payout.failed"]);
    expectNoV2EventsSentToV1Endpoints(calls);
  });

  it("sends the v1-mode Connect endpoint account readiness followed by money-movement events", async () => {
    const calls = await createWithRecordedCalls({ stripeConnectAccountsApi: "v1" });

    expect(enabledEvents(calls[1])).toEqual(["account.updated", "payout.paid", "payout.failed"]);
    expect(enabledEvents(calls[0])).toEqual(STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS);
    expectNoV2EventsSentToV1Endpoints(calls);
  });

  it("fails the v2-name guard assertion when a v1 endpoint request carries a v2 event", () => {
    const body = new URLSearchParams({ connect: "true" });
    body.append("enabled_events[]", "v2.core.account[requirements].updated");
    body.append("enabled_events[]", "payout.paid");

    expect(() =>
      expectNoV2EventsSentToV1Endpoints([{ url: "https://api.stripe.com/v1/webhook_endpoints", init: { body } }]),
    ).toThrow();
  });

  it("refuses an unknown Connect Accounts API posture before any provider call", async () => {
    const calls = [];
    await expect(
      createProviderWebhooks(
        { ...input, stripeConnectAccountsApi: "v3" },
        {
          fetch: async (url, init) => {
            calls.push({ url, init });
            return response({ id: "we_unexpected", secret: "whsec_unexpected" });
          },
        },
      ),
    ).rejects.toThrow("STRIPE_CONNECT_ACCOUNTS_API must be one of: v1, v2.");
    expect(calls).toEqual([]);
  });

  it("names the rejected Connect endpoint and its status, and deletes the payment endpoint", async () => {
    const calls = [];
    const failure = await createProviderWebhooks(
      { ...input, stripeConnectAccountsApi: "v2" },
      {
        randomBytes: () => Buffer.from("easy-secret"),
        fetch: async (url, init) => {
          calls.push({ url, method: init.method });
          if (init.method === "DELETE") return response({ id: "we_payment", deleted: true });
          if (calls.length === 1) return response({ id: "we_payment", secret: "whsec_payment" });
          return response({ error: { message: "Invalid enabled_events[0]: must be one of account.updated" } }, 400);
        },
      },
    ).catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/^Provider webhook create failed for the connect endpoint: /u);
    expect(failure.message).toContain("returned 400");
    for (const secret of [
      "sk_test_fixture",
      "EZTKfixture",
      "whsec_payment",
      Buffer.from("easy-secret").toString("hex"),
    ]) {
      expect(failure.message).not.toContain(secret);
    }
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "DELETE"]);
    expect(calls[2].url).toBe("https://api.stripe.com/v1/webhook_endpoints/we_payment");
  });

  it("names the payment and EasyPost endpoints when their create is rejected", async () => {
    const paymentFailure = await createProviderWebhooks(input, {
      fetch: async () => response({ error: "nope" }, 400),
    }).catch((error) => error);
    expect(paymentFailure.message).toMatch(/^Provider webhook create failed for the payment endpoint: .*returned 400/u);

    let call = 0;
    const easyPostFailure = await createProviderWebhooks(input, {
      randomBytes: () => Buffer.from("easy-secret"),
      fetch: async (_url, init) => {
        call += 1;
        if (init.method === "DELETE") return response({ deleted: true });
        if (call <= 2) return response({ id: `we_${call}`, secret: `whsec_${call}` });
        return response({ error: "nope" }, 422);
      },
    }).catch((error) => error);
    expect(easyPostFailure.message).toMatch(
      /^Provider webhook create failed for the easypost endpoint: .*returned 422/u,
    );
  });

  it("redacts known secret values that a provider error body echoes", async () => {
    const easyPostSecret = Buffer.from("easy-secret").toString("hex");
    let call = 0;
    const failure = await createProviderWebhooks(input, {
      randomBytes: () => Buffer.from("easy-secret"),
      fetch: async (_url, init) => {
        call += 1;
        if (init.method === "DELETE") return response({ deleted: true });
        if (call <= 2) return response({ id: `we_${call}`, secret: `whsec_${call}` });
        return response({ error: `webhook_secret ${easyPostSecret} rejected for sk_test_fixture` }, 422);
      },
    }).catch((error) => error);

    expect(failure.message).toContain("[masked]");
    expect(failure.message).not.toContain(easyPostSecret);
    expect(failure.message).not.toContain("sk_test_fixture");
  });
});
