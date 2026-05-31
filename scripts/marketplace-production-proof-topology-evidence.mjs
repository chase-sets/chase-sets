#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateEvidenceReference } from "./marketplace-evidence-references.mjs";

export const PRODUCTION_PROOF_TOPOLOGY_EVIDENCE_VERSION = "marketplace-production-proof-topology-evidence/v1";

export const PRODUCTION_PROOF_TOPOLOGY_ALLOWED_ORIGINS = ["https://chasesets.com", "https://admin.chasesets.com"];

export const PROVIDER_CALLBACK_PATHS = [
  "/api/payments/provider/webhooks",
  "/api/settlement/provider/money-movement/webhooks",
  "/api/notifications/provider/email/webhooks",
  "/api/fulfillment/provider/postage/webhooks",
];

export const PROVIDER_CALLBACK_EXPECTED_STATUSES = [200, 400];
export const PRIVATE_PROOF_API_EXPECTED_STATUSES = [401];

export const PRIVATE_PROOF_API_PATHS = [
  { method: "POST", path: "/api/marketplace/account/checkout-sessions" },
  { method: "POST", path: "/api/marketplace/account/checkout-sessions/topology-proof-session/confirm" },
  { method: "GET", path: "/api/marketplace/account/checkout/status" },
  { method: "GET", path: "/api/marketplace/account/marketplace-checkout-fee-policy" },
  { method: "POST", path: "/api/marketplace/account/payments" },
  { method: "GET", path: "/api/marketplace/account/provider-health" },
  { method: "GET", path: "/api/marketplace/account/provider-idempotency" },
  { method: "POST", path: "/api/marketplace/account/purchases/checkout/preview" },
  { method: "GET", path: "/api/settlement/account-status" },
  { method: "GET", path: "/api/settlement/payout-readiness" },
  { method: "POST", path: "/api/settlement/payout-setup/onboarding-session" },
  { method: "GET", path: "/api/settlement/payout-setup/progress" },
  { method: "POST", path: "/api/settlement/payout-setup/refresh" },
  { method: "GET", path: "/api/settlement/payouts" },
  { method: "GET", path: "/api/settlement/payouts/platform-balance-forecast" },
  { method: "GET", path: "/api/settlement/payouts/provider-idempotency" },
  { method: "POST", path: "/api/settlement/payouts/preview" },
  { method: "GET", path: "/api/settlement/provider-health" },
  { method: "GET", path: "/api/settlement/wallet" },
];

export function parseProductionProofTopologyArgs(argv, env = process.env) {
  return {
    baseUrl: readOption(argv, "--base-url") ?? readEnv("PRODUCTION_PROOF_BASE_URL", env) ?? "https://chasesets.com",
    reference: readOption(argv, "--reference") ?? readEnv("PRODUCTION_MARKETPLACE_PROOF_REFERENCE", env),
    operator: readOption(argv, "--operator") ?? readEnv("PRODUCTION_PROOF_OPERATOR", env),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    productionMarketplaceProofEnabled:
      readOption(argv, "--proof-enabled") ?? readEnv("PRODUCTION_MARKETPLACE_PROOF_ENABLED", env) ?? "false",
    productionMarketplacePublicEnabled:
      readOption(argv, "--public-enabled") ?? readEnv("PRODUCTION_MARKETPLACE_PUBLIC_ENABLED", env) ?? "false",
  };
}

export async function collectProductionProofTopologyEvidence(options, fetchImpl = globalThis.fetch) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const health = await fetchStatus(fetchImpl, new URL("/api/health/ready", baseUrl), { method: "GET" });
  const providerCallbacks = [];
  const privateProofApis = [];

  for (const path of PROVIDER_CALLBACK_PATHS) {
    providerCallbacks.push(
      await fetchStatus(fetchImpl, new URL(path, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).then((status) => ({
        path,
        ...status,
        reachable: status.status !== 404 && status.status < 500,
      })),
    );
  }

  for (const check of PRIVATE_PROOF_API_PATHS) {
    privateProofApis.push(
      await fetchStatus(fetchImpl, new URL(check.path, baseUrl), {
        method: check.method,
      }).then((status) => ({
        method: check.method,
        path: check.path,
        ...status,
        reachable: status.status !== 404 && status.status < 500,
      })),
    );
  }

  return buildProductionProofTopologyEvidence({
    ...options,
    baseUrl,
    health,
    providerCallbacks,
    privateProofApis,
  });
}

export function buildProductionProofTopologyEvidence(input) {
  const errors = validateProductionProofTopologyEvidence(input);

  return {
    schemaVersion: PRODUCTION_PROOF_TOPOLOGY_EVIDENCE_VERSION,
    reference: input.reference,
    operator: input.operator,
    checkedAt: input.checkedAt,
    baseUrl: input.baseUrl,
    productionEnvironment: {
      PRODUCTION_MARKETPLACE_PROOF_ENABLED: input.productionMarketplaceProofEnabled,
      PRODUCTION_MARKETPLACE_PROOF_REFERENCE: input.reference,
      PRODUCTION_MARKETPLACE_PUBLIC_ENABLED: input.productionMarketplacePublicEnabled,
    },
    health: input.health,
    providerCallbacks: input.providerCallbacks,
    privateProofApis: input.privateProofApis,
    passesProductionProofTopologyGate: errors.length === 0,
    errors,
  };
}

