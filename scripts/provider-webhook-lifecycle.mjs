#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import webhookEventRegistry from "../infrastructure/stripe-config/webhook-events.json" with { type: "json" };
import {
  FULFILLMENT_POSTAGE_WEBHOOK_PATH,
  PAYMENTS_PROVIDER_WEBHOOK_PATH,
  SETTLEMENT_MONEY_MOVEMENT_WEBHOOK_PATH,
} from "./provider-webhook-paths.mjs";
import { isStripeTestServerKey } from "./stripe-key-mode.mjs";
import { STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS, appendStripeEnabledEvents } from "./stripe-webhook-events.mjs";

export const PROVIDER_WEBHOOK_LIFECYCLE_VERSION = "provider-webhook-lifecycle/v1";

export function assertStripeTestKey(input) {
  if (!isStripeTestServerKey(input.stripeApiKey)) {
    throw new Error("Ephemeral provider webhook lifecycle requires a Stripe test-mode key (sk_test_...).");
  }
}

function assertSandboxKeys(input) {
  assertStripeTestKey(input);
  if (!String(input.easyPostApiKey ?? "").startsWith("EZTK")) {
    throw new Error("Ephemeral provider webhook lifecycle requires an EasyPost test-mode key (EZTK...).");
  }
}

function endpointUrls(baseUrl) {
  const normalized = String(baseUrl ?? "").replace(/\/$/u, "");
  if (!normalized.startsWith("https://")) {
    throw new Error("--base-url must be an https URL.");
  }
  return {
    payment: `${normalized}${PAYMENTS_PROVIDER_WEBHOOK_PATH}`,
    connect: `${normalized}${SETTLEMENT_MONEY_MOVEMENT_WEBHOOK_PATH}`,
    easyPost: `${normalized}${FULFILLMENT_POSTAGE_WEBHOOK_PATH}`,
  };
}

async function requestJson(url, init, fetchImpl = fetch, allowNotFound = false) {
  const response = await fetchImpl(url, init);
  if (allowNotFound && response.status === 404) return {};
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  return text ? JSON.parse(text) : {};
}

