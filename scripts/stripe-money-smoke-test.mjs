#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { readEnv } from "./lib/cli-options.mjs";
import { provisionSyntheticAccountInvitation } from "./lib/synthetic-account-invitations.mjs";
import { PAYMENTS_PROVIDER_WEBHOOK_PATH, SETTLEMENT_MONEY_MOVEMENT_WEBHOOK_PATH } from "./provider-webhook-paths.mjs";
import { isUnrestrictedStripeKeyPair } from "./stripe-key-mode.mjs";

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function csvEnv(name, env = process.env) {
  return (readEnv(name, env) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function positiveIntegerEnv(name, fallback, env = process.env) {
  const raw = readEnv(name, env);
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function delay(ms) {
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
      const registration = await registerSellerAccount(
        {
          authBaseUrl,
          email: sellerEmail,
          password: sellerPassword,
          displayName: readEnv("SMOKE_SELLER_DISPLAY_NAME", env) ?? defaultSmokeSellerDisplayName(sellerEmail),
          adminEmail: readEnv("PLATFORM_ADMIN_EMAIL", env) ?? readEnv("TF_VAR_platform_admin_email", env),
          adminPassword: readEnv("PLATFORM_ADMIN_PASSWORD", env) ?? readEnv("TF_VAR_platform_admin_password", env),
          projectionTimeoutMs: positiveIntegerEnv("SMOKE_INVITATION_PROJECTION_TIMEOUT_MS", undefined, env),
          projectionPollMs: positiveIntegerEnv("SMOKE_INVITATION_PROJECTION_POLL_MS", undefined, env),
        },
        fetchImpl,
      );
      headers.set("Authorization", `Bearer ${registration.sessionToken}`);
      return headers;
    }

    const sessionToken = await signInWithPassword(
      {
        authBaseUrl,
        email: sellerEmail,
        password: sellerPassword,
        accountId: readEnv("SMOKE_SELLER_ACCOUNT_ID", env),
        label: "seller password sign-in",
      },
      fetchImpl,
    );
    headers.set("Authorization", `Bearer ${sessionToken}`);
    return headers;
  }

  const adminEmail = readEnv("PLATFORM_ADMIN_EMAIL", env);
  const adminPassword = readEnv("PLATFORM_ADMIN_PASSWORD", env);
  if (!adminEmail || !adminPassword || !authBaseUrl) {
    return headers;
  }

  const sessionToken = await signInWithPassword(
    {
      authBaseUrl,
      email: adminEmail,
      password: adminPassword,
      accountId: readEnv("PLATFORM_ADMIN_ACCOUNT_ID", env),
      label: "admin password sign-in",
    },
    fetchImpl,
  );

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
  assert(signIn.response.status === 200, statusFailureMessage(params.label, signIn, "200"));
  return readSessionToken(signIn.body, params.label);
}

// Read the server-minted resolution and submit it verbatim. The policy versions
// recorded as Consent come from this value alone -- the smoke test no longer
// asserts a version of its own, because a client naming its own version was
// exactly how acceptance got recorded against a version nobody rendered.
async function resolveRegistrationConsentSubmission(authBaseUrl, fetchImpl) {
  const resolution = await requestJson(
    `${stripTrailingSlash(authBaseUrl)}/api/auth/registration-consent`,
    { method: "GET" },
    fetchImpl,
  );
  assert(
    resolution.response.status === 200,
    statusFailureMessage("registration consent resolution", resolution, "200"),
  );

  return { resolution: resolution.body, affirmed: false };
}

async function registerSellerAccount(params, fetchImpl) {
  await provisionSyntheticAccountInvitation({
    baseUrl: params.authBaseUrl,
    email: params.email,
    adminEmail: params.adminEmail,
    adminPassword: params.adminPassword,
    adminEmailCredentialName: "PLATFORM_ADMIN_EMAIL or TF_VAR_platform_admin_email",
    adminPasswordCredentialName: "PLATFORM_ADMIN_PASSWORD or TF_VAR_platform_admin_password",
    fetchImpl,
    label: "Stripe money smoke",
    invitationIdPrefix: "ivt_stripe_money_smoke",
    projectionTimeoutMs: params.projectionTimeoutMs,
    projectionPollMs: params.projectionPollMs,
  });

  const registrationConsent = await resolveRegistrationConsentSubmission(params.authBaseUrl, fetchImpl);
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
        registrationConsent,
      }),
    },
    fetchImpl,
  );
  assert(registration.response.status === 201, statusFailureMessage("seller registration", registration, "201"));
  const sessionToken = readSessionToken(registration.body, "seller registration");
  const accountId = typeof registration.body?.accountId === "string" ? registration.body.accountId.trim() : "";
  assert(accountId, "Seller registration did not return an account id.");

  return { accountId, sessionToken };
}

