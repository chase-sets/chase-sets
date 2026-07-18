import { describe, expect, it } from "vitest";
import {
  repointStagingStripePaymentsWebhookEndpoint,
  verifyStripePaymentsWebhookEndpoint,
} from "./stripe-webhook-endpoint.mjs";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const canonicalStagingUrl = "https://marketplace.staging.chasesets.com/api/payments/provider/webhooks";
const legacyStagingUrl = "https://marketplace-staging.chasesets.com/api/payments/provider/webhooks";

function endpoint(overrides = {}) {
  return {
    id: "we_staging",
    url: canonicalStagingUrl,
    status: "enabled",
    livemode: false,
    enabled_events: ["payment_intent.succeeded"],
    ...overrides,
  };
}

describe("Stripe shared Payments webhook endpoint", () => {
  it("verifies the canonical staging endpoint and reports registry drift", async () => {
    const result = await verifyStripePaymentsWebhookEndpoint(
      { environment: "staging", stripeApiKey: "sk_test_fixture" },
      { fetch: async () => response({ data: [endpoint()], has_more: false }) },
    );

    expect(result.ok).toBe(true);
    expect(result.endpoints[0]).toMatchObject({
      url: canonicalStagingUrl,
      missingRequiredEvents: expect.arrayContaining(["charge.refunded"]),
    });
  });

  it("fails verification while a legacy staging endpoint remains", async () => {
    const result = await verifyStripePaymentsWebhookEndpoint(
      { environment: "staging", stripeApiKey: "sk_test_fixture" },
      { fetch: async () => response({ data: [endpoint({ url: legacyStagingUrl })], has_more: false }) },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "Expected exactly one canonical Payments endpoint; found 0.",
      "Expected no legacy Payments endpoints; found 1.",
    ]);
  });

  it("repoints the one exact legacy endpoint without replacing its configuration", async () => {
    const calls = [];
    let updated = false;
    const fetch = async (url, init = {}) => {
      calls.push({ url, init });
      if (init.method === "POST") {
        updated = true;
        return response(endpoint({ url: canonicalStagingUrl }));
      }
      return response({
        data: [endpoint({ url: updated ? canonicalStagingUrl : legacyStagingUrl })],
        has_more: false,
      });
    };

    const result = await repointStagingStripePaymentsWebhookEndpoint(
      { environment: "staging", stripeApiKey: "sk_test_fixture" },
      { fetch },
    );

    expect(result).toMatchObject({
      changed: true,
      endpointId: "we_staging",
      previousUrl: legacyStagingUrl,
      currentUrl: canonicalStagingUrl,
      verification: { ok: true },
    });
    const update = calls.find((call) => call.init.method === "POST");
    expect(update.url).toContain("/v1/webhook_endpoints/we_staging");
    expect(new URLSearchParams(update.init.body).get("url")).toBe(canonicalStagingUrl);
    expect([...new URLSearchParams(update.init.body).keys()]).toEqual(["url"]);
  });

  it("is idempotent when staging is already canonical", async () => {
    const fetch = async (_url, init = {}) => {
      expect(init.method).not.toBe("POST");
      return response({ data: [endpoint()], has_more: false });
    };
    await expect(
      repointStagingStripePaymentsWebhookEndpoint(
        { environment: "staging", stripeApiKey: "sk_test_fixture" },
        { fetch },
      ),
    ).resolves.toMatchObject({ changed: false, verification: { ok: true } });
  });

  it("rejects an already-canonical endpoint that is disabled", async () => {
    await expect(
      repointStagingStripePaymentsWebhookEndpoint(
        { environment: "staging", stripeApiKey: "sk_test_fixture" },
        { fetch: async () => response({ data: [endpoint({ status: "disabled" })], has_more: false }) },
      ),
    ).rejects.toThrow("canonical staging endpoint failed verification");
  });

  it("refuses ambiguous staging mutations and every production mutation", async () => {
    await expect(
      repointStagingStripePaymentsWebhookEndpoint(
        { environment: "staging", stripeApiKey: "sk_test_fixture" },
        {
          fetch: async () =>
            response({ data: [endpoint(), endpoint({ id: "we_legacy", url: legacyStagingUrl })], has_more: false }),
        },
      ),
    ).rejects.toThrow("Refusing ambiguous staging mutation");
    await expect(
      repointStagingStripePaymentsWebhookEndpoint({
        environment: "production",
        stripeApiKey: "sk_live_fixture",
      }),
    ).rejects.toThrow("Only the staging Payments webhook endpoint");
  });

  it("enforces environment key modes and complete endpoint discovery", async () => {
    await expect(
      verifyStripePaymentsWebhookEndpoint({ environment: "production", stripeApiKey: "sk_test_fixture" }),
    ).rejects.toThrow("Expected a Stripe live-mode secret key");
    await expect(
      verifyStripePaymentsWebhookEndpoint(
        { environment: "staging", stripeApiKey: "sk_test_fixture" },
        { fetch: async () => response({ data: [], has_more: true }) },
      ),
    ).rejects.toThrow("more than 100 webhook endpoints");
  });
});