function stripeHeaders(apiKey) {
  return {
    Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

function easyPostHeaders(apiKey) {
  return {
    Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    "Content-Type": "application/json",
  };
}

async function createStripeEndpoint(input, fetchImpl) {
  const body = new URLSearchParams({
    url: input.url,
    api_version: webhookEventRegistry.apiVersion,
    description: `Chase Sets ephemeral verification ${input.namespace}`,
    connect: String(input.connect),
    "metadata[verification_namespace]": input.namespace,
  });
  appendStripeEnabledEvents(body, input.events);
  return requestJson(
    `${input.apiBase}/v1/webhook_endpoints`,
    { method: "POST", headers: stripeHeaders(input.apiKey), body },
    fetchImpl,
  );
}

function assertAcceptedPaymentEvents(response, operation) {
  const acceptedEvents = Array.isArray(response.enabled_events) ? response.enabled_events : [];
  const expectedEvents = new Set(STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS);
  const acceptedEventSet = new Set(acceptedEvents);
  if (
    acceptedEvents.length !== expectedEvents.size ||
    acceptedEventSet.size !== expectedEvents.size ||
    acceptedEvents.some((event) => !expectedEvents.has(event))
  ) {
    throw new Error(`Stripe ${operation} response did not echo the ratified Payments event set.`);
  }
  if (response.livemode !== false) {
    throw new Error(`Stripe ${operation} response was not test mode.`);
  }
}

export async function proveStripePaymentWebhookContract(input, dependencies = {}) {
  assertStripeTestKey(input);
  const fetchImpl = dependencies.fetch ?? fetch;
  const apiBase = input.stripeApiBase ?? "https://api.stripe.com";
  const namespace = String(required(input.namespace, "namespace"));
  const created = await createStripeEndpoint(
    {
      apiBase,
      apiKey: input.stripeApiKey,
      namespace,
      url: `https://example.com/chase-sets/stripe-contract-proof/${encodeURIComponent(namespace)}`,
      connect: false,
      events: STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS,
    },
    fetchImpl,
  );
  if (!created.id) {
    throw new Error("Stripe test-mode create response did not include an endpoint id.");
  }

  let deleted = false;
  try {
    assertAcceptedPaymentEvents(created, "create");
    const updateBody = new URLSearchParams({ description: `Chase Sets Stripe contract proof ${namespace} updated` });
    appendStripeEnabledEvents(updateBody, STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS);
    const updated = await requestJson(
      `${apiBase}/v1/webhook_endpoints/${created.id}`,
      { method: "POST", headers: stripeHeaders(input.stripeApiKey), body: updateBody },
      fetchImpl,
    );
    assertAcceptedPaymentEvents(updated, "update");
    if (updated.id !== created.id) {
      throw new Error("Stripe test-mode update response did not match the created endpoint id.");
    }
    const deletion = await deleteEndpoint({ provider: "stripe", id: created.id }, input, fetchImpl);
    deleted = deletion.deleted === true;
    if (!deleted) {
      throw new Error("Stripe test-mode delete response did not confirm endpoint deletion.");
    }
    return {
      ok: true,
      schemaVersion: PROVIDER_WEBHOOK_LIFECYCLE_VERSION,
      mode: "test",
      eventCount: STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS.length,
      create: { id: created.id, accepted: true },
      update: { id: updated.id, accepted: true },
      delete: { id: created.id, deleted: true },
    };
  } finally {
    if (!deleted) {
      await deleteEndpoint({ provider: "stripe", id: created.id }, input, fetchImpl);
    }
  }
}

export async function createProviderWebhooks(input, dependencies = {}) {
  assertSandboxKeys(input);
  const urls = endpointUrls(input.baseUrl);
  const fetchImpl = dependencies.fetch ?? fetch;
  const easyPostSecret = (dependencies.randomBytes ?? randomBytes)(32).toString("hex");
  const created = [];
  try {
    const payment = await createStripeEndpoint(
      {
        apiBase: input.stripeApiBase ?? "https://api.stripe.com",
        apiKey: input.stripeApiKey,
        namespace: input.namespace,
        url: urls.payment,
        connect: false,
        events: STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS,
      },
      fetchImpl,
    );
    created.push({ provider: "stripe", id: payment.id });
    const connect = await createStripeEndpoint(
      {
        apiBase: input.stripeApiBase ?? "https://api.stripe.com",
        apiKey: input.stripeApiKey,
        namespace: input.namespace,
        url: urls.connect,
        connect: true,
        events: [
          ...webhookEventRegistry.connectAccounts[input.stripeConnectAccountsApi ?? "v2"],
          ...webhookEventRegistry.connectMoneyMovement,
        ],
      },
      fetchImpl,
    );
    created.push({ provider: "stripe", id: connect.id });
    const easyPost = await requestJson(
      `${input.easyPostApiBase ?? "https://api.easypost.com/v2"}/webhooks`,
      {
        method: "POST",
        headers: easyPostHeaders(input.easyPostApiKey),
        body: JSON.stringify({ webhook: { url: urls.easyPost, webhook_secret: easyPostSecret } }),
      },
      fetchImpl,
    );
    created.push({ provider: "easypost", id: easyPost.id });
    return {
      ok: true,
      schemaVersion: PROVIDER_WEBHOOK_LIFECYCLE_VERSION,
      namespace: input.namespace,
      baseUrl: input.baseUrl,
      stripeWebhookSecret: payment.secret,
      stripeConnectWebhookSecret: connect.secret,
      easyPostWebhookSecret: easyPostSecret,
      endpoints: created,
    };
  } catch (error) {
    await deleteCreatedEndpoints(created, input, fetchImpl);
    throw error;
  }
}

async function deleteCreatedEndpoints(created, input, fetchImpl) {
  for (const endpoint of [...created].reverse()) {
    try {
      await deleteEndpoint(endpoint, input, fetchImpl);
    } catch {
      // Exact-URL discovery in the guaranteed teardown and stale sweep retries cleanup.
    }
  }
}

async function deleteEndpoint(endpoint, input, fetchImpl) {
  if (endpoint.provider === "stripe") {
    return requestJson(
      `${input.stripeApiBase ?? "https://api.stripe.com"}/v1/webhook_endpoints/${endpoint.id}`,
      {
        method: "DELETE",
        headers: stripeHeaders(input.stripeApiKey),
      },
      fetchImpl,
      true,
    );
  }
  return requestJson(
    `${input.easyPostApiBase ?? "https://api.easypost.com/v2"}/webhooks/${endpoint.id}`,
    {
      method: "DELETE",
      headers: easyPostHeaders(input.easyPostApiKey),
    },
    fetchImpl,
    true,
  );
}

export async function deleteProviderWebhooks(input, dependencies = {}) {
  assertSandboxKeys(input);
  const urls = new Set(Object.values(endpointUrls(input.baseUrl)));
  const fetchImpl = dependencies.fetch ?? fetch;
  const stripe = await requestJson(
    `${input.stripeApiBase ?? "https://api.stripe.com"}/v1/webhook_endpoints?limit=100`,
    {
      headers: stripeHeaders(input.stripeApiKey),
    },
    fetchImpl,
  );
  const easyPost = await requestJson(
    `${input.easyPostApiBase ?? "https://api.easypost.com/v2"}/webhooks`,
    {
      headers: easyPostHeaders(input.easyPostApiKey),
    },
    fetchImpl,
  );
  const targets = [
    ...(stripe.data ?? [])
      .filter((endpoint) => urls.has(endpoint.url))
      .map((endpoint) => ({ provider: "stripe", id: endpoint.id })),
    ...(easyPost.webhooks ?? [])
      .filter((endpoint) => urls.has(endpoint.url))
      .map((endpoint) => ({ provider: "easypost", id: endpoint.id })),
  ];
  const errors = [];
  for (const target of targets) {
    try {
      await deleteEndpoint(target, input, fetchImpl);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
  return { schemaVersion: PROVIDER_WEBHOOK_LIFECYCLE_VERSION, baseUrl: input.baseUrl, deleted: targets };
}

function option(argv, name, fallback) {
  const inline = argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main(argv) {
  const command = argv[0];
  if (command === "prove-payment-events") {
    console.log(
      JSON.stringify(
        await proveStripePaymentWebhookContract({
          namespace: required(option(argv, "--namespace", process.env.GITHUB_RUN_ID), "--namespace"),
          stripeApiKey: required(process.env.STRIPE_SECRET_KEY, "STRIPE_SECRET_KEY"),
          stripeApiBase: process.env.STRIPE_API_BASE_URL || undefined,
        }),
        null,
        2,
      ),
    );
    return;
  }
  const input = {
    namespace: option(argv, "--namespace", process.env.CHASE_SETS_KUBERNETES_NAMESPACE),
    baseUrl: required(option(argv, "--base-url", process.env.PLATFORM_API_BASE_URL), "--base-url"),
    stripeApiKey: required(process.env.STRIPE_SECRET_KEY, "STRIPE_SECRET_KEY"),
    stripeConnectAccountsApi: process.env.STRIPE_CONNECT_ACCOUNTS_API ?? "v2",
    stripeApiBase: process.env.STRIPE_API_BASE_URL || undefined,
    easyPostApiKey: required(process.env.EASYPOST_API_KEY, "EASYPOST_API_KEY"),
    easyPostApiBase: process.env.EASYPOST_API_BASE_URL || undefined,
  };
  if (command === "create") {
    required(input.namespace, "--namespace");
    const result = await createProviderWebhooks(input);
    for (const secret of [
      result.stripeWebhookSecret,
      result.stripeConnectWebhookSecret,
      result.easyPostWebhookSecret,
    ]) {
      console.log(`::add-mask::${secret}`);
    }
    if (process.env.GITHUB_ENV) {
      await appendFile(
        process.env.GITHUB_ENV,
        [
          `STRIPE_WEBHOOK_SECRET=${result.stripeWebhookSecret}`,
          `STRIPE_CONNECT_WEBHOOK_SECRET=${result.stripeConnectWebhookSecret}`,
          `EASYPOST_WEBHOOK_SECRET=${result.easyPostWebhookSecret}`,
        ].join("\n") + "\n",
      );
    }
    console.log(
      JSON.stringify(
        {
          ...result,
          stripeWebhookSecret: "[masked]",
          stripeConnectWebhookSecret: "[masked]",
          easyPostWebhookSecret: "[masked]",
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "delete") {
    console.log(JSON.stringify(await deleteProviderWebhooks(input), null, 2));
    return;
  }
  throw new Error(
    "Usage: provider-webhook-lifecycle.mjs <create|delete|prove-payment-events> --base-url <https-url> [--namespace <name>]",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