function defaultSmokeSellerDisplayName(email) {
  const localPart = email.split("@")[0] ?? "seller";
  const suffix = localPart
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .slice(0, 64);
  return suffix ? `Stripe Preview Smoke ${suffix}` : "Stripe Preview Smoke Seller";
}

function readSessionToken(body, label) {
  const sessionToken = typeof body?.sessionToken === "string" ? body.sessionToken.trim() : "";
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
  if (typeof result.body === "object" && result.body !== null && "error" in result.body) {
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
  return (
    `Expected ${label} to return ${expected}, got ${result.response.status}.` + (detail ? ` Response: ${detail}` : "")
  );
}

function stripeSignature(rawBody, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
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
    "STRIPE_CONNECT_WEBHOOK_SECRET",
  ];
  const optional = [
    "PLATFORM_API_AUTHORIZATION",
    "PLATFORM_API_COOKIE",
    "PLATFORM_AUTH_BASE_URL",
    "PLATFORM_ADMIN_BASE_URL",
    "PLATFORM_ADMIN_EMAIL",
    "PLATFORM_ADMIN_PASSWORD",
    "TF_VAR_platform_admin_email",
    "TF_VAR_platform_admin_password",
    "MARKETPLACE_WEB_BASE_URL",
    "PRODUCTION_MARKETPLACE_PROOF_REFERENCE",
    "PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE",
    "SMOKE_REGISTER_SELLER",
    "SMOKE_SELLER_ACCOUNT_ID",
    "SMOKE_SELLER_DISPLAY_NAME",
    "SMOKE_SELLER_EMAIL",
    "SMOKE_SELLER_PASSWORD",
    "SMOKE_BALANCE_CREDIT_AMOUNT",
    "SMOKE_CREATE_PAYMENT",
    "SMOKE_ORDER_IDS",
    "SMOKE_PAYOUT_AMOUNT",
    "SMOKE_PAYOUT_READINESS_ATTEMPTS",
    "SMOKE_PAYOUT_READINESS_RETRY_DELAY_MS",
    "SMOKE_INVITATION_PROJECTION_TIMEOUT_MS",
    "SMOKE_INVITATION_PROJECTION_POLL_MS",
    "SMOKE_PAYMENT_METHOD_CATEGORY",
    "SMOKE_REQUEST_PAYOUT",
    "STRIPE_MONEY_SMOKE_ENVIRONMENT",
    "STRIPE_MONEY_SMOKE_REQUIRE_DELIVERED_WEBHOOKS",
    "STRIPE_MONEY_SMOKE_ALLOW_LIVE",
    "STRIPE_WEBHOOK_DELIVERY_EVIDENCE_REFERENCE",
  ];
  const missing = required.filter((name) => !readEnv(name, env));
  const presentOptional = optional.filter((name) => Boolean(readEnv(name, env)));
  const stripeKeyMode = resolveStripeKeyMode(env);
  const readinessErrors = validateSmokeEnvironmentForReport(env, missing);
  const stripeDeliveredWebhookProof = resolveStripeDeliveredWebhookProof(env);

  return {
    missing,
    readinessErrors,
    presentOptional,
    stripeKeyMode,
    smokeEnvironment: readEnv("STRIPE_MONEY_SMOKE_ENVIRONMENT", env) ?? "unspecified",
    testModeKeysLikely: stripeKeyMode === "test",
    liveModeKeysLikely: stripeKeyMode === "live",
    liveModeAllowed: liveModeSmokeAllowed(env),
    stripeDeliveredWebhookProof,
  };
}

