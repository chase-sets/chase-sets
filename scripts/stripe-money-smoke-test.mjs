#!/usr/bin/env node
import process from "node:process";

const args = new Set(process.argv.slice(2));

function readEnv(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function authHeaders() {
  const headers = new Headers();
  const authorization = readEnv("PLATFORM_API_AUTHORIZATION");
  const cookie = readEnv("PLATFORM_API_COOKIE");

  if (authorization) {
    headers.set("Authorization", authorization);
  }
  if (cookie) {
    headers.set("Cookie", cookie);
  }

  return headers;
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return { response, body };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function envReport() {
  const required = [
    "PLATFORM_API_BASE_URL",
    "STRIPE_SECRET_KEY",
    "STRIPE_PUBLISHABLE_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_CONNECT_RETURN_URL",
    "STRIPE_CONNECT_REFRESH_URL",
  ];
  const optional = [
    "PLATFORM_API_AUTHORIZATION",
    "PLATFORM_API_COOKIE",
    "SMOKE_PAYOUT_AMOUNT",
  ];
  const missing = required.filter((name) => !readEnv(name));
  const presentOptional = optional.filter((name) => Boolean(readEnv(name)));

  return {
    missing,
    presentOptional,
    testModeKeysLikely:
      readEnv("STRIPE_SECRET_KEY")?.startsWith("sk_test") === true &&
      readEnv("STRIPE_PUBLISHABLE_KEY")?.startsWith("pk_test") === true,
  };
}

async function runEdgeCheck(baseUrl) {
  const health = await requestJson(`${baseUrl}/health`);
  assert(
    health.response.status === 200,
    `Expected /health to return 200, got ${health.response.status}.`,
  );

  const webhook = await requestJson(
    `${baseUrl}/api/settlement/provider/money-movement/webhooks`,
    {
      method: "POST",
      body: "{\"id\":\"evt_smoke\",\"type\":\"payout.failed\",\"data\":{\"object\":{\"id\":\"po_smoke\"}}}",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": "t=1,v1=invalid",
      },
    },
  );
  assert(
    webhook.response.status === 400,
    `Expected unsigned provider webhook probe to be rejected with 400, got ${webhook.response.status}.`,
  );

  return {
    health: "ok",
    unsignedWebhookRejected: true,
  };
}

async function runSellerFlow(baseUrl) {
  const headers = authHeaders();
  assert(
    headers.has("Authorization") || headers.has("Cookie"),
    "Set PLATFORM_API_AUTHORIZATION or PLATFORM_API_COOKIE before running --seller-flow.",
  );

  const readiness = await requestJson(`${baseUrl}/api/settlement/payout-readiness`, {
    headers,
  });
  assert(
    readiness.response.status === 200,
    `Expected payout readiness to return 200, got ${readiness.response.status}.`,
  );

  const onboardingHeaders = new Headers(headers);
  onboardingHeaders.set("Content-Type", "application/json");
  const onboarding = await requestJson(
    `${baseUrl}/api/settlement/payout-setup/onboarding-session`,
    {
      method: "POST",
      headers: onboardingHeaders,
      body: JSON.stringify({
        returnUrl: readEnv("STRIPE_CONNECT_RETURN_URL"),
        refreshUrl: readEnv("STRIPE_CONNECT_REFRESH_URL"),
      }),
    },
  );
  assert(
    onboarding.response.status === 201,
    `Expected onboarding session to return 201, got ${onboarding.response.status}.`,
  );
  assert(
    typeof onboarding.body?.url === "string" &&
      onboarding.body.url.startsWith("https://"),
    "Expected onboarding session to return a hosted setup URL.",
  );

  const refresh = await requestJson(`${baseUrl}/api/settlement/payout-setup/refresh`, {
    method: "POST",
    headers,
  });
  assert(
    refresh.response.status === 200,
    `Expected payout setup refresh to return 200, got ${refresh.response.status}.`,
  );

  const previewHeaders = new Headers(headers);
  previewHeaders.set("Content-Type", "application/json");
  const preview = await requestJson(`${baseUrl}/api/settlement/payouts/preview`, {
    method: "POST",
    headers: previewHeaders,
    body: JSON.stringify({ amount: readEnv("SMOKE_PAYOUT_AMOUNT") ?? "1.00" }),
  });
  assert(
    preview.response.status === 200 || preview.response.status === 400,
    `Expected payout preview to return 200 or validation 400, got ${preview.response.status}.`,
  );

  return {
    readiness: "ok",
    hostedOnboardingCreated: true,
    refresh: "ok",
    payoutPreviewStatus: preview.response.status,
    payoutPreviewCanRequest: preview.body?.can_request ?? null,
  };
}

async function main() {
  const report = envReport();
  const checkOnly = args.has("--check-env") || process.argv.length <= 2;

  if (checkOnly) {
    console.log(JSON.stringify({ ok: report.missing.length === 0, ...report }, null, 2));
    return;
  }

  assert(
    report.missing.length === 0,
    `Missing required environment: ${report.missing.join(", ")}.`,
  );
  assert(
    report.testModeKeysLikely,
    "This smoke test must run with Stripe test-mode keys (sk_test and pk_test).",
  );

  const baseUrl = stripTrailingSlash(readEnv("PLATFORM_API_BASE_URL"));
  const result = {
    edge: args.has("--edge-check") || args.has("--seller-flow")
      ? await runEdgeCheck(baseUrl)
      : "skipped",
    sellerFlow: args.has("--seller-flow")
      ? await runSellerFlow(baseUrl)
      : "skipped",
  };

  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
