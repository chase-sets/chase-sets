#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import process from "node:process";

function readEnv(name, env = process.env) {
  const value = env[name];
  return value && value.trim() ? value.trim() : null;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function csvEnv(name, env = process.env) {
  return (readEnv(name, env) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function positiveIntegerEnv(name, env = process.env) {
  const value = readEnv(name, env);
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeaders(env = process.env) {
  const headers = new Headers();
  const authorization = readEnv("PLATFORM_API_AUTHORIZATION", env);
  const cookie = readEnv("PLATFORM_API_COOKIE", env);

  if (authorization) {
    headers.set("Authorization", authorization);
  }
  if (cookie) {
    headers.set("Cookie", cookie);
  }

  return headers;
}

async function resolveAuthHeaders(env = process.env, fetchImpl = fetch) {
  const headers = authHeaders(env);
  if (headers.has("Authorization") || headers.has("Cookie")) {
    return headers;
  }

  const sellerEmail = readEnv("SMOKE_SELLER_EMAIL", env);
  const sellerPassword = readEnv("SMOKE_SELLER_PASSWORD", env);
  const authBaseUrl =
    readEnv("PLATFORM_AUTH_BASE_URL", env) ??
    readEnv("PLATFORM_ADMIN_BASE_URL", env) ??
    readEnv("PLATFORM_API_BASE_URL", env);
  if (sellerEmail && sellerPassword && authBaseUrl) {
    if (readEnv("SMOKE_REGISTER_SELLER", env) === "true") {
      const registration = await registerSellerAccount({
        authBaseUrl,
        email: sellerEmail,
        password: sellerPassword,
        displayName: readEnv("SMOKE_SELLER_DISPLAY_NAME", env) ??
          "Stripe Preview Smoke Seller",
      }, fetchImpl);
      const sessionToken = await signInWithPasswordAfterRegistration({
        authBaseUrl,
        email: sellerEmail,
        password: sellerPassword,
        accountId: registration.accountId,
        attempts: positiveIntegerEnv("SMOKE_AUTH_READY_ATTEMPTS", env) ?? 24,
        retryDelayMs: positiveIntegerEnv("SMOKE_AUTH_READY_RETRY_DELAY_MS", env) ?? 5000,
      }, fetchImpl);
      headers.set("Authorization", `Bearer ${sessionToken}`);
      return headers;
    }

    const sessionToken = await signInWithPassword({
      authBaseUrl,
      email: sellerEmail,
      password: sellerPassword,
      accountId: readEnv("SMOKE_SELLER_ACCOUNT_ID", env),
      label: "seller password sign-in",
    }, fetchImpl);
    headers.set("Authorization", `Bearer ${sessionToken}`);
    return headers;
  }

  const adminEmail = readEnv("PLATFORM_ADMIN_EMAIL", env);
  const adminPassword = readEnv("PLATFORM_ADMIN_PASSWORD", env);
  if (!adminEmail || !adminPassword || !authBaseUrl) {
    return headers;
  }

  const sessionToken = await signInWithPassword({
    authBaseUrl,
    email: adminEmail,
    password: adminPassword,
    accountId: readEnv("PLATFORM_ADMIN_ACCOUNT_ID", env),
    label: "admin password sign-in",
  }, fetchImpl);

  headers.set("Authorization", `Bearer ${sessionToken}`);
  return headers;
}

async function signInWithPassword(params, fetchImpl) {
  const signIn = await requestJson(
    `${stripTrailingSlash(params.authBaseUrl)}/api/auth/password-sign-in`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: params.email,
        password: params.password,
        ...(params.accountId ? { accountId: params.accountId } : {}),
      }),
    },
    fetchImpl,
  );
  assert(
    signIn.response.status === 200,
    statusFailureMessage(params.label, signIn, "200"),
  );
  return readSessionToken(signIn.body, params.label);
}

async function signInWithPasswordAfterRegistration(params, fetchImpl) {
  let lastError = null;
  for (let attempt = 1; attempt <= params.attempts; attempt += 1) {
    try {
      return await signInWithPassword({
        authBaseUrl: params.authBaseUrl,
        email: params.email,
        password: params.password,
        accountId: params.accountId,
        label: "seller password sign-in after registration",
      }, fetchImpl);
    } catch (error) {
      lastError = error;
      if (attempt < params.attempts) {
        await sleep(params.retryDelayMs);
      }
    }
  }

  throw lastError ?? new Error("Seller password sign-in after registration did not complete.");
}

async function registerSellerAccount(params, fetchImpl) {
  const registration = await requestJson(
    `${stripTrailingSlash(params.authBaseUrl)}/api/auth/register`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: params.email,
        password: params.password,
        displayName: params.displayName,
        givenName: "Stripe",
        familyName: "Smoke",
        consents: [
          {
            policyKey: "terms-of-service",
            policyVersion: "v1",
          },
        ],
      }),
    },
    fetchImpl,
  );
  assert(
    registration.response.status === 201,
    statusFailureMessage("seller registration", registration, "201"),
  );
  const sessionToken = readSessionToken(registration.body, "seller registration");
  const accountId =
    typeof registration.body?.accountId === "string"
      ? registration.body.accountId.trim()
      : "";
  assert(accountId, "Seller registration did not return an account id.");

  return { accountId, sessionToken };
}