function validateSmokeEnvironmentForReport(env, missing) {
  const errors = missing.map((name) => `Missing required environment: ${name}.`);
  if (missing.length > 0) {
    return errors;
  }

  try {
    validateStripeKeyModeForRun(env);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    validateStripeDeliveredWebhookProofForRun(env);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

export function resolveStripeKeyMode(env = process.env) {
  const secretKey = readEnv("STRIPE_SECRET_KEY", env);
  const publishableKey = readEnv("STRIPE_PUBLISHABLE_KEY", env);
  if (isUnrestrictedStripeKeyPair(secretKey, publishableKey, "test")) {
    return "test";
  }
  if (isUnrestrictedStripeKeyPair(secretKey, publishableKey, "live")) {
    return "live";
  }
  return "unknown";
}

function liveModeSmokeAllowed(env = process.env) {
  return readEnv("STRIPE_MONEY_SMOKE_ALLOW_LIVE", env) === "true";
}

function requireStripeDeliveredWebhookProof(env = process.env) {
  return readEnv("STRIPE_MONEY_SMOKE_REQUIRE_DELIVERED_WEBHOOKS", env) === "true";
}

function resolveStripeDeliveredWebhookProof(env = process.env) {
  const evidenceReference = readEnv("STRIPE_WEBHOOK_DELIVERY_EVIDENCE_REFERENCE", env);
  const required = requireStripeDeliveredWebhookProof(env);
  const complete = Boolean(evidenceReference);

  return {
    required,
    status: complete ? "provided" : required ? "missing-required-proof" : "not-provided",
    paymentWebhookDeliveryEventId: null,
    connectWebhookDeliveryEventId: null,
    evidenceReference,
  };
}

export function validateStripeDeliveredWebhookProofForRun(env = process.env) {
  if (!requireStripeDeliveredWebhookProof(env)) {
    return;
  }

  const proof = resolveStripeDeliveredWebhookProof(env);
  if (proof.status === "provided") {
    return;
  }

  throw new Error(
    "Set STRIPE_WEBHOOK_DELIVERY_EVIDENCE_REFERENCE before running a smoke test that requires Stripe-delivered webhook proof. Raw Stripe evt_ identifiers belong in the private evidence record, not GitHub Environment configuration.",
  );
}

export function validateStripeKeyModeForRun(env = process.env) {
  const keyMode = resolveStripeKeyMode(env);
  if (keyMode === "test") {
    return;
  }

  if (keyMode !== "live") {
    throw new Error("This smoke test requires matching Stripe test keys or matching Stripe live keys.");
  }

  if (!liveModeSmokeAllowed(env)) {
    throw new Error("Set STRIPE_MONEY_SMOKE_ALLOW_LIVE=true before running this smoke test with Stripe live keys.");
  }

  const reference =
    readEnv("PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE", env) ??
    readEnv("PRODUCTION_MARKETPLACE_PROOF_REFERENCE", env);
  if (!reference) {
    throw new Error(
      "Set PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE or PRODUCTION_MARKETPLACE_PROOF_REFERENCE before running this smoke test with Stripe live keys.",
    );
  }

  const baseUrl = readEnv("PLATFORM_API_BASE_URL", env);
  if (!baseUrl || !isProductionChaseSetsUrl(baseUrl)) {
    throw new Error(
      "Stripe live-key smoke tests must target https://chasesets.com, https://admin.chasesets.com, or https://marketplace.chasesets.com.",
    );
  }
}

function isProductionChaseSetsUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["chasesets.com", "admin.chasesets.com", "marketplace.chasesets.com"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function resolveMarketplaceWebBaseUrl(apiBaseUrl, env = process.env) {
  return stripTrailingSlash(readEnv("MARKETPLACE_WEB_BASE_URL", env) ?? apiBaseUrl);
}

export async function runEdgeCheck(baseUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const health = await requestJson(`${baseUrl}/health`, {}, fetchImpl);
  assert(health.response.status === 200, `Expected /health to return 200, got ${health.response.status}.`);

  const paymentWebhookBody =
    '{"id":"evt_payment_smoke","type":"checkout.session.completed","data":{"object":{"id":"cs_smoke"}}}';
  const paymentWebhook = await requestJson(
    `${baseUrl}${PAYMENTS_PROVIDER_WEBHOOK_PATH}`,
    {
      method: "POST",
      body: paymentWebhookBody,
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

  const moneyMovementWebhookBody = '{"id":"evt_smoke","type":"payout.failed","data":{"object":{"id":"po_smoke"}}}';
  const moneyMovementWebhook = await requestJson(
    `${baseUrl}${SETTLEMENT_MONEY_MOVEMENT_WEBHOOK_PATH}`,
    {
      method: "POST",
      body: moneyMovementWebhookBody,
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

  const paymentSecret = readEnv("STRIPE_WEBHOOK_SECRET", env);
  const connectSecret = readEnv("STRIPE_CONNECT_WEBHOOK_SECRET", env);
  const signedPaymentWebhookBody =
    '{"id":"evt_payment_signed_smoke","type":"product.created","data":{"object":{"id":"prod_smoke"}}}';
  const signedMoneyMovementWebhookBody =
    '{"id":"evt_money_movement_signed_smoke","type":"product.created","data":{"object":{"id":"prod_smoke"}}}';
  let signedPaymentWebhookAccepted = false;
  let signedMoneyMovementWebhookAccepted = false;

  if (paymentSecret) {
    const signedPaymentWebhook = await requestJson(
      `${baseUrl}${PAYMENTS_PROVIDER_WEBHOOK_PATH}`,
      {
        method: "POST",
        body: signedPaymentWebhookBody,
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": stripeSignature(signedPaymentWebhookBody, paymentSecret),
        },
      },
      fetchImpl,
    );
    assert(
      signedPaymentWebhook.response.status === 200,
      `Expected signed payment webhook probe to be accepted with 200, got ${signedPaymentWebhook.response.status}.`,
    );
    signedPaymentWebhookAccepted = true;
  }

  if (connectSecret) {
    const signedMoneyMovementWebhook = await requestJson(
      `${baseUrl}${SETTLEMENT_MONEY_MOVEMENT_WEBHOOK_PATH}`,
      {
        method: "POST",
        body: signedMoneyMovementWebhookBody,
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": stripeSignature(signedMoneyMovementWebhookBody, connectSecret),
        },
      },
      fetchImpl,
    );
    assert(
      signedMoneyMovementWebhook.response.status === 200,
      `Expected signed money movement webhook probe to be accepted with 200, got ${signedMoneyMovementWebhook.response.status}.`,
    );
    signedMoneyMovementWebhookAccepted = true;
  }

  return {
    health: "ok",
    unsignedPaymentWebhookRejected: true,
    unsignedMoneyMovementWebhookRejected: true,
    signedPaymentWebhookAccepted,
    signedMoneyMovementWebhookAccepted,
    webhookChecks: {
      signedProbe: {
        unsignedPaymentWebhookRejected: true,
        unsignedMoneyMovementWebhookRejected: true,
        signedPaymentWebhookAccepted,
        signedMoneyMovementWebhookAccepted,
      },
      stripeDelivered: resolveStripeDeliveredWebhookProof(env),
    },
  };
}

async function getJsonOk(fetchImpl, url, headers, label) {
  const result = await requestJson(url, { headers }, fetchImpl);
  assert(result.response.status === 200, statusFailureMessage(label, result, "200"));
  return assertObject(result.body, `Expected ${label} to return a JSON object.`);
}

async function getRouteOk(fetchImpl, url, headers, label) {
  const result = await requestJson(url, { headers }, fetchImpl);
  assert(result.response.status === 200, statusFailureMessage(label, result, "200"));
  return {
    status: "ok",
    statusCode: result.response.status,
  };
}

function summarizeEmbeddedSetupSession(body) {
  const session = assertObject(body, "Expected embedded payout setup session to return a JSON object.");
  assert(
    typeof session.clientSecret === "string" && session.clientSecret.trim().length > 0,
    "Expected embedded payout setup session to return a clientSecret.",
  );
  assert(
    typeof session.providerReference === "string" && session.providerReference.trim().length > 0,
    "Expected embedded payout setup session to return a providerReference.",
  );
  assert(Array.isArray(session.components), "Expected embedded payout setup session to return components.");
  assert(
    session.components.includes("payout-setup"),
    "Expected embedded payout setup session components to include payout-setup.",
  );

  return {
    status: "created",
    providerReference: session.providerReference,
    clientSecretPresent: true,
    components: session.components,
    expiresAt: typeof session.expiresAt === "string" ? session.expiresAt : null,
  };
}

function summarizeReadinessRefresh(body) {
  const readiness = assertObject(body, "Expected payout setup refresh to return provider-neutral readiness state.");
  return {
    status: "ok",
    readinessStatus: typeof readiness.status === "string" ? readiness.status : null,
    providerReference: typeof readiness.provider_reference === "string" ? readiness.provider_reference : null,
    payoutAccountDashboard:
      typeof readiness.payout_account_dashboard === "string" ? readiness.payout_account_dashboard : null,
    lossesCollector: typeof readiness.losses_collector === "string" ? readiness.losses_collector : null,
    feesCollector: typeof readiness.fees_collector === "string" ? readiness.fees_collector : null,
    requirementsCollector:
      typeof readiness.requirements_collector === "string" ? readiness.requirements_collector : null,
    requirementsCount: Array.isArray(readiness.requirements) ? readiness.requirements.length : null,
  };
}

function embeddedDashboardNoneFailure(embeddedSetupSession, readinessRefresh) {
  if (readinessRefresh.providerReference !== embeddedSetupSession.providerReference) {
    return `Expected payout setup refresh providerReference ${readinessRefresh.providerReference ?? "null"} to match embedded Account Session providerReference ${embeddedSetupSession.providerReference}.`;
  }
  if (readinessRefresh.payoutAccountDashboard !== "none") {
    return `Expected embedded payout setup account dashboard posture to be none, got ${readinessRefresh.payoutAccountDashboard ?? "null"}.`;
  }
  if (readinessRefresh.lossesCollector !== "application") {
    return `Expected embedded payout setup losses collector to be application, got ${readinessRefresh.lossesCollector ?? "null"}.`;
  }
  if (readinessRefresh.feesCollector !== "application") {
    return `Expected embedded payout setup fees collector to be application, got ${readinessRefresh.feesCollector ?? "null"}.`;
  }
  if (readinessRefresh.requirementsCollector !== "application") {
    return `Expected embedded payout setup requirements collector to be application, got ${readinessRefresh.requirementsCollector ?? "null"}.`;
  }

  return null;
}

function embeddedDashboardNoneSummary(embeddedSetupSession, readinessRefresh) {
  return {
    status: "verified",
    providerReference: embeddedSetupSession.providerReference,
    accountSessionCreated: embeddedSetupSession.status === "created",
    component: "payout-setup",
    payoutAccountDashboard: readinessRefresh.payoutAccountDashboard,
    lossesCollector: readinessRefresh.lossesCollector,
    feesCollector: readinessRefresh.feesCollector,
    requirementsCollector: readinessRefresh.requirementsCollector,
  };
}

async function refreshPayoutSetupUntilEmbeddedDashboardNone(baseUrl, options) {
  const attempts = positiveIntegerEnv("SMOKE_PAYOUT_READINESS_ATTEMPTS", 12, options.env);
  const retryDelayMs = positiveIntegerEnv("SMOKE_PAYOUT_READINESS_RETRY_DELAY_MS", 5000, options.env);
  let lastReadinessRefresh = null;
  let lastFailure = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const refresh = await requestJson(
      `${baseUrl}/api/settlement/payout-setup/refresh`,
      {
        method: "POST",
        headers: options.headers,
        body: JSON.stringify({
          contactEmail: readEnv("SMOKE_SELLER_EMAIL", options.env),
          providerReference: options.embeddedSetupSession.providerReference,
        }),
      },
      options.fetchImpl,
    );
    assert(refresh.response.status === 200, statusFailureMessage("payout setup refresh", refresh, "200"));
    lastReadinessRefresh = summarizeReadinessRefresh(refresh.body);
    lastFailure = embeddedDashboardNoneFailure(options.embeddedSetupSession, lastReadinessRefresh);
    if (!lastFailure) {
      return {
        readinessRefresh: lastReadinessRefresh,
        embeddedDashboardNone: embeddedDashboardNoneSummary(options.embeddedSetupSession, lastReadinessRefresh),
      };
    }
    if (attempt < attempts) {
      await delay(retryDelayMs);
    }
  }

  throw new Error(lastFailure ?? "Expected payout setup refresh to prove embedded dashboard-none posture.");
}

function summarizePayoutPreview(result) {
  if (result.response.status === 400) {
    const error = assertObject(result.body?.error, "Expected payout preview validation failure to include an error.");
    assert(typeof error.code === "string" && error.code.trim(), "Expected payout preview error to include a code.");
    assert(
      typeof error.message === "string" && error.message.trim(),
      "Expected payout preview error to include a support-safe message.",
    );
    return {
      status: "blocked",
      statusCode: result.response.status,
      canRequest: false,
      unavailableReasons: [],
      unavailableReasonDetails: [{ code: error.code, message: error.message }],
    };
  }

  assert(result.response.status === 200, statusFailureMessage("payout preview", result, "200 or validation 400"));
  const preview = assertObject(result.body, "Expected payout preview to return a JSON object.");
  assert(typeof preview.can_request === "boolean", "Expected payout preview to return can_request.");
  const unavailableReasons = Array.isArray(preview.unavailable_reasons) ? preview.unavailable_reasons : [];
  const unavailableReasonDetails = Array.isArray(preview.unavailable_reason_details)
    ? preview.unavailable_reason_details
    : [];
  if (!preview.can_request) {
    assert(
      unavailableReasons.length > 0 || unavailableReasonDetails.length > 0,
      "Expected blocked payout preview to include safe unavailable reasons.",
    );
  }

  return {
    status: preview.can_request ? "available" : "blocked",
    statusCode: result.response.status,
    canRequest: preview.can_request,
    unavailableReasons,
    unavailableReasonDetails,
  };
}

export async function runSellerFlow(baseUrl, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const marketplaceWebBaseUrl = resolveMarketplaceWebBaseUrl(baseUrl, env);
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
  await getJsonOk(
    fetchImpl,
    `${baseUrl}/api/marketplace/account/marketplace-checkout-fee-policy`,
    headers,
    "marketplace checkout fee policy",
  );
  const settlementProviderHealth = await getJsonOk(
    fetchImpl,
    `${baseUrl}/api/settlement/provider-health`,
    headers,
    "settlement provider health",
  );
  assert(
    settlementProviderHealth.provider_name === "stripe",
    `Expected Stripe settlement provider health, got ${settlementProviderHealth.provider_name}.`,
  );

  await getJsonOk(
    fetchImpl,
    `${baseUrl}/api/settlement/payouts/provider-idempotency`,
    headers,
    "payout provider idempotency",
  );
  await getJsonOk(
    fetchImpl,
    `${baseUrl}/api/settlement/payouts/platform-balance-forecast`,
    headers,
    "platform balance forecast",
  );

  const checkout = await runCheckoutProbe(baseUrl, { env, fetchImpl, headers });

  const setupPage = await getRouteOk(
    fetchImpl,
    `${marketplaceWebBaseUrl}/account/payouts/setup`,
    headers,
    "payout setup page",
  );

  const setupHeaders = new Headers(headers);
  setupHeaders.set("Content-Type", "application/json");
  const embeddedSetup = await requestJson(
    `${baseUrl}/api/settlement/payout-setup/embedded-session`,
    {
      method: "POST",
      headers: setupHeaders,
      body: JSON.stringify({
        contactEmail: readEnv("SMOKE_SELLER_EMAIL", env),
      }),
    },
    fetchImpl,
  );
  assert(
    embeddedSetup.response.status === 201,
    statusFailureMessage("embedded payout setup session", embeddedSetup, "201"),
  );
  const embeddedSetupSession = summarizeEmbeddedSetupSession(embeddedSetup.body);

  const { readinessRefresh, embeddedDashboardNone } = await refreshPayoutSetupUntilEmbeddedDashboardNone(baseUrl, {
    env,
    fetchImpl,
    headers: setupHeaders,
    embeddedSetupSession,
  });

  const previewHeaders = new Headers(headers);
  previewHeaders.set("Content-Type", "application/json");
  const preview = await requestJson(
    `${baseUrl}/api/settlement/payouts/preview`,
    {
      method: "POST",
      headers: previewHeaders,
      body: JSON.stringify({ amount: readEnv("SMOKE_PAYOUT_AMOUNT", env) ?? "1.00" }),
    },
    fetchImpl,
  );
  const payoutPreview = summarizePayoutPreview(preview);

  const payoutRequest = await maybeRequestPayout(baseUrl, {
    env,
    fetchImpl,
    headers: previewHeaders,
    previewBody: preview.body,
  });

  return {
    accountStatus: "ok",
    walletBalanceCreditAvailable: accountStatus.wallet.can_use_balance_credit,
    settlementProviderHealth: "ok",
    providerIdempotencySurfaces: "ok",
    platformBalanceForecast: "ok",
    checkout,
    readiness: "ok",
    setupPage,
    embeddedSetupSession,
    readinessRefresh,
    embeddedDashboardNone,
    refresh: readinessRefresh.status,
    payoutPreviewStatus: preview.response.status,
    payoutPreviewCanRequest: payoutPreview.canRequest,
    payoutPreview,
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
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
      }),
    },
    options.fetchImpl,
  );
  assert(created.response.status === 201, `Expected payment creation to return 201, got ${created.response.status}.`);

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

  const requested = await requestJson(
    `${baseUrl}/api/settlement/payouts`,
    {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify({
        amount: readEnv("SMOKE_PAYOUT_AMOUNT", options.env) ?? "1.00",
        note: "Stripe preview smoke test payout",
      }),
    },
    options.fetchImpl,
  );
  assert(requested.response.status === 201, `Expected payout request to return 201, got ${requested.response.status}.`);

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
    console.log(JSON.stringify({ ok: report.readinessErrors.length === 0, ...report }, null, 2));
    return;
  }

  assert(report.missing.length === 0, `Missing required environment: ${report.missing.join(", ")}.`);
  validateStripeKeyModeForRun(env);
  validateStripeDeliveredWebhookProofForRun(env);

  const baseUrl = stripTrailingSlash(readEnv("PLATFORM_API_BASE_URL", env));
  const result = {
    smokeEnvironment: report.smokeEnvironment,
    webhookProof: {
      signedProbe: "executed-by-smoke-test-when-edge-check-runs",
      stripeDelivered: report.stripeDeliveredWebhookProof,
    },
    edge:
      runArgs.has("--edge-check") || runArgs.has("--seller-flow")
        ? await runEdgeCheck(baseUrl, { env, fetchImpl })
        : "skipped",
    sellerFlow: runArgs.has("--seller-flow") ? await runSellerFlow(baseUrl, { env, fetchImpl }) : "skipped",
  };

  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