export function validateProductionProofTopologyEvidence(input) {
  const errors = [];

  validateReference("Production proof reference", input.reference, errors);
  if (!input.operator) {
    errors.push("Production proof operator is required.");
  }
  if (!isIsoTimestamp(input.checkedAt)) {
    errors.push("Production proof topology checkedAt must be an ISO timestamp.");
  }
  validateProductionBaseUrl(input.baseUrl, errors);
  if (normalizeBoolean(input.productionMarketplaceProofEnabled) !== true) {
    errors.push("PRODUCTION_MARKETPLACE_PROOF_ENABLED must be true for production proof topology evidence.");
  }
  if (normalizeBoolean(input.productionMarketplacePublicEnabled) !== false) {
    errors.push("PRODUCTION_MARKETPLACE_PUBLIC_ENABLED must remain false for production proof topology evidence.");
  }
  if (input.health?.status !== 200) {
    errors.push("Production proof topology requires /api/health/ready to return 200.");
  }
  if (input.health) {
    validateApiProbeResponse("Production proof topology health /api/health/ready", input.health, [200], errors);
  }

  for (const path of PROVIDER_CALLBACK_PATHS) {
    const callback = input.providerCallbacks?.find((row) => row.path === path);
    if (!callback) {
      errors.push(`Production proof topology must check ${path}.`);
      continue;
    }
    if (callback.status === 404) {
      errors.push(`Production proof topology callback ${path} must not return 404.`);
    }
    if (callback.status >= 500) {
      errors.push(`Production proof topology callback ${path} must not return a 5xx response.`);
    }
    if (callback.error) {
      errors.push(`Production proof topology callback ${path} failed: ${callback.error}`);
    }
    validateApiProbeResponse(
      `Production proof topology callback ${path}`,
      callback,
      PROVIDER_CALLBACK_EXPECTED_STATUSES,
      errors,
    );
  }

  for (const check of PRIVATE_PROOF_API_PATHS) {
    const proofApi = input.privateProofApis?.find((row) => row.path === check.path && row.method === check.method);
    if (!proofApi) {
      errors.push(`Production proof topology must check ${check.method} ${check.path}.`);
      continue;
    }
    if (proofApi.status === 404) {
      errors.push(`Production proof topology private API ${check.method} ${check.path} must not return 404.`);
    }
    if (proofApi.status >= 500) {
      errors.push(
        `Production proof topology private API ${check.method} ${check.path} must not return a 5xx response.`,
      );
    }
    if (proofApi.error) {
      errors.push(`Production proof topology private API ${check.method} ${check.path} failed: ${proofApi.error}`);
    }
    validateApiProbeResponse(
      `Production proof topology private API ${check.method} ${check.path}`,
      proofApi,
      PRIVATE_PROOF_API_EXPECTED_STATUSES,
      errors,
    );
  }

  return errors;
}

async function main(argv, env = process.env) {
  const options = parseProductionProofTopologyArgs(argv, env);
  const evidence = await collectProductionProofTopologyEvidence(options);
  console.log(JSON.stringify(evidence, null, 2));

  if (!evidence.passesProductionProofTopologyGate) {
    console.error("Production proof topology evidence did not pass.");
    return 1;
  }

  return 0;
}

async function fetchStatus(fetchImpl, url, options) {
  try {
    const response = await fetchImpl(url, {
      ...options,
      redirect: "manual",
    });
    return {
      url: url.toString(),
      responseUrl: response.url,
      status: response.status,
      ok: response.ok,
      contentType: response.headers?.get?.("content-type") ?? null,
      redirected: response.redirected === true,
    };
  } catch (error) {
    return {
      url: url.toString(),
      status: 0,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function validateReference(label, value, errors) {
  validateEvidenceReference(label, typeof value === "string" ? value : "", errors);
}

function validateProductionBaseUrl(value, errors) {
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push("Production proof topology baseUrl must be a valid URL.");
    return;
  }

  if (!PRODUCTION_PROOF_TOPOLOGY_ALLOWED_ORIGINS.includes(url.origin)) {
    errors.push(
      `Production proof topology baseUrl must be one of ${PRODUCTION_PROOF_TOPOLOGY_ALLOWED_ORIGINS.join(", ")}.`,
    );
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    errors.push("Production proof topology baseUrl must not include a path, query, or fragment.");
  }
}

function validateApiProbeResponse(label, probe, expectedStatuses, errors) {
  if (!expectedStatuses.includes(probe.status)) {
    errors.push(`${label} must return one of ${expectedStatuses.join(", ")}; received ${probe.status}.`);
  }

  if (probe.redirected || isRedirectStatus(probe.status)) {
    errors.push(`${label} must not redirect.`);
  }

  if (probe.responseUrl && probe.url && normalizeResponseUrl(probe.responseUrl) !== normalizeResponseUrl(probe.url)) {
    errors.push(`${label} must respond from the requested URL without following a fallback route.`);
  }

  if (!isJsonContentType(probe.contentType)) {
    errors.push(`${label} must return a JSON API response.`);
  }
}

function normalizeResponseUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function isRedirectStatus(status) {
  return status >= 300 && status < 400;
}

function isJsonContentType(value) {
  return typeof value === "string" && /\bapplication\/(?:[^;]+\+)?json\b/i.test(value);
}

function isIsoTimestamp(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function normalizeBoolean(value) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  if (["1", "true", "yes", "on"].includes(value.trim().toLowerCase())) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value.trim().toLowerCase())) {
    return false;
  }
  return null;
}

function readEnv(name, env) {
  const value = env[name];
  return value && value.trim() ? value.trim() : null;
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