function readSessionToken(body, label) {
  const sessionToken =
    typeof body?.sessionToken === "string"
      ? body.sessionToken.trim()
      : "";
  assert(sessionToken, `${label} did not return a session token.`);
  return sessionToken;
}

async function requestJson(url, init = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, init);
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

function resultDetail(result) {
  if (
    typeof result.body === "object" &&
    result.body !== null &&
    "error" in result.body
  ) {
    const error = result.body.error;
    if (typeof error === "object" && error !== null) {
      const code = typeof error.code === "string" ? error.code : null;
      const message = typeof error.message === "string" ? error.message : null;
      return [code, message].filter(Boolean).join(": ");
    }
    if (typeof error === "string") {
      return error;
    }
  }

  if (typeof result.body === "string") {
    return result.body.slice(0, 500);
  }

  if (result.body !== null && result.body !== undefined) {
    return JSON.stringify(result.body).slice(0, 500);
  }

  return "";
}

function statusFailureMessage(label, result, expected) {
  const detail = resultDetail(result);
  return `Expected ${label} to return ${expected}, got ${result.response.status}.` +
    (detail ? ` Response: ${detail}` : "");
}

function assertObject(value, message) {
  assert(typeof value === "object" && value !== null, message);
  return value;
}

export function envReport(env = process.env) {
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
    "PLATFORM_AUTH_BASE_URL",
    "PLATFORM_ADMIN_BASE_URL",
    "PLATFORM_ADMIN_EMAIL",
    "PLATFORM_ADMIN_PASSWORD",
    "SMOKE_REGISTER_SELLER",
    "SMOKE_AUTH_READY_ATTEMPTS",
    "SMOKE_AUTH_READY_RETRY_DELAY_MS",
    "SMOKE_SELLER_ACCOUNT_ID",
    "SMOKE_SELLER_DISPLAY_NAME",
    "SMOKE_SELLER_EMAIL",
    "SMOKE_SELLER_PASSWORD",
    "SMOKE_BALANCE_CREDIT_AMOUNT",
    "SMOKE_CREATE_PAYMENT",
    "SMOKE_ORDER_IDS",
    "SMOKE_PAYOUT_AMOUNT",
    "SMOKE_PAYMENT_METHOD_CATEGORY",
    "SMOKE_REQUEST_PAYOUT",
  ];
  const missing = required.filter((name) => !readEnv(name, env));
  const presentOptional = optional.filter((name) => Boolean(readEnv(name, env)));

  return {
    missing,
    presentOptional,
    testModeKeysLikely:
      readEnv("STRIPE_SECRET_KEY", env)?.startsWith("sk_test") === true &&
      readEnv("STRIPE_PUBLISHABLE_KEY", env)?.startsWith("pk_test") === true,
  };
}

export async function runEdgeCheck(baseUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const health = await requestJson(`${baseUrl}/health`, {}, fetchImpl);
  assert(
    health.response.status === 200,
    `Expected /health to return 200, got ${health.response.status}.`,
  );

  const paymentWebhook = await requestJson(
    `${baseUrl}/api/payments/provider/webhooks`,
    {
      method: "POST",
      body: "{\"id\":\"evt_payment_smoke\",\"type\":\"checkout.session.completed\",\"data\":{\"object\":{\"id\":\"cs_smoke\"}}}",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": "t=1,v1=invalid",
      },
    },
    fetchImpl,
  );
  assert(
    paymentWebhook.response.status === 400,
    `Expected unsigned payment webhook probe to be rejected with 400, got ${paymentWebhook.response.status}.`,
  );

  const moneyMovementWebhook = await requestJson(
    `${baseUrl}/api/settlement/provider/money-movement/webhooks`,
    {
      method: "POST",
      body: "{\"id\":\"evt_smoke\",\"type\":\"payout.failed\",\"data\":{\"object\":{\"id\":\"po_smoke\"}}}",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": "t=1,v1=invalid",
      },
    },
    fetchImpl,
  );
  assert(
    moneyMovementWebhook.response.status === 400,
    `Expected unsigned money movement webhook probe to be rejected with 400, got ${moneyMovementWebhook.response.status}.`,
  );

  return {
    health: "ok",
    unsignedPaymentWebhookRejected: true,
    unsignedMoneyMovementWebhookRejected: true,
  };
}

