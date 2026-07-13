#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";
import { normalizeRouteMatrixDeployWindow } from "./read-consistency-route-matrix-deploy-window.mjs";
import { DEFAULT_ROUTE_MATRIX_ROUTES } from "./read-consistency-route-matrix-evidence.mjs";

export const READ_CONSISTENCY_ROUTE_MATRIX_SAMPLER_VERSION = "read-consistency-route-matrix-sampler/v1";

const CHECKOUT_ROUTE_TEMPLATE = "/checkout/buy/session/:sessionId";
const ACCOUNT_CART_ROUTE_TEMPLATE = "/account/cart";
const SENSITIVE_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /https?:\/\/[^\s"']+/gi,
  /\b(?:afterWrite|postWriteToken|readAfterWrite)=\S+/gi,
  /\bBearer\s+[A-Za-z0-9._-]+/gi,
  /chase_sets_(?:session|guest_checkout)=[^;\s"']+/gi,
  /\b(?:acc|acct|account|usr|user|cart|crt|chk|pay|pyo|po|lst|listing|ord|order|evt|event|inv|inventory|offer|off|sale)_[0-9A-Za-z_:-]+\b/g,
];

export function parseReadConsistencyRouteMatrixSamplerArgs(argv, env = process.env) {
  return {
    environment: readOption(argv, "--environment") ?? readEnv("ROUTE_MATRIX_SAMPLER_ENVIRONMENT", env) ?? "staging",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    checkoutProbePath:
      readOption(argv, "--checkout-probe-file") ?? readEnv("ROUTE_MATRIX_SAMPLER_CHECKOUT_PROBE_FILE", env),
    accountCartProbePath:
      readOption(argv, "--account-cart-probe-file") ?? readEnv("ROUTE_MATRIX_SAMPLER_ACCOUNT_CART_PROBE_FILE", env),
    deployWindowPath:
      readOption(argv, "--deploy-window-file") ?? readEnv("ROUTE_MATRIX_SAMPLER_DEPLOY_WINDOW_FILE", env),
    outPath:
      readOption(argv, "--out") ??
      readEnv("READ_CONSISTENCY_ROUTE_MATRIX_SAMPLER_OUT", env) ??
      "artifacts/wake-drills/read-consistency-route-matrix-sampler.json",
  };
}

export async function runReadConsistencyRouteMatrixSampler(options = {}) {
  const checkoutProbe = await readOptionalJson(options.checkoutProbePath);
  const accountCartProbe = await readOptionalJson(options.accountCartProbePath);
  const deployWindow = normalizeRouteMatrixDeployWindow(await readOptionalJson(options.deployWindowPath));
  const routes = DEFAULT_ROUTE_MATRIX_ROUTES.map((route) => {
    const sample = buildRouteSample(route.routeTemplate, checkoutProbe, accountCartProbe);
    return annotateDeployWindowSample(sample, deployWindow);
  });
  const artifact = buildRouteMatrixSamplerArtifact({
    environment: options.environment,
    checkedAt: options.checkedAt,
    routes,
    deployWindow,
  });
  const leaks = assertRouteMatrixSamplerRedacted(artifact);
  if (leaks.length > 0) {
    throw new Error(`Route-matrix sampler evidence leaked sensitive values: ${leaks.join(", ")}`);
  }
  if (options.outPath) {
    await writeJsonRecord(options.outPath, artifact);
  }
  return artifact;
}

export function buildRouteMatrixSamplerArtifact(input) {
  const routes = input.routes.map(normalizeRouteSample);
  return {
    schemaVersion: READ_CONSISTENCY_ROUTE_MATRIX_SAMPLER_VERSION,
    environment: normalizeString(input.environment) ?? "staging",
    checkedAt: input.checkedAt,
    summary: {
      routeCount: routes.length,
      sampledRouteCount: routes.filter((route) => route.status === "sampled").length,
      blockedRouteCount: routes.filter((route) => route.status === "blocked").length,
      failedRouteCount: routes.filter((route) => route.status === "failed").length,
      skippedRouteCount: routes.filter((route) => route.status === "skipped").length,
      allRoutesSampled: routes.every((route) => route.status === "sampled"),
    },
    ...(input.deployWindow ? { deployWindow: normalizeRouteMatrixDeployWindow(input.deployWindow) } : {}),
    routes,
    redaction: {
      supportSafe: true,
      rawUrls: "not-written",
      accountIds: "not-written",
      sessionIds: "not-written",
      paymentIds: "not-written",
      payoutIds: "not-written",
      listingIds: "not-written",
      orderIds: "not-written",
      eventIds: "not-written",
      emails: "not-written",
      cookies: "not-written",
      tokens: "not-written",
      receipts: "not-written",
      providerReferences: "not-written",
      itemDetails: "not-written",
    },
  };
}

export function buildRouteSample(routeTemplate, checkoutProbe, accountCartProbe) {
  if (routeTemplate === CHECKOUT_ROUTE_TEMPLATE) {
    return checkoutRouteSample(checkoutProbe);
  }

  if (routeTemplate === ACCOUNT_CART_ROUTE_TEMPLATE) {
    return accountCartRouteSample(accountCartProbe);
  }

  if (routeTemplate === "/account/sell-list") {
    return blockedRouteSample({
      routeTemplate,
      driver: "automatic",
      sourceJourney: "sell-list-selected-offer-handoff",
      outcomeCategory: "sell-list-source-unavailable",
      blockerCategory: "representative-state-required",
    });
  }

  if (routeTemplate === "/account/payouts/:payoutId") {
    return blockedRouteSample({
      routeTemplate,
      driver: "representative-commerce-state",
      sourceJourney: "payout-ready-return",
      outcomeCategory: "payout-ready-private-state-required",
      blockerCategory: "private-payout-state-required",
    });
  }

  if (routeTemplate === "/account/payments/:paymentId") {
    return blockedRouteSample({
      routeTemplate,
      driver: "representative-commerce-state",
      sourceJourney: "pending-payment-sale",
      outcomeCategory: "payment-target-private-state-required",
      blockerCategory: "private-payment-state-required",
    });
  }

  if (routeTemplate === "/account/listings/:listingId") {
    return blockedRouteSample({
      routeTemplate,
      driver: "representative-commerce-state",
      sourceJourney: "owned-listing-freshness",
      outcomeCategory: "owned-listing-private-state-required",
      blockerCategory: "private-listing-state-required",
    });
  }

  return blockedRouteSample({
    routeTemplate,
    driver: "operator",
    sourceJourney: "unknown",
    outcomeCategory: "route-not-classified",
    blockerCategory: "route-not-classified",
  });
}

function accountCartRouteSample(accountCartProbe) {
  if (!accountCartProbe) {
    return blockedRouteSample({
      routeTemplate: ACCOUNT_CART_ROUTE_TEMPLATE,
      driver: "automatic",
      sourceJourney: "account-cart-consistency-probe",
      outcomeCategory: "account-cart-probe-missing",
      blockerCategory: "redacted-account-cart-observation-required",
    });
  }

  const promotionDecision = normalizeCategory(accountCartProbe.promotionDecision);
  const observedOutcomes = Array.isArray(accountCartProbe.observedOutcomes)
    ? accountCartProbe.observedOutcomes.map(normalizeCategory).filter(Boolean)
    : [];
  if (promotionDecision === "promote") {
    return {
      routeTemplate: ACCOUNT_CART_ROUTE_TEMPLATE,
      driver: "automatic",
      status: "sampled",
      outcomeCategory: "sampled",
      sourceJourney: "account-cart-consistency-probe",
      attemptCount: 1,
      probeDecision: promotionDecision,
      probeFinalState: "pass",
      blockerCategory: null,
    };
  }

  return {
    routeTemplate: ACCOUNT_CART_ROUTE_TEMPLATE,
    driver: "automatic",
    status: "failed",
    outcomeCategory: "account-cart-probe-failed",
    sourceJourney: "account-cart-consistency-probe",
    attemptCount: observedOutcomes.length > 0 ? 1 : 0,
    probeDecision: promotionDecision ?? "unknown",
    probeFinalState: observedOutcomes[0] ?? "unknown",
    blockerCategory: "account-cart-probe-failed",
  };
}

function checkoutRouteSample(checkoutProbe) {
  if (!checkoutProbe) {
    return blockedRouteSample({
      routeTemplate: CHECKOUT_ROUTE_TEMPLATE,
      driver: "automatic",
      sourceJourney: "guest-buy-now-freshness-probe",
      outcomeCategory: "checkout-probe-missing",
      blockerCategory: "checkout-probe-missing",
    });
  }

  const promotionDecision = normalizeCategory(checkoutProbe.promotionDecision);
  const finalState = normalizeCategory(checkoutProbe.finalState);
  const attemptCount = normalizeAttemptCount(checkoutProbe);
  if (promotionDecision === "promote" || promotionDecision === "warn") {
    return {
      routeTemplate: CHECKOUT_ROUTE_TEMPLATE,
      driver: "automatic",
      status: "sampled",
      outcomeCategory: promotionDecision === "warn" ? "sampled-with-slo-warning" : "sampled",
      sourceJourney: "guest-buy-now-freshness-probe",
      attemptCount,
      probeDecision: promotionDecision,
      probeFinalState: finalState,
      blockerCategory: null,
    };
  }

  return {
    routeTemplate: CHECKOUT_ROUTE_TEMPLATE,
    driver: "automatic",
    status: "failed",
    outcomeCategory: "checkout-probe-failed",
    sourceJourney: "guest-buy-now-freshness-probe",
    attemptCount,
    probeDecision: promotionDecision ?? "unknown",
    probeFinalState: finalState,
    blockerCategory: "checkout-probe-failed",
  };
}

function blockedRouteSample(input) {
  return {
    routeTemplate: input.routeTemplate,
    driver: input.driver,
    status: "blocked",
    outcomeCategory: input.outcomeCategory,
    sourceJourney: input.sourceJourney,
    attemptCount: 0,
    probeDecision: null,
    probeFinalState: null,
    blockerCategory: input.blockerCategory,
  };
}

function normalizeRouteSample(route) {
  return {
    routeTemplate: sanitizeRouteTemplate(route.routeTemplate),
    driver: normalizeEnum(route.driver, ["automatic", "representative-commerce-state", "operator"], "operator"),
    status: normalizeEnum(route.status, ["sampled", "blocked", "failed", "skipped"], "blocked"),
    outcomeCategory: normalizeCategory(route.outcomeCategory) ?? "unknown",
    sourceJourney: normalizeCategory(route.sourceJourney) ?? "unknown",
    attemptCount: normalizeNonNegativeInteger(route.attemptCount),
    probeDecision: normalizeCategory(route.probeDecision),
    probeFinalState: normalizeCategory(route.probeFinalState),
    blockerCategory: normalizeCategory(route.blockerCategory),
  };
}

function annotateDeployWindowSample(route, deployWindow) {
  if (deployWindow?.status !== "active" || route.status === "blocked") {
    return route;
  }

  return {
    ...route,
    status: "skipped",
    outcomeCategory: "deploy-window-active",
    attemptCount: 0,
    probeDecision: null,
    probeFinalState: null,
    blockerCategory: "active-deploy-window",
  };
}

export function assertRouteMatrixSamplerRedacted(evidence) {
  const serialized = JSON.stringify(evidence);
  const leaks = [];
  for (const pattern of SENSITIVE_PATTERNS) {
    const match = serialized.match(pattern);
    if (match) {
      leaks.push(...match);
    }
  }
  return [...new Set(leaks)];
}

async function readOptionalJson(path) {
  if (!normalizeString(path)) {
    return null;
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function normalizeAttemptCount(probe) {
  if (Array.isArray(probe?.attempts)) {
    return probe.attempts.length;
  }
  return normalizeNonNegativeInteger(probe?.attemptCount ?? probe?.maxAttempts ?? 1);
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = normalizeCategory(value);
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeCategory(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  return normalized.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 120) || null;
}

function sanitizeRouteTemplate(value) {
  const routeTemplate = normalizeString(value) ?? "";
  return routeTemplate
    .split("/")
    .map((part) => {
      if (!part || part.startsWith(":")) {
        return part;
      }
      if (/^[a-z]{2,12}_[A-Za-z0-9]+$/.test(part) || /^[0-9A-Fa-f-]{12,}$/.test(part)) {
        return ":id";
      }
      return part;
    })
    .join("/")
    .replace(/[^A-Za-z0-9_./:-]+/g, "_")
    .slice(0, 160);
}

function normalizeNonNegativeInteger(value) {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function main(argv, env = process.env) {
  try {
    const artifact = await runReadConsistencyRouteMatrixSampler(parseReadConsistencyRouteMatrixSamplerArgs(argv, env));
    console.log(JSON.stringify(artifact, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
