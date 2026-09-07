#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import webhookEventRegistry from "../infrastructure/stripe-config/webhook-events.json" with { type: "json" };
import { PAYMENTS_PROVIDER_WEBHOOK_PATH } from "./provider-webhook-paths.mjs";
import { classifyStripeKeys } from "./stripe-key-mode.mjs";
import { STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS, appendStripeEnabledEvents } from "./stripe-webhook-events.mjs";

export const STRIPE_WEBHOOK_ENDPOINT_PROBE_VERSION = "stripe-webhook-endpoint/v1";
export const CREATE_PRODUCTION_STRIPE_PAYMENTS_WEBHOOK_CONFIRMATION = "create production payments webhook endpoint";
export const INTERNAL_ONLY_PAYMENT_EVENTS = Object.freeze([
  // Chase Sets routes this granted-token usage fact internally; Stripe never delivers it to this Dashboard endpoint.
  "shared_payment.granted_token.used",
  // Chase Sets routes this granted-token lifecycle fact internally; Stripe never delivers it to this Dashboard endpoint.
  "shared_payment.granted_token.deactivated",
]);

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

export function assertKeyMode(apiKey, expectedMode) {
  const classification = classifyStripeKeys(apiKey, null);
  const actualMode = classification.serverKeyClass === "standard" ? classification.serverKeyMode : "unknown";
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
    const supportSafeDetail = text
      .slice(0, 300)
      .replace(/\bsk_(?:live|test)_[A-Za-z0-9_-]+/gu, "[redacted-stripe-api-key]")
      .replace(/\bwhsec_[A-Za-z0-9_-]+/gu, "[redacted-webhook-signing-secret]");
    throw new Error(
      `${init.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}: ${supportSafeDetail}`,
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
    missingRequiredEvents: STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS.filter((event) => !enabledEvents.includes(event)),
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
  const missingRequiredEvents = canonical.flatMap((endpoint) => summarizeEndpoint(endpoint).missingRequiredEvents);
  if (missingRequiredEvents.length > 0) {
    errors.push(`The canonical Payments endpoint is missing required events: ${missingRequiredEvents.join(", ")}.`);
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

function assertCreateConfirmation(input) {
  if (
    input.environment === "production" &&
    input.confirmation !== CREATE_PRODUCTION_STRIPE_PAYMENTS_WEBHOOK_CONFIRMATION
  ) {
    throw new Error(
      `Production creation requires --confirm "${CREATE_PRODUCTION_STRIPE_PAYMENTS_WEBHOOK_CONFIRMATION}".`,
    );
  }
}

function createWebhookEndpointBody(environment, canonicalUrl) {
  const body = new URLSearchParams({
    url: canonicalUrl,
    api_version: webhookEventRegistry.apiVersion,
    description: `Chase Sets ${environment} Payments webhook endpoint`,
  });
  appendStripeEnabledEvents(body, STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS);
  return body;
}

async function deleteWebhookEndpoint(input, endpointId, fetchImpl) {
  await requestJson(
    `${input.stripeApiBase ?? "https://api.stripe.com"}/v1/webhook_endpoints/${endpointId}`,
    { method: "DELETE", headers: stripeHeaders(input.stripeApiKey) },
    fetchImpl,
  );
}

export async function createCanonicalStripePaymentsWebhookEndpoint(input, dependencies = {}) {
  const config = assertEnvironment(input.environment);
  assertCreateConfirmation(input);
  assertKeyMode(input.stripeApiKey, config.keyMode);
  const fetchImpl = dependencies.fetch ?? fetch;
  const endpoints = await listWebhookEndpoints(input, fetchImpl);
  const canonicalUrl = endpointUrl(config.canonicalBaseUrl);
  const canonical = endpoints.filter((endpoint) => endpoint.url === canonicalUrl);

  if (canonical.length > 0) {
    return {
      changed: false,
      verification: evaluateEndpoints(input.environment, config, endpoints),
    };
  }
  if (dependencies.signingSecretDestinationReady === false) {
    throw new Error("GH_TOKEN is required to write the environment webhook signing secret.");
  }

  const created = await requestJson(
    `${input.stripeApiBase ?? "https://api.stripe.com"}/v1/webhook_endpoints`,
    {
      method: "POST",
      headers: stripeHeaders(input.stripeApiKey),
      body: createWebhookEndpointBody(input.environment, canonicalUrl),
    },
    fetchImpl,
  );
  if (!created.id) {
    throw new Error("Stripe created a webhook endpoint without returning its id and signing secret.");
  }
  if (!created.secret) {
    await deleteWebhookEndpoint(input, created.id, fetchImpl);
    throw new Error(
      "Stripe created a webhook endpoint without returning its signing secret; the endpoint was rolled back.",
    );
  }

  try {
    const writeSigningSecret = dependencies.writeSigningSecret;
    if (!writeSigningSecret) {
      throw new Error("A write-only signing secret destination is required for endpoint creation.");
    }
    await writeSigningSecret(created.secret, input.environment);
  } catch (error) {
    try {
      await deleteWebhookEndpoint(input, created.id, fetchImpl);
    } catch (rollbackError) {
      throw new Error(
        `Writing the webhook signing secret failed and endpoint rollback also failed: ${
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        }`,
        { cause: error },
      );
    }
    throw new Error("Writing the webhook signing secret failed; the newly created endpoint was rolled back.", {
      cause: error,
    });
  }

  const updatedEndpoints = await listWebhookEndpoints(input, fetchImpl);
  return {
    changed: true,
    endpointId: created.id,
    verification: evaluateEndpoints(input.environment, config, updatedEndpoints),
  };
}

function option(argv, name, fallback) {
  const inline = argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export function parseStripePaymentsWebhookEndpointArgs(argv, env = process.env) {
  const command = argv[0];
  const environment = option(argv, "--environment");
  return {
    command,
    input: {
      environment,
      confirmation: option(argv, "--confirm"),
      stripeApiKey: env.STRIPE_SECRET_KEY,
      stripeApiBase: env.STRIPE_API_BASE_URL || undefined,
    },
  };
}

function writeGithubEnvironmentSecret(signingSecret, environment, dependencies = {}) {
  const spawnImpl = dependencies.spawn ?? spawn;
  return new Promise((resolve, reject) => {
    const child = spawnImpl("gh", ["secret", "set", "STRIPE_WEBHOOK_SECRET", "--env", environment], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal || code !== 0) {
        reject(new Error("gh secret set STRIPE_WEBHOOK_SECRET failed."));
        return;
      }
      resolve();
    });
    child.stdin.on("error", reject);
    child.stdin.end(signingSecret);
  });
}

export async function runStripePaymentsWebhookEndpointCommand(argv, env = process.env, dependencies = {}) {
  const { command, input } = parseStripePaymentsWebhookEndpointArgs(argv, env);
  if (command === "verify") {
    return verifyStripePaymentsWebhookEndpoint(input, dependencies);
  }
  if (command === "repoint-staging") {
    return repointStagingStripePaymentsWebhookEndpoint(input, dependencies);
  }
  if (command === "create-canonical") {
    return createCanonicalStripePaymentsWebhookEndpoint(input, {
      ...dependencies,
      signingSecretDestinationReady:
        dependencies.signingSecretDestinationReady ?? Boolean(dependencies.writeSigningSecret || env.GH_TOKEN),
      writeSigningSecret:
        dependencies.writeSigningSecret ??
        ((signingSecret, environment) => writeGithubEnvironmentSecret(signingSecret, environment, dependencies)),
    });
  }
  throw new Error(
    "Usage: stripe-webhook-endpoint.mjs <verify|repoint-staging|create-canonical> --environment <staging|production> [--confirm <text>]",
  );
}

async function main(argv) {
  const result = await runStripePaymentsWebhookEndpointCommand(argv);
  console.log(JSON.stringify(result, null, 2));
  const verification = "verification" in result ? result.verification : result;
  if (!verification.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
