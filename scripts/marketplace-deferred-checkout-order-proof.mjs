#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateEvidenceReference } from "./marketplace-evidence-references.mjs";

export const DEFERRED_CHECKOUT_ORDER_PROOF_VERSION = "marketplace-deferred-checkout-order-proof/v1";

export function parseDeferredCheckoutOrderProofArgs(argv, env = process.env) {
  return {
    baseUrl:
      readOption(argv, "--base-url") ??
      readEnv("PRODUCTION_CHECKOUT_PROOF_BASE_URL", env) ??
      readEnv("PLATFORM_API_BASE_URL", env) ??
      "https://chasesets.com",
    requestPath: readOption(argv, "--request") ?? readEnv("DEFERRED_CHECKOUT_ORDER_PROOF_REQUEST", env),
    reference:
      readOption(argv, "--reference") ??
      readEnv("PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE", env) ??
      readEnv("PRODUCTION_MARKETPLACE_PROOF_REFERENCE", env),
    operator: readOption(argv, "--operator") ?? readEnv("DEFERRED_CHECKOUT_ORDER_PROOF_OPERATOR", env),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    allowProduction:
      readOption(argv, "--allow-production") ?? readEnv("DEFERRED_CHECKOUT_ORDER_PROOF_ALLOW_PRODUCTION", env),
    authorization: readEnv("PLATFORM_API_AUTHORIZATION", env),
    cookie: readEnv("PLATFORM_API_COOKIE", env),
  };
}

export async function readDeferredCheckoutOrderProofRequest(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function runDeferredCheckoutOrderProof(options, fetchImpl = globalThis.fetch) {
  validateDeferredCheckoutOrderProofOptions(options);
  const request = options.request ?? (await readDeferredCheckoutOrderProofRequest(options.requestPath));
  validateDeferredCheckoutOrderRequest(request);

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const headers = authHeaders(options);
  headers.set("Content-Type", "application/json");

  const started = await requestJson(fetchImpl, new URL("/api/marketplace/account/checkout-sessions", baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: request.source,
      shippingOption: request.shippingOption ?? "standard",
      optimizationGoal: request.optimizationGoal ?? "lowest-total",
    }),
  });
  assert(started.response.status === 201, statusFailureMessage("deferred checkout session creation", started, "201"));

  const sessionId = readNonEmptyString(started.body?.session_id, "checkout session id");
  const confirmed = await requestJson(
    fetchImpl,
    new URL(`/api/marketplace/account/checkout-sessions/${encodeURIComponent(sessionId)}/confirm`, baseUrl),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        shippingAddress: request.shippingAddress,
        fulfillmentPreviewRevision:
          typeof request.fulfillmentPreviewRevision === "string" ? request.fulfillmentPreviewRevision : null,
        acknowledgedMaterialChanges: true,
        deferPayment: true,
      }),
    },
  );
  assert(confirmed.response.status === 200, statusFailureMessage("deferred checkout confirmation", confirmed, "200"));

  const orderIds = normalizeOrderIds(confirmed.body?.order_ids ?? confirmed.body?.orderIds);
  assert(orderIds.length > 0, "Deferred checkout confirmation did not return order ids.");

  return buildDeferredCheckoutOrderProofEvidence({
    reference: options.reference,
    operator: options.operator,
    checkedAt: options.checkedAt,
    baseUrl,
    proofInputReference: request.proofInputReference,
    sourceType: request.source?.type ?? request.sourceType ?? "buy-now",
    shippingOption: request.shippingOption ?? "standard",
    checkoutSessionId: sessionId,
    orderIds,
    confirmStatus: confirmed.body?.status ?? "orders-created",
  });
}

