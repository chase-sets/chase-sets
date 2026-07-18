#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import webhookEventRegistry from "../infrastructure/stripe-config/webhook-events.json" with { type: "json" };
import { PAYMENTS_PROVIDER_WEBHOOK_PATH } from "./provider-webhook-paths.mjs";

export const STRIPE_WEBHOOK_ENDPOINT_PROBE_VERSION = "stripe-webhook-endpoint/v1";

export const STRIPE_PAYMENTS_WEBHOOK_ENVIRONMENTS = Object.freeze({
  staging: Object.freeze({
    keyMode: "test",
    canonicalBaseUrl: "https://marketplace.staging.chasesets.com",
    legacyBaseUrls: Object.freeze(["https://marketplace-staging.chasesets.com"]),
  }),
  production: Object.freeze({
    keyMode: "live",
    canonicalBaseUrl: "https://marketplace.chasesets.com",
    legacyBaseUrls: Object.freeze([]),
  }),
});

function endpointUrl(baseUrl) {
  return `${baseUrl}${PAYMENTS_PROVIDER_WEBHOOK_PATH}`;
}

function assertEnvironment(environment) {
  const config = STRIPE_PAYMENTS_WEBHOOK_ENVIRONMENTS[environment];
  if (!config) {
    throw new Error("--environment must be staging or production.");
  }
  return config;
}

function assertKeyMode(apiKey, expectedMode) {
  const actualMode = String(apiKey ?? "").startsWith("sk_test_")
    ? "test"
    : String(apiKey ?? "").startsWith("sk_live_")
      ? "live"
      : "unknown";
  if (actualMode !== expectedMode) {
    throw new Error(`Expected a Stripe ${expectedMode}-mode secret key; received ${actualMode}.`);
  }
  return actualMode;
}

function stripeHeaders(apiKey) {
  return {
    Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

async function requestJson(url, init, fetchImpl) {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  return text ? JSON.parse(text) : {};
}

async function listWebhookEndpoints(input, fetchImpl) {
  const result = await requestJson(
    `${input.stripeApiBase ?? "https://api.stripe.com"}/v1/webhook_endpoints?limit=100`,
    { headers: stripeHeaders(input.stripeApiKey) },
    fetchImpl,
  );
  if (result.has_more) {
    throw new Error("Stripe returned more than 100 webhook endpoints; refusing an incomplete endpoint decision.");
  }
  return result.data ?? [];
}

function summarizeEndpoint(endpoint) {
  const enabledEvents = Array.isArray(endpoint.enabled_events) ? endpoint.enabled_events : [];
  return {
    id: endpoint.id,
    url: endpoint.url,
    status: endpoint.status,
    livemode: endpoint.livemode,
    enabledEventCount: enabledEvents.length,
    missingRequiredEvents: webhookEventRegistry.payment.filter((event) => !enabledEvents.includes(event)),
  };
}

function evaluateEndpoints(environment, config, endpoints) {
  const canonicalUrl = endpointUrl(config.canonicalBaseUrl);
  const legacyUrls = config.legacyBaseUrls.map(endpointUrl);
  const relevantUrls = new Set([canonicalUrl, ...legacyUrls]);
  const relevant = endpoints.filter((endpoint) => relevantUrls.has(endpoint.url));
  const canonical = relevant.filter((endpoint) => endpoint.url === canonicalUrl);
  const legacy = relevant.filter((endpoint) => legacyUrls.includes(endpoint.url));
  const errors = [];

  if (canonical.length !== 1) {
    errors.push(`Expected exactly one canonical Payments endpoint; found ${canonical.length}.`);
  }
  if (legacy.length !== 0) {
    errors.push(`Expected no legacy Payments endpoints; found ${legacy.length}.`);
  }
  if (canonical.some((endpoint) => endpoint.status !== "enabled")) {
    errors.push("The canonical Payments endpoint is not enabled.");
  }
  const expectedLivemode = config.keyMode === "live";
  if (canonical.some((endpoint) => endpoint.livemode !== expectedLivemode)) {
    errors.push(`The canonical Payments endpoint does not match ${config.keyMode} mode.`);
  }

  return {
    schemaVersion: STRIPE_WEBHOOK_ENDPOINT_PROBE_VERSION,
    environment,
    keyMode: config.keyMode,
    canonicalUrl,
    ok: errors.length === 0,
    errors,
    endpoints: relevant.map(summarizeEndpoint),
  };
}

export async function verifyStripePaymentsWebhookEndpoint(input, dependencies = {}) {
  const config = assertEnvironment(input.environment);
  assertKeyMode(input.stripeApiKey, config.keyMode);
  const fetchImpl = dependencies.fetch ?? fetch;
  const endpoints = await listWebhookEndpoints(input, fetchImpl);
  return evaluateEndpoints(input.environment, config, endpoints);
}

export async function repointStagingStripePaymentsWebhookEndpoint(input, dependencies = {}) {
  if (input.environment !== "staging") {
    throw new Error("Only the staging Payments webhook endpoint can be repointed by this command.");
  }
  const config = assertEnvironment(input.environment);
  assertKeyMode(input.stripeApiKey, config.keyMode);
  const fetchImpl = dependencies.fetch ?? fetch;
  const endpoints = await listWebhookEndpoints(input, fetchImpl);
  const canonicalUrl = endpointUrl(config.canonicalBaseUrl);
  const legacyUrls = config.legacyBaseUrls.map(endpointUrl);
  const canonical = endpoints.filter((endpoint) => endpoint.url === canonicalUrl);
  const legacy = endpoints.filter((endpoint) => legacyUrls.includes(endpoint.url));

  if (canonical.length === 1 && legacy.length === 0) {
    const verification = evaluateEndpoints(input.environment, config, endpoints);
    if (!verification.ok) {
      throw new Error(`The canonical staging endpoint failed verification: ${verification.errors.join(" ")}`);
    }
    return {
      changed: false,
      verification,
    };
  }
  if (canonical.length !== 0 || legacy.length !== 1) {
    throw new Error(
      `Refusing ambiguous staging mutation: found ${canonical.length} canonical and ${legacy.length} legacy Payments endpoints.`,
    );
  }

  const target = legacy[0];
  const body = new URLSearchParams({ url: canonicalUrl });
  await requestJson(
    `${input.stripeApiBase ?? "https://api.stripe.com"}/v1/webhook_endpoints/${target.id}`,
    { method: "POST", headers: stripeHeaders(input.stripeApiKey), body },
    fetchImpl,
  );
  const updatedEndpoints = await listWebhookEndpoints(input, fetchImpl);
  const verification = evaluateEndpoints(input.environment, config, updatedEndpoints);
  if (!verification.ok) {
    throw new Error(`Stripe accepted the endpoint update but verification failed: ${verification.errors.join(" ")}`);
  }
  return {
    changed: true,
    endpointId: target.id,
    previousUrl: target.url,
    currentUrl: canonicalUrl,
    verification,
  };
}

function option(argv, name, fallback) {
  const inline = argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

async function main(argv) {
  const command = argv[0];
  const environment = option(argv, "--environment");
  const input = {
    environment,
    stripeApiKey: process.env.STRIPE_SECRET_KEY,
    stripeApiBase: process.env.STRIPE_API_BASE_URL || undefined,
  };
  if (command === "verify") {
    const result = await verifyStripePaymentsWebhookEndpoint(input);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "repoint-staging") {
    console.log(JSON.stringify(await repointStagingStripePaymentsWebhookEndpoint(input), null, 2));
    return;
  }
  throw new Error("Usage: stripe-webhook-endpoint.mjs <verify|repoint-staging> --environment <staging|production>");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
