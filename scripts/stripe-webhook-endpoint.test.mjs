import { EventEmitter } from "node:events";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREATE_PRODUCTION_STRIPE_PAYMENTS_WEBHOOK_CONFIRMATION,
  INTERNAL_ONLY_PAYMENT_EVENTS,
  createCanonicalStripePaymentsWebhookEndpoint,
  parseStripePaymentsWebhookEndpointArgs,
  repointStagingStripePaymentsWebhookEndpoint,
  replaceStripePaymentsWebhookEndpointVersion,
  runStripePaymentsWebhookEndpointCommand,
  verifyStripePaymentsWebhookEndpoint,
} from "./stripe-webhook-endpoint.mjs";
import { STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS } from "./stripe-webhook-events.mjs";
import registry from "../infrastructure/stripe-config/webhook-events.json" with { type: "json" };

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
    api_version: registry.apiVersion,
    enabled_events: [...STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS],
    ...overrides,
  };
}

describe("Stripe shared Payments webhook endpoint", () => {
  it.each([null, undefined, "2026-03-25.dahlia", "2026-09-30.endive"])(
    "rejects API version %s on verification and canonical reuse",
    async (api_version) => {
      const input = { environment: "staging", stripeApiKey: "sk_test_fixture" };
      const fetch = async () => response({ data: [endpoint({ api_version })], has_more: false });
      const result = await verifyStripePaymentsWebhookEndpoint(input, { fetch });
      expect(result.ok).toBe(false);
      expect(result.endpoints[0].apiVersion).toBe(api_version ?? null);
      await expect(createCanonicalStripePaymentsWebhookEndpoint(input, { fetch })).rejects.toThrow(
        "must pin API version",
      );
    },
  );
  it("retains row 4 exact-mode unrestricted-key admission and restricted refusal", async () => {
    const fetch = async () => response({ data: [], has_more: false });
    await expect(
      verifyStripePaymentsWebhookEndpoint({ environment: "staging", stripeApiKey: "sk_test_fixture" }, { fetch }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      verifyStripePaymentsWebhookEndpoint({ environment: "production", stripeApiKey: "sk_live_fixture" }, { fetch }),
    ).resolves.toMatchObject({ ok: false });
    for (const stripeApiKey of ["rk_test_fixture", "rk_live_fixture", "sk_testfixture", "sk_livefixture"]) {
      await expect(
        verifyStripePaymentsWebhookEndpoint({ environment: "staging", stripeApiKey }, { fetch }),
      ).rejects.toThrow("received unknown");
    }
  });

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

describe("Stripe endpoint version replacement", () => {
  it.each(["valid", "wrong key", "expired", "old version", "tampered", "malformed", "malformed signed body"])(
    "authenticates a %s captured endpoint delivery without depending on account defaults",
    async (control) => {
      const h = harness();
      await replaceStripePaymentsWebhookEndpointVersion(h.input, h.dependencies);
      h.oldEvent();
      const directory = await mkdtemp(join(tmpdir(), "stripe-endive-synthetic-"));
      try {
        const file = join(directory, "delivery.json");
        const timestamp = Math.floor(Date.now() / 1000) - (control === "expired" ? 600 : 0);
        let rawBody = JSON.stringify({
          id: "evt_endive",
          api_version: control === "old version" ? "2026-03-25.dahlia" : registry.apiVersion,
          type: "payment_method.detached",
          livemode: false,
          data: { object: { id: "pm_synthetic" } },
        });
        if (control === "malformed signed body") rawBody = "SYNTHETIC_PRIVATE_PAYLOAD";
        const digest = createHmac("sha256", control === "wrong key" ? "whsec_old" : "whsec_new")
          .update(`${timestamp}.${rawBody}`)
          .digest("hex");
        if (control === "tampered") rawBody += " ";
        await writeFile(
          file,
          control === "malformed"
            ? '{"signatureHeader":"SYNTHETIC_PRIVATE_SIGNATURE",broken'
            : JSON.stringify({ rawBody, signatureHeader: `t=${timestamp},v1=${digest}` }),
        );
        const operation = replaceStripePaymentsWebhookEndpointVersion(
          { ...h.complete(), deliveryFile: file },
          h.dependencies,
        );
        if (control === "valid") await expect(operation).resolves.toMatchObject({ verification: { ok: true } });
        else {
          if (control.startsWith("malformed"))
            await expect(operation).rejects.toThrow("Malformed delivery capture; old endpoint retained.");
          else await expect(operation).rejects.toThrow();
          expect(h.endpoints()).toHaveLength(2);
        }
        expect(h.calls.some((call) => call.url.includes("/v1/events/"))).toBe(false);
      } finally {
        await rm(join(directory, "delivery.json"), { force: true });
        await rmdir(directory);
      }
    },
  );
  it("isolates sandbox targets and refuses shared origins and live keys before any request", async () => {
    const urls = [
      "https://marketplace.staging.chasesets.com",
      "https://marketplace.staging.chasesets.com.",
      "https://marketplace.chasesets.com",
      "http://localhost",
      "https://isolated.test/path",
      "https://user:password@isolated.test",
    ];
    for (const baseUrl of urls) {
      await expect(
        verifyStripePaymentsWebhookEndpoint({ environment: "sandbox", baseUrl, stripeApiKey: "sk_test_fixture" }),
      ).rejects.toThrow("isolated HTTPS origin");
    }
    await expect(
      verifyStripePaymentsWebhookEndpoint({
        environment: "sandbox",
        baseUrl: "https://isolated.test",
        stripeApiKey: "sk_live_fixture",
      }),
    ).rejects.toThrow("test-mode");
    const url = "https://isolated.test/api/payments/provider/webhooks";
    await expect(
      verifyStripePaymentsWebhookEndpoint(
        { environment: "sandbox", baseUrl: "https://isolated.test", stripeApiKey: "sk_test_fixture" },
        { fetch: async () => response({ data: [endpoint({ url })], has_more: false }) },
      ),
    ).resolves.toMatchObject({ ok: true, canonicalUrl: url });
  });
  function harness() {
    let endpoints = [endpoint({ id: "we_old", api_version: "2026-03-25.dahlia" })];
    const writes = [];
    const calls = [];
    let failWrite = false;
    let deliveryStatus = 200;
    let eventVersion = registry.apiVersion;
    const input = {
      environment: "staging",
      stripeApiKey: "sk_test_fixture",
      phase: "prepare",
      currentSigningSecret: "whsec_old",
      previousSigningSecrets: "whsec_earlier",
    };
    const dependencies = {
      signingSecretDestinationReady: true,
      writeSigningSecret: async (secret, _environment, name) => {
        if (failWrite) throw new Error("unavailable");
        writes.push({ name, secret });
      },
      fetch: async (url, init = {}) => {
        calls.push({ url, method: init.method ?? "GET" });
        const path = new URL(url).pathname;
        if (url === canonicalStagingUrl) {
          const rawBody = String(init.body);
          const [time, signature] = init.headers["Stripe-Signature"].split(",");
          expect(signature).toBe(
            `v1=${createHmac("sha256", "whsec_new")
              .update(`${time.slice(2)}.${rawBody}`)
              .digest("hex")}`,
          );
          expect(JSON.parse(rawBody).api_version).toBe(registry.apiVersion);
          return response({ received: true }, deliveryStatus);
        }
        if (path.startsWith("/v1/events/"))
          return response({
            id: "evt_endive",
            type: "payment_method.detached",
            api_version: eventVersion,
            livemode: false,
            data: { object: { id: "pm_synthetic" } },
          });
        if (init.method === "DELETE") {
          endpoints = endpoints.filter((item) => !path.endsWith(`/${item.id}`));
          return response({ deleted: true });
        }
        if (init.method === "POST") {
          const body = new URLSearchParams(init.body);
          expect(body.has("api_version")).toBe(path === "/v1/webhook_endpoints");
          if (path === "/v1/webhook_endpoints") {
            endpoints.push(
              endpoint({ id: "we_new", metadata: { replacement_for: body.get("metadata[replacement_for]") } }),
            );
            return response({ ...endpoints.at(-1), secret: "whsec_new" });
          }
          const target = endpoints.find((item) => path.endsWith(`/${item.id}`));
          target.metadata.signing_handoff = body.get("metadata[signing_handoff]");
          target.metadata.signing_key_digest = body.get("metadata[signing_key_digest]");
          return response(target);
        }
        return response({ data: endpoints, has_more: false });
      },
    };
    return {
      input,
      dependencies,
      calls,
      writes,
      endpoints: () => endpoints,
      failWrite: () => {
        failWrite = true;
      },
      failDelivery: () => {
        deliveryStatus = 400;
      },
      oldEvent: () => {
        eventVersion = "2026-03-25.dahlia";
      },
      complete: () => ({
        ...input,
        phase: "complete",
        currentSigningSecret: "whsec_new",
        previousSigningSecrets: "whsec_old,whsec_earlier",
        deliveryEventId: "evt_endive",
      }),
    };
  }

  it("hands off keys in order, resumes without multiplication, proves signed replay then retires only old", async () => {
    const h = harness();
    const prepared = await replaceStripePaymentsWebhookEndpointVersion(h.input, h.dependencies);
    expect(prepared).toMatchObject({ pendingDelivery: true, endpointId: "we_new" });
    expect(h.writes).toEqual([
      { name: "STRIPE_WEBHOOK_SECRET_PREVIOUS", secret: "whsec_old,whsec_earlier" },
      { name: "STRIPE_WEBHOOK_SECRET", secret: "whsec_new" },
    ]);
    expect(h.endpoints().map((item) => item.id)).toEqual(["we_old", "we_new"]);
    await expect(replaceStripePaymentsWebhookEndpointVersion(h.input, h.dependencies)).resolves.toMatchObject({
      changed: false,
      pendingDelivery: true,
    });
    expect(h.writes).toHaveLength(2);
    const result = await replaceStripePaymentsWebhookEndpointVersion(h.complete(), h.dependencies);
    expect(result.verification.ok).toBe(true);
    expect(h.calls.findIndex((call) => call.url === canonicalStagingUrl)).toBeLessThan(
      h.calls.findIndex((call) => call.method === "DELETE"),
    );
    expect(h.endpoints().map((item) => item.id)).toEqual(["we_new"]);
    await expect(replaceStripePaymentsWebhookEndpointVersion(h.complete(), h.dependencies)).resolves.toMatchObject({
      changed: false,
      verification: { ok: true },
    });
    expect(JSON.stringify({ prepared, result })).not.toMatch(/whsec_|sk_test_/);
  });

  it("rolls back only new on secret-write failure", async () => {
    const h = harness();
    h.failWrite();
    await expect(replaceStripePaymentsWebhookEndpointVersion(h.input, h.dependencies)).rejects.toThrow(
      "old endpoint is retained",
    );
    expect(h.endpoints().map((item) => item.id)).toEqual(["we_old"]);
  });

  it.each(["failed delivery", "old event", "old key"])("retains old endpoint after %s", async (failure) => {
    const h = harness();
    await replaceStripePaymentsWebhookEndpointVersion(h.input, h.dependencies);
    const complete = h.complete();
    if (failure === "failed delivery") h.failDelivery();
    if (failure === "old event") h.oldEvent();
    if (failure === "old key") complete.currentSigningSecret = "whsec_old";
    await expect(replaceStripePaymentsWebhookEndpointVersion(complete, h.dependencies)).rejects.toThrow();
    expect(h.calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(h.endpoints()).toHaveLength(2);
  });

  it("replaces an unprepared interrupted create rather than multiplying endpoints", async () => {
    const h = harness();
    h.endpoints().push(endpoint({ id: "we_interrupted", metadata: { replacement_for: "we_old" } }));
    await replaceStripePaymentsWebhookEndpointVersion(h.input, h.dependencies);
    expect(h.endpoints().map((item) => item.id)).toEqual(["we_old", "we_new"]);
    expect(h.endpoints()[1].metadata.signing_key_digest).toBe(createHash("sha256").update("whsec_new").digest("hex"));
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
    expect(STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS).toEqual([
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
    expect(createBody.get("api_version")).toBe("2026-10-28.endive");
    expect(createBody.get("url")).toBe(productionUrl);
    expect(createBody.getAll("enabled_events[]")).toEqual(STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS);
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
        args: ["secret", "set", "STRIPE_WEBHOOK_SECRET", "--env", "production", "--repo", "chase-sets/chase-sets"],
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