async function getJsonOk(fetchImpl, url, headers, label) {
  const result = await requestJson(url, { headers }, fetchImpl);
  assert(
    result.response.status === 200,
    statusFailureMessage(label, result, "200"),
  );
  return assertObject(result.body, `Expected ${label} to return a JSON object.`);
}

export async function runSellerFlow(baseUrl, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = await resolveAuthHeaders(env, fetchImpl);
  assert(
    headers.has("Authorization") || headers.has("Cookie"),
    "Set PLATFORM_API_AUTHORIZATION or PLATFORM_API_COOKIE; set SMOKE_SELLER_EMAIL and SMOKE_SELLER_PASSWORD; or set SMOKE_REGISTER_SELLER=true with SMOKE_SELLER_EMAIL, SMOKE_SELLER_PASSWORD, and PLATFORM_AUTH_BASE_URL before running --seller-flow.",
  );

  const accountStatus = await getJsonOk(
    fetchImpl,
    `${baseUrl}/api/settlement/account-status`,
    headers,
    "settlement account status",
  );
  assertObject(accountStatus.wallet, "Expected account status to include wallet details.");
  assert(
    typeof accountStatus.wallet.can_use_balance_credit === "boolean",
    "Expected account status to report whether wallet balance credit can be used.",
  );

  await getJsonOk(fetchImpl, `${baseUrl}/api/settlement/payout-readiness`, headers, "payout readiness");
  await getJsonOk(fetchImpl, `${baseUrl}/api/marketplace/account/marketplace-checkout-fee-policy`, headers, "marketplace checkout fee policy");
  const paymentProviderHealth = await getJsonOk(fetchImpl, `${baseUrl}/api/marketplace/account/provider-health`, headers, "payment provider health");
  const settlementProviderHealth = await getJsonOk(fetchImpl, `${baseUrl}/api/settlement/provider-health`, headers, "settlement provider health");
  assert(
    paymentProviderHealth.provider_name === "stripe",
    `Expected Stripe payment provider health, got ${paymentProviderHealth.provider_name}.`,
  );
  assert(
    settlementProviderHealth.provider_name === "stripe",
    `Expected Stripe settlement provider health, got ${settlementProviderHealth.provider_name}.`,
  );

  await getJsonOk(fetchImpl, `${baseUrl}/api/marketplace/account/provider-idempotency`, headers, "payment provider idempotency");
  await getJsonOk(fetchImpl, `${baseUrl}/api/settlement/payouts/provider-idempotency`, headers, "payout provider idempotency");
  await getJsonOk(fetchImpl, `${baseUrl}/api/settlement/payouts/platform-balance-forecast`, headers, "platform balance forecast");

  const checkout = await runCheckoutProbe(baseUrl, { env, fetchImpl, headers });

  const onboardingHeaders = new Headers(headers);
  onboardingHeaders.set("Content-Type", "application/json");
  const onboarding = await requestJson(
    `${baseUrl}/api/settlement/payout-setup/onboarding-session`,
    {
      method: "POST",
      headers: onboardingHeaders,
      body: JSON.stringify({
        returnUrl: readEnv("STRIPE_CONNECT_RETURN_URL", env),
        refreshUrl: readEnv("STRIPE_CONNECT_REFRESH_URL", env),
      }),
    },
    fetchImpl,
  );
  assert(
    onboarding.response.status === 201,
    statusFailureMessage("onboarding session", onboarding, "201"),
  );
  assert(
    typeof onboarding.body?.url === "string" &&
      onboarding.body.url.startsWith("https://"),
    "Expected onboarding session to return a hosted setup URL.",
  );

  const refresh = await requestJson(`${baseUrl}/api/settlement/payout-setup/refresh`, {
    method: "POST",
    headers,
  }, fetchImpl);
  assert(
    refresh.response.status === 200,
    statusFailureMessage("payout setup refresh", refresh, "200"),
  );

  const previewHeaders = new Headers(headers);
  previewHeaders.set("Content-Type", "application/json");
  const preview = await requestJson(`${baseUrl}/api/settlement/payouts/preview`, {
    method: "POST",
    headers: previewHeaders,
    body: JSON.stringify({ amount: readEnv("SMOKE_PAYOUT_AMOUNT", env) ?? "1.00" }),
  }, fetchImpl);
  assert(
    preview.response.status === 200 || preview.response.status === 400,
    statusFailureMessage("payout preview", preview, "200 or validation 400"),
  );

  const payoutRequest = await maybeRequestPayout(baseUrl, {
    env,
    fetchImpl,
    headers: previewHeaders,
    previewBody: preview.body,
  });

  return {
    accountStatus: "ok",
    walletBalanceCreditAvailable: accountStatus.wallet.can_use_balance_credit,
    paymentProviderHealth: "ok",
    settlementProviderHealth: "ok",
    providerIdempotencySurfaces: "ok",
    platformBalanceForecast: "ok",
    checkout,
    readiness: "ok",
    hostedOnboardingCreated: true,
    refresh: "ok",
    payoutPreviewStatus: preview.response.status,
    payoutPreviewCanRequest: preview.body?.can_request ?? null,
    payoutRequest,
  };
}

