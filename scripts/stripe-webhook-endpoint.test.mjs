import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  CREATE_PRODUCTION_STRIPE_PAYMENTS_WEBHOOK_CONFIRMATION,
  INTERNAL_ONLY_PAYMENT_EVENTS,
  STRIPE_DELIVERED_EVENTS,
  STRIPE_PAYMENTS_REQUIRED_WEBHOOK_EVENTS,
  createCanonicalStripePaymentsWebhookEndpoint,
  parseStripePaymentsWebhookEndpointArgs,
  repointStagingStripePaymentsWebhookEndpoint,
  runStripePaymentsWebhookEndpointCommand,
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
    enabled_events: [...STRIPE_PAYMENTS_REQUIRED_WEBHOOK_EVENTS],
    ...overrides,
  };
}

describe("Stripe shared Payments webhook endpoint", () => {
  it("verifies the canonical staging endpoint with the complete required event set", async () => {
    const result = await verifyStripePaymentsWebhookEndpoint(
      { environment: "staging", stripeApiKey: "sk_test_fixture" },
      { fetch: async () => response({ data: [endpoint()], has_more: false }) },
    );

    expect(result.ok).toBe(true);
    expect(result.endpoints[0]).toMatchObject({
      url: canonicalStagingUrl,
      missingRequiredEvents: [],
    });
  });

  it("fails verification when the canonical endpoint is missing required events", async () => {
    const result = await verifyStripePaymentsWebhookEndpoint(
      { environment: "staging", stripeApiKey: "sk_test_fixture" },
      {
        fetch: async () =>
          response({
            data: [endpoint({ enabled_events: ["payment_intent.succeeded"] })],
            has_more: false,
          }),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining("missing required events: checkout.session.completed")]);
    expect(result.endpoints[0].missingRequiredEvents).toContain("charge.refunded");
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
    await expect(verifyStripePaymentsWebhookEndpoint({ environment: "production" })).rejects.toThrow(
      "Expected a Stripe live-mode secret key; received unknown.",
    );
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

  it("omits API credentials and webhook signing secrets from verification output", async () => {
    const result = await verifyStripePaymentsWebhookEndpoint(
      { environment: "production", stripeApiKey: "sk_live_sensitive_fixture" },
      {
        fetch: async () =>
          response({
            data: [
              endpoint({
                id: "we_production",
                url: "https://marketplace.chasesets.com/api/payments/provider/webhooks",
                livemode: true,
                secret: "whsec_sensitive_fixture",
              }),
            ],
            has_more: false,
          }),
      },
    );

    const output = JSON.stringify(result);
    expect(output).not.toContain("sk_live_sensitive_fixture");
    expect(output).not.toContain("whsec_sensitive_fixture");
  });

  it("redacts Stripe credentials and signing secrets from non-2xx error details", async () => {
    let thrown;
    try {
      await verifyStripePaymentsWebhookEndpoint(
        { environment: "production", stripeApiKey: "sk_live_sensitive_fixture" },
        {
          fetch: async () =>
            response(
              {
                error: "key sk_live_leaked_fixture secret whsec_leaked_fixture",
              },
              500,
            ),
        },
      );
    } catch (error) {
      thrown = error;
    }

    const output = thrown instanceof Error ? thrown.message : String(thrown);
    expect(output).toContain("[redacted-stripe-api-key]");
    expect(output).toContain("[redacted-webhook-signing-secret]");
    expect(output).not.toContain("sk_live_leaked_fixture");
    expect(output).not.toContain("whsec_leaked_fixture");
    expect(output).not.toContain("sk_live_sensitive_fixture");
  });
});

describe("create-canonical Stripe Payments webhook endpoint", () => {
  const productionUrl = "https://marketplace.chasesets.com/api/payments/provider/webhooks";
  const productionInput = {
    environment: "production",
    confirmation: CREATE_PRODUCTION_STRIPE_PAYMENTS_WEBHOOK_CONFIRMATION,
    stripeApiKey: "sk_live_fixture",
  };

  it("pins the created event set to the Stripe-delivered adapter events", () => {
    expect(STRIPE_DELIVERED_EVENTS).toEqual([
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.expired",
      "payment_intent.canceled",
      "payment_intent.processing",
      "payment_intent.amount_capturable_updated",
      "payment_intent.succeeded",
      "setup_intent.succeeded",
      "setup_intent.setup_failed",
      "payment_method.detached",
      "payment_intent.payment_failed",
      "charge.refunded",
      "refund.created",
      "refund.updated",
      "charge.dispute.created",
      "charge.dispute.updated",
      "charge.dispute.closed",
      "radar.early_fraud_warning.created",
      "review.opened",
      "review.closed",
    ]);
    expect(STRIPE_PAYMENTS_REQUIRED_WEBHOOK_EVENTS).toBe(STRIPE_DELIVERED_EVENTS);
    expect(INTERNAL_ONLY_PAYMENT_EVENTS).toHaveLength(2);
  });

  it("parses the exact confirmation and fails closed before any Stripe call when it is absent or wrong", async () => {
    expect(
      parseStripePaymentsWebhookEndpointArgs(
        [
          "create-canonical",
          "--environment",
          "production",
          "--confirm",
          CREATE_PRODUCTION_STRIPE_PAYMENTS_WEBHOOK_CONFIRMATION,
        ],
        { STRIPE_SECRET_KEY: "sk_live_fixture" },
      ),
    ).toMatchObject({
      command: "create-canonical",
      input: {
        environment: "production",
        confirmation: CREATE_PRODUCTION_STRIPE_PAYMENTS_WEBHOOK_CONFIRMATION,
      },
    });

    for (const args of [
      ["create-canonical", "--environment", "production"],
      ["create-canonical", "--environment=production", "--confirm", "create production webhook endpoint"],
    ]) {
      let stripeCalls = 0;
      await expect(
        runStripePaymentsWebhookEndpointCommand(
          args,
          { STRIPE_SECRET_KEY: "sk_live_fixture" },
          {
            fetch: async () => {
              stripeCalls += 1;
              return response({ data: [], has_more: false });
            },
            writeSigningSecret: async () => undefined,
          },
        ),
      ).rejects.toThrow(`--confirm "${CREATE_PRODUCTION_STRIPE_PAYMENTS_WEBHOOK_CONFIRMATION}"`);
      expect(stripeCalls).toBe(0);
    }
  });

  it("refuses creation before POST when the workflow secret-writer credential is absent", async () => {
    let stripeCalls = 0;
    await expect(
      runStripePaymentsWebhookEndpointCommand(
        [
          "create-canonical",
          "--environment",
          "production",
          "--confirm",
          CREATE_PRODUCTION_STRIPE_PAYMENTS_WEBHOOK_CONFIRMATION,
        ],
        { STRIPE_SECRET_KEY: "sk_live_fixture" },
        {
          fetch: async () => {
            stripeCalls += 1;
            return response({ data: [], has_more: false });
          },
        },
      ),
    ).rejects.toThrow("GH_TOKEN is required");
    expect(stripeCalls).toBe(1);
  });

  it("creates the canonical endpoint, writes its secret through the write-only sink, and immediately verifies", async () => {
    const calls = [];
    const writtenSecrets = [];
    let created = false;
    const fetch = async (url, init = {}) => {
      calls.push({ url, init });
      if (init.method === "POST") {
        created = true;
        return response({ id: "we_production", secret: "whsec_sensitive_fixture" });
      }
      return response({
        data: created
          ? [
              endpoint({
                id: "we_production",
                url: productionUrl,
                livemode: true,
              }),
            ]
          : [],
        has_more: false,
      });
    };

    const result = await createCanonicalStripePaymentsWebhookEndpoint(productionInput, {
      fetch,
      writeSigningSecret: async (secret, environment) => writtenSecrets.push({ secret, environment }),
    });

    expect(result).toMatchObject({
      changed: true,
      endpointId: "we_production",
      verification: { ok: true, canonicalUrl: productionUrl },
    });
    expect(writtenSecrets).toEqual([{ secret: "whsec_sensitive_fixture", environment: "production" }]);
    expect(calls.map((call) => call.init.method ?? "GET")).toEqual(["GET", "POST", "GET"]);
    const createBody = new URLSearchParams(calls[1].init.body);
    expect(createBody.get("url")).toBe(productionUrl);
    expect(createBody.getAll("enabled_events[]")).toEqual(STRIPE_PAYMENTS_REQUIRED_WEBHOOK_EVENTS);
    expect(JSON.stringify(result)).not.toContain("whsec_sensitive_fixture");
    expect(JSON.stringify(result)).not.toContain("sk_live_fixture");
  });

  it("is idempotent when the canonical endpoint already exists and takes the verify-only path", async () => {
    let secretWrites = 0;
    const fetch = async (_url, init = {}) => {
      expect(init.method).not.toBe("POST");
      return response({
        data: [endpoint({ id: "we_production", url: productionUrl, livemode: true })],
        has_more: false,
      });
    };

    await expect(
      createCanonicalStripePaymentsWebhookEndpoint(productionInput, {
        fetch,
        writeSigningSecret: async () => {
          secretWrites += 1;
        },
      }),
    ).resolves.toMatchObject({ changed: false, verification: { ok: true } });
    expect(secretWrites).toBe(0);
  });

  it("takes the verify-only path without requiring a secret-writer credential", async () => {
    await expect(
      runStripePaymentsWebhookEndpointCommand(
        [
          "create-canonical",
          "--environment",
          "production",
          "--confirm",
          CREATE_PRODUCTION_STRIPE_PAYMENTS_WEBHOOK_CONFIRMATION,
        ],
        { STRIPE_SECRET_KEY: "sk_live_fixture" },
        {
          fetch: async (_url, init = {}) => {
            expect(init.method).not.toBe("POST");
            return response({
              data: [endpoint({ id: "we_production", url: productionUrl, livemode: true })],
              has_more: false,
            });
          },
        },
      ),
    ).resolves.toMatchObject({ changed: false, verification: { ok: true } });
  });

  it("pipes the signing secret only to gh secret set stdin", async () => {
    const signingSecret = "whsec_sensitive_fixture";
    const spawned = [];
    let created = false;
    const result = await runStripePaymentsWebhookEndpointCommand(
      [
        "create-canonical",
        "--environment",
        "production",
        "--confirm",
        CREATE_PRODUCTION_STRIPE_PAYMENTS_WEBHOOK_CONFIRMATION,
      ],
      { GH_TOKEN: "github_token_fixture", STRIPE_SECRET_KEY: "sk_live_fixture" },
      {
        fetch: async (_url, init = {}) => {
          if (init.method === "POST") {
            created = true;
            return response({ id: "we_production", secret: signingSecret });
          }
          return response({
            data: created ? [endpoint({ id: "we_production", url: productionUrl, livemode: true })] : [],
            has_more: false,
          });
        },
        spawn: (command, args, options) => {
          const child = new EventEmitter();
          const stdin = new EventEmitter();
          const stdinWrites = [];
          stdin.end = (value) => {
            stdinWrites.push(value);
            queueMicrotask(() => child.emit("close", 0, null));
          };
          child.stdin = stdin;
          spawned.push({ command, args, options, stdinWrites });
          return child;
        },
      },
    );

    expect(spawned).toEqual([
      {
        command: "gh",
        args: ["secret", "set", "STRIPE_WEBHOOK_SECRET", "--env", "production"],
        options: { stdio: ["pipe", "inherit", "inherit"] },
        stdinWrites: [signingSecret],
      },
    ]);
    expect(JSON.stringify({ result, command: spawned[0].command, args: spawned[0].args })).not.toContain(signingSecret);
  });

  it("rolls back a newly created endpoint when the write-only secret sink fails", async () => {
    const methods = [];
    const fetch = async (_url, init = {}) => {
      methods.push(init.method ?? "GET");
      if (init.method === "POST") {
        return response({ id: "we_production", secret: "whsec_sensitive_fixture" });
      }
      if (init.method === "DELETE") return response({ deleted: true });
      return response({ data: [], has_more: false });
    };

    await expect(
      createCanonicalStripePaymentsWebhookEndpoint(productionInput, {
        fetch,
        writeSigningSecret: async () => {
          throw new Error("secret destination unavailable");
        },
      }),
    ).rejects.toThrow("newly created endpoint was rolled back");
    expect(methods).toEqual(["GET", "POST", "DELETE"]);
  });
});