export function buildDeferredCheckoutOrderProofEvidence(input) {
  const errors = [];
  if (!isNonEmptyString(input.reference)) {
    errors.push("Deferred checkout order proof requires a production proof reference.");
  } else {
    validateEvidenceReference("Deferred checkout order proof reference", input.reference, errors);
  }
  if (!isNonEmptyString(input.operator)) {
    errors.push("Deferred checkout order proof requires an operator.");
  }
  if (!isNonEmptyString(input.checkedAt) || Number.isNaN(new Date(input.checkedAt).getTime())) {
    errors.push("Deferred checkout order proof checkedAt must be an ISO timestamp.");
  }
  if (!isProductionChaseSetsUrl(input.baseUrl)) {
    errors.push("Deferred checkout order proof must target https://chasesets.com or https://admin.chasesets.com.");
  }
  if (!isNonEmptyString(input.proofInputReference)) {
    errors.push("Deferred checkout order proof requires proofInputReference.");
  } else {
    validateEvidenceReference("Deferred checkout order proof proofInputReference", input.proofInputReference, errors);
  }
  if (!isNonEmptyString(input.checkoutSessionId)) {
    errors.push("Deferred checkout order proof requires checkoutSessionId.");
  }
  if (!Array.isArray(input.orderIds) || input.orderIds.length === 0) {
    errors.push("Deferred checkout order proof must create at least one order id.");
  } else {
    const normalizedOrderIds = input.orderIds.map((orderId) => String(orderId).trim()).filter(Boolean);
    if (normalizedOrderIds.length !== input.orderIds.length) {
      errors.push("Deferred checkout order proof orderIds must be non-empty strings.");
    }
    if (new Set(normalizedOrderIds).size !== normalizedOrderIds.length) {
      errors.push("Deferred checkout order proof orderIds must be unique.");
    }
  }
  if (input.confirmStatus !== "orders-created") {
    errors.push("Deferred checkout order proof confirmStatus must be orders-created.");
  }

  return {
    schemaVersion: DEFERRED_CHECKOUT_ORDER_PROOF_VERSION,
    reference: input.reference,
    operator: input.operator,
    checkedAt: input.checkedAt,
    baseUrl: input.baseUrl,
    proofInputReference: input.proofInputReference,
    sourceType: input.sourceType,
    shippingOption: input.shippingOption,
    checkoutSessionId: input.checkoutSessionId,
    orderIds: input.orderIds,
    orderIdsCsv: input.orderIds.join(","),
    confirmStatus: input.confirmStatus,
    passesDeferredCheckoutOrderProofGate: errors.length === 0,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

async function main(argv, env = process.env) {
  const options = parseDeferredCheckoutOrderProofArgs(argv, env);
  try {
    const evidence = await runDeferredCheckoutOrderProof(options);
    console.log(JSON.stringify(evidence, null, 2));
    if (!evidence.passesDeferredCheckoutOrderProofGate) {
      console.error("Deferred checkout order proof did not satisfy the production proof gate.");
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function validateDeferredCheckoutOrderProofOptions(options) {
  if (!options.requestPath && !options.request) {
    throw new Error("DEFERRED_CHECKOUT_ORDER_PROOF_REQUEST or --request is required.");
  }
  if (!isNonEmptyString(options.reference)) {
    throw new Error(
      "PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE, PRODUCTION_MARKETPLACE_PROOF_REFERENCE, or --reference is required.",
    );
  }
  if (!isNonEmptyString(options.operator)) {
    throw new Error("DEFERRED_CHECKOUT_ORDER_PROOF_OPERATOR or --operator is required.");
  }
  if (!options.authorization && !options.cookie) {
    throw new Error("Set PLATFORM_API_AUTHORIZATION or PLATFORM_API_COOKIE for the operator-controlled account.");
  }
  if (isProductionChaseSetsUrl(options.baseUrl) && normalizeBoolean(options.allowProduction) !== true) {
    throw new Error("Set DEFERRED_CHECKOUT_ORDER_PROOF_ALLOW_PRODUCTION=true before creating production order ids.");
  }
}

function validateDeferredCheckoutOrderRequest(request) {
  if (!isRecord(request)) {
    throw new Error("Deferred checkout order proof request must be a JSON object.");
  }
  if (!isRecord(request.source)) {
    throw new Error("Deferred checkout order proof request requires source.");
  }
  if (!isRecord(request.shippingAddress)) {
    throw new Error("Deferred checkout order proof request requires shippingAddress.");
  }
  for (const key of ["catalogItemId", "productId", "itemTitle"]) {
    if (!isNonEmptyString(request.source[key])) {
      throw new Error(`Deferred checkout order proof source.${key} is required.`);
    }
  }
  if (Number(request.source.quantity ?? 0) <= 0) {
    throw new Error("Deferred checkout order proof source.quantity must be greater than 0.");
  }
  for (const key of ["name", "line1", "city", "state", "postalCode", "country"]) {
    if (!isNonEmptyString(request.shippingAddress[key])) {
      throw new Error(`Deferred checkout order proof shippingAddress.${key} is required.`);
    }
  }
}

async function requestJson(fetchImpl, url, init) {
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

function authHeaders(options) {
  const headers = new Headers();
  if (options.authorization) {
    headers.set("Authorization", options.authorization);
  }
  if (options.cookie) {
    headers.set("Cookie", options.cookie);
  }
  return headers;
}

function statusFailureMessage(label, result, expected) {
  const detail = result.body && typeof result.body === "object" ? JSON.stringify(result.body).slice(0, 500) : "";
  return (
    `Expected ${label} to return ${expected}, got ${result.response.status}.` + (detail ? ` Response: ${detail}` : "")
  );
}

function normalizeOrderIds(value) {
  return Array.isArray(value)
    ? value
        .map(String)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function isProductionChaseSetsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["chasesets.com", "admin.chasesets.com"].includes(url.hostname);
  } catch {
    return false;
  }
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readNonEmptyString(value, label) {
  if (!isNonEmptyString(value)) {
    throw new Error(`Expected ${label} to be returned.`);
  }
  return value.trim();
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

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