async function runCheckoutProbe(baseUrl, options) {
  const orderIds = csvEnv("SMOKE_ORDER_IDS", options.env);
  if (orderIds.length === 0) {
    return "skipped";
  }

  const query = new URLSearchParams();
  for (const orderId of orderIds) {
    query.append("orderId", orderId);
  }
  const balanceCreditAmount = readEnv("SMOKE_BALANCE_CREDIT_AMOUNT", options.env);
  const paymentMethodCategory = readEnv("SMOKE_PAYMENT_METHOD_CATEGORY", options.env);
  if (balanceCreditAmount) {
    query.set("requestedBalanceCreditAmount", balanceCreditAmount);
  }
  if (paymentMethodCategory) {
    query.set("paymentMethodCategory", paymentMethodCategory);
  }

  const status = await getJsonOk(
    options.fetchImpl,
    `${baseUrl}/api/marketplace/account/checkout/status?${query.toString()}`,
    options.headers,
    "checkout payment status",
  );
  assertObject(status.wallet_credit, "Expected checkout status to include wallet credit.");
  assertObject(status.marketplace_checkout_fee, "Expected checkout status to include marketplace checkout fee.");

  if (readEnv("SMOKE_CREATE_PAYMENT", options.env) !== "true") {
    return {
      status: "ok",
      createPayment: "skipped",
      walletCreditAppliedAmount: status.wallet_credit.applied_amount,
      processorAmount: status.marketplace_checkout_fee.processor_amount,
    };
  }

  assert(
    status.can_start_payment === true,
    "Expected checkout status to allow payment before SMOKE_CREATE_PAYMENT=true can submit.",
  );
  const createHeaders = new Headers(options.headers);
  createHeaders.set("Content-Type", "application/json");
  const created = await requestJson(
    `${baseUrl}/api/marketplace/account/payments`,
    {
      method: "POST",
      headers: createHeaders,
      body: JSON.stringify({
        orderIds,
        currencyCode: "usd",
        requestedBalanceCreditAmount: balanceCreditAmount ?? "0.00",
        paymentMethodCategory: paymentMethodCategory ?? "card",
        marketplaceCheckoutFeeQuoteFingerprint:
          status.marketplace_checkout_fee.quote_fingerprint,
      }),
    },
    options.fetchImpl,
  );
  assert(
    created.response.status === 201,
    `Expected payment creation to return 201, got ${created.response.status}.`,
  );

  return {
    status: "ok",
    createPayment: "ok",
    paymentId: created.body?.payment_id ?? null,
    processorPaymentKind: created.body?.processor_payment_kind ?? null,
    walletCreditAppliedAmount: status.wallet_credit.applied_amount,
    processorAmount: status.marketplace_checkout_fee.processor_amount,
  };
}

async function maybeRequestPayout(baseUrl, options) {
  if (readEnv("SMOKE_REQUEST_PAYOUT", options.env) !== "true") {
    return "skipped";
  }
  assert(
    options.previewBody?.can_request === true,
    "Payout preview did not allow payout request; refusing to submit SMOKE_REQUEST_PAYOUT=true.",
  );

  const requested = await requestJson(`${baseUrl}/api/settlement/payouts`, {
    method: "POST",
    headers: options.headers,
    body: JSON.stringify({
      amount: readEnv("SMOKE_PAYOUT_AMOUNT", options.env) ?? "1.00",
      note: "Stripe preview smoke test payout",
    }),
  }, options.fetchImpl);
  assert(
    requested.response.status === 201,
    `Expected payout request to return 201, got ${requested.response.status}.`,
  );

  return {
    status: "ok",
    payoutId: requested.body?.id ?? null,
  };
}

export async function main(options = {}) {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const fetchImpl = options.fetchImpl ?? fetch;
  const runArgs = new Set(argv.slice(2));
  const report = envReport(env);
  const checkOnly = runArgs.has("--check-env") || argv.length <= 2;

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

  const baseUrl = stripTrailingSlash(readEnv("PLATFORM_API_BASE_URL", env));
  const result = {
    edge: runArgs.has("--edge-check") || runArgs.has("--seller-flow")
      ? await runEdgeCheck(baseUrl, { fetchImpl })
      : "skipped",
    sellerFlow: runArgs.has("--seller-flow")
      ? await runSellerFlow(baseUrl, { env, fetchImpl })
      : "skipped",
  };

  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
