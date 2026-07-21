import { describe, expect, it } from "vitest";
import {
  createProviderWebhooks,
  deleteProviderWebhooks,
  proveStripePaymentWebhookContract,
} from "./provider-webhook-lifecycle.mjs";
import { STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS } from "./stripe-webhook-events.mjs";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const input = {
  namespace: "chase-sets-verify-123-1",
  baseUrl: "https://verify-123-1-marketplace.preview.chasesets.com",
  stripeApiKey: "sk_test_fixture",
  easyPostApiKey: "EZTKfixture",
};

describe("provider webhook lifecycle", () => {
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
});
