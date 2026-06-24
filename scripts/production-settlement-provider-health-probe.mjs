#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateEvidenceReference } from "./marketplace-evidence-references.mjs";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const PRODUCTION_SETTLEMENT_PROVIDER_HEALTH_PROBE_VERSION = "production-settlement-provider-health-probe/v1";

export function parseProductionSettlementProviderHealthProbeArgs(argv, env = process.env) {
  const baseUrl = readOption(argv, "--base-url") ?? readEnv("PRODUCTION_SETTLEMENT_PROBE_BASE_URL", env);

  return {
    outPath: readOption(argv, "--out") ?? readEnv("PRODUCTION_SETTLEMENT_PROBE_OUT", env),
    baseUrl,
    authBaseUrl:
      readOption(argv, "--auth-base-url") ?? readEnv("PRODUCTION_SETTLEMENT_PROBE_AUTH_BASE_URL", env) ?? baseUrl,
    email:
      readOption(argv, "--email") ??
      readEnv("PRODUCTION_SETTLEMENT_PROBE_ACCOUNT_EMAIL", env) ??
      readEnv("PLATFORM_ADMIN_EMAIL", env),
    password:
      readOption(argv, "--password") ??
      readEnv("PRODUCTION_SETTLEMENT_PROBE_ACCOUNT_PASSWORD", env) ??
      readEnv("PLATFORM_ADMIN_PASSWORD", env),
    accountId:
      readOption(argv, "--account-id") ??
      readEnv("PRODUCTION_SETTLEMENT_PROBE_ACCOUNT_ID", env) ??
      readEnv("PLATFORM_ADMIN_ACCOUNT_ID", env),
    environment:
      readOption(argv, "--environment") ??
      readEnv("PRODUCTION_SETTLEMENT_PROBE_ENVIRONMENT", env) ??
      "production-proof",
    productionProofReference:
      readOption(argv, "--production-proof-reference") ??
      readEnv("PRODUCTION_MARKETPLACE_PROOF_REFERENCE", env) ??
      readEnv("PRODUCTION_SETTLEMENT_PROBE_PROOF_REFERENCE", env),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export function validateProductionSettlementProviderHealthProbeOptions(options) {
  const errors = [];
  if (!normalizeUrl(options.baseUrl)) {
    errors.push("PRODUCTION_SETTLEMENT_PROBE_BASE_URL or --base-url is required.");
  }
  if (!normalizeUrl(options.authBaseUrl)) {
    errors.push("PRODUCTION_SETTLEMENT_PROBE_AUTH_BASE_URL or --auth-base-url must be a valid URL.");
  }
  if (String(options.environment ?? "") !== "production-proof") {
    errors.push("Production settlement provider-health probe only supports --environment production-proof.");
  }
  if (!normalizeString(options.email) || !normalizeString(options.password)) {
    errors.push(
      "Production settlement provider-health probe requires operator credentials (PRODUCTION_SETTLEMENT_PROBE_ACCOUNT_EMAIL/PASSWORD or PLATFORM_ADMIN_EMAIL/PASSWORD).",
    );
  }
  validateEvidenceReference("Production proof reference", options.productionProofReference, errors);
  if (!isIsoTimestamp(options.checkedAt)) {
    errors.push("Production settlement provider-health probe checkedAt must be an ISO timestamp.");
  }
  return errors;
}

export async function runProductionSettlementProviderHealthProbe(options, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required for the production settlement provider-health probe.");
  }

  const errors = validateProductionSettlementProviderHealthProbeOptions(options);
  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }

  const baseUrl = normalizeUrl(options.baseUrl);
  const authBaseUrl = normalizeUrl(options.authBaseUrl);
  const sessionToken = await signInWithPassword(
    {
      authBaseUrl,
      email: options.email,
      password: options.password,
      accountId: options.accountId,
    },
    fetchImpl,
  );
  const health = await getProviderHealth(baseUrl, sessionToken, fetchImpl);

  if (health.provider_name !== "stripe") {
    throw new Error(`Expected Stripe settlement provider health, got ${health.provider_name ?? "unknown"}.`);
  }

  const evidence = {
    schemaVersion: PRODUCTION_SETTLEMENT_PROVIDER_HEALTH_PROBE_VERSION,
    checkedAt: options.checkedAt,
    environment: "production-proof",
    productionProofReference: options.productionProofReference,
    baseOrigin: new URL(baseUrl).origin,
    endpoint: "/api/settlement/provider-health",
    status: "pass",
    providerName: health.provider_name,
    adapterMode: health.adapter_mode ?? null,
    webhookSignatureRequired:
      typeof health.webhook_signature_required === "boolean" ? health.webhook_signature_required : null,
    platformBalanceSupported:
      typeof health.platform_balance_supported === "boolean" ? health.platform_balance_supported : null,
    connectedAccountPayoutsSupported:
      typeof health.connected_account_payouts_supported === "boolean"
        ? health.connected_account_payouts_supported
        : null,
  };

  if (options.outPath) {
    await writeJsonRecord(options.outPath, evidence);
  }

  return evidence;
}

async function signInWithPassword(params, fetchImpl) {
  const result = await requestJson(
    new URL("/api/auth/password-sign-in", ensureTrailingSlash(params.authBaseUrl)),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: params.email,
        password: params.password,
        ...(normalizeString(params.accountId) ? { accountId: params.accountId } : {}),
      }),
    },
    fetchImpl,
  );

  if (result.response.status !== 200) {
    throw new Error(`Production settlement provider-health probe sign-in failed with HTTP ${result.response.status}.`);
  }

  const sessionToken = normalizeString(result.body?.sessionToken);
  if (!sessionToken) {
    throw new Error("Production settlement provider-health probe sign-in did not return a session token.");
  }
  return sessionToken;
}

async function getProviderHealth(baseUrl, sessionToken, fetchImpl) {
  const result = await requestJson(
    new URL("/api/settlement/provider-health", ensureTrailingSlash(baseUrl)),
    {
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    },
    fetchImpl,
  );

  if (result.response.status !== 200) {
    throw new Error(`Production settlement provider-health probe endpoint failed with HTTP ${result.response.status}.`);
  }
  if (!result.body || typeof result.body !== "object" || Array.isArray(result.body)) {
    throw new Error("Production settlement provider-health probe endpoint did not return a JSON object.");
  }
  return result.body;
}

async function requestJson(url, init, fetchImpl) {
  const response = await fetchImpl(url, init);
  const contentType = response.headers?.get?.("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : null;
  return { response, body };
}

function normalizeUrl(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  try {
    return new URL(normalized).toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

async function main(argv, env = process.env) {
  try {
    const options = parseProductionSettlementProviderHealthProbeArgs(argv, env);
    if (!options.outPath) {
      console.error("PRODUCTION_SETTLEMENT_PROBE_OUT or --out is required.");
      return 2;
    }

    const evidence = await runProductionSettlementProviderHealthProbe(options);
    console.log(JSON.stringify(evidence, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
