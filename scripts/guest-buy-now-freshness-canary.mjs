#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const GUEST_BUY_NOW_FRESHNESS_CANARY_VERSION = "guest-buy-now-freshness-canary/v1";
export const CANARY_STATES = Object.freeze(["pass", "temporary", "fail"]);
export const PRODUCTION_FEASIBILITY_DECISION = Object.freeze({
  feasible: false,
  decision: "not-feasible",
  reason:
    "Production guest Buy Now browser canary would create persistent guest checkout artifacts without a payment/order cleanup contract. Keep production on synthetic endpoint smoke and run the symptom-level guest Buy Now canary against staging.",
});

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_CONTACT_NAME = "Guest Buy Now Canary";
const DEFAULT_GUEST_EMAIL = "guest-buy-now-canary@chasesets.test";
const DEFAULT_SEARCH_QUERY = "charizard";
const RAW_AFTER_WRITE_PATTERN = /afterWrite=[^&\s")]+/gi;
const CHECKOUT_SESSION_ID_PATTERN = /\bchk_[0-9A-Za-z_:-]+\b/g;
const GUEST_COOKIE_PATTERN = /chase_sets_guest_checkout=[^;\s]+/gi;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function parseGuestBuyNowCanaryArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("GUEST_BUY_NOW_CANARY_OUT", env),
    baseUrl: readOption(argv, "--base-url") ?? readEnv("GUEST_BUY_NOW_CANARY_BASE_URL", env),
    itemPath: readOption(argv, "--item-path") ?? readEnv("GUEST_BUY_NOW_CANARY_ITEM_PATH", env),
    searchQuery:
      readOption(argv, "--search-query") ?? readEnv("GUEST_BUY_NOW_CANARY_SEARCH_QUERY", env) ?? DEFAULT_SEARCH_QUERY,
    fixtureKey: readOption(argv, "--fixture-key") ?? readEnv("GUEST_BUY_NOW_CANARY_FIXTURE_KEY", env),
    guestEmail: readOption(argv, "--guest-email") ?? readEnv("GUEST_BUY_NOW_CANARY_GUEST_EMAIL", env),
    contactName:
      readOption(argv, "--contact-name") ?? readEnv("GUEST_BUY_NOW_CANARY_CONTACT_NAME", env) ?? DEFAULT_CONTACT_NAME,
    environment: readOption(argv, "--environment") ?? readEnv("GUEST_BUY_NOW_CANARY_ENVIRONMENT", env) ?? "staging",
    timeoutMs: normalizePositiveInteger(
      readOption(argv, "--timeout-ms") ?? readEnv("GUEST_BUY_NOW_CANARY_TIMEOUT_MS", env),
      DEFAULT_TIMEOUT_MS,
    ),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    diagnosticCorrelationId:
      readOption(argv, "--diagnostic-correlation-id") ??
      readEnv("GUEST_BUY_NOW_CANARY_CORRELATION_ID", env) ??
      createDiagnosticCorrelationId(),
    headless: readBoolean(readOption(argv, "--headed") ?? readEnv("GUEST_BUY_NOW_CANARY_HEADED", env)) ? false : true,
  };
}

export function validateGuestBuyNowCanaryOptions(options) {
  const errors = [];
  if (!normalizeUrl(options.baseUrl)) {
    errors.push("GUEST_BUY_NOW_CANARY_BASE_URL or --base-url is required.");
  }
  if (!normalizePath(options.itemPath) && !normalizeString(options.searchQuery)) {
    errors.push(
      "GUEST_BUY_NOW_CANARY_ITEM_PATH/--item-path or GUEST_BUY_NOW_CANARY_SEARCH_QUERY/--search-query is required.",
    );
  }
  if (!normalizeString(options.fixtureKey)) {
    errors.push("GUEST_BUY_NOW_CANARY_FIXTURE_KEY or --fixture-key is required.");
  }
  if (!normalizeString(options.guestEmail)) {
    errors.push("GUEST_BUY_NOW_CANARY_GUEST_EMAIL or --guest-email is required.");
  }
  if (String(options.environment ?? "").toLowerCase() === "production") {
    errors.push(PRODUCTION_FEASIBILITY_DECISION.reason);
  }
  return errors;
}

export function classifyGuestBuyNowObservation(observation) {
  if (observation.permanentNotFoundVisible || /Checkout session not found/i.test(observation.pageText ?? "")) {
    return {
      finalState: "fail",
      promotionDecision: "abort",
      failureReason: "permanent-checkout-session-not-found",
    };
  }
  if (!observation.afterWritePresent) {
    return {
      finalState: "fail",
      promotionDecision: "abort",
      failureReason: "missing-after-write",
    };
  }
  if (!observation.guestCookiePresent) {
    return {
      finalState: "fail",
      promotionDecision: "abort",
      failureReason: "missing-guest-cookie",
    };
  }
  if (observation.temporaryRecoveryVisible || /Preparing checkout|Refresh checkout/i.test(observation.pageText ?? "")) {
    return {
      finalState: "temporary",
      promotionDecision: "promote",
      failureReason: null,
    };
  }
  if (
    observation.checkoutReviewVisible ||
    /Continue to payment|Checkout Summary|Payable total/i.test(observation.pageText ?? "")
  ) {
    return {
      finalState: "pass",
      promotionDecision: "promote",
      failureReason: null,
    };
  }
  return {
    finalState: "fail",
    promotionDecision: "abort",
    failureReason: "checkout-review-state-not-detected",
  };
}

export function buildGuestBuyNowCanaryEvidence(input) {
  const classification = classifyGuestBuyNowObservation(input.observation ?? {});
  return {
    schemaVersion: GUEST_BUY_NOW_FRESHNESS_CANARY_VERSION,
    checkedAt: input.checkedAt,
    environment: normalizeString(input.environment) ?? "staging",
    fixtureKey: normalizeString(input.fixtureKey) ?? "",
    diagnosticCorrelationId: sanitizeDiagnosticCorrelationId(input.diagnosticCorrelationId),
    finalState: classification.finalState,
    promotionDecision: classification.promotionDecision,
    failureReason: classification.failureReason,
    latencyMs: normalizeNonNegativeInteger(input.observation?.latencyMs ?? 0),
    waitMode: normalizeWaitMode(input.observation?.waitMode),
    afterWritePresent: Boolean(input.observation?.afterWritePresent),
    guestCookiePresent: Boolean(input.observation?.guestCookiePresent),
    permanentNotFoundVisible: Boolean(input.observation?.permanentNotFoundVisible),
    temporaryRecoveryVisible: Boolean(input.observation?.temporaryRecoveryVisible),
    checkoutReviewVisible: Boolean(input.observation?.checkoutReviewVisible),
    paymentOrOrderSideEffects: "not-attempted",
    redaction: {
      guestEmail: "redacted",
      contactName: "redacted",
      guestToken: "redacted",
      cookie: "redacted",
      afterWrite: "redacted",
      checkoutSessionId: "redacted",
      accountIds: "redacted",
      eventIds: "redacted",
      fullUrls: "redacted",
    },
    productionFeasibility: PRODUCTION_FEASIBILITY_DECISION,
  };
}

export function assertRedactedEvidence(evidence) {
  const serialized = JSON.stringify(evidence);
  const leaks = [];
  for (const pattern of [RAW_AFTER_WRITE_PATTERN, CHECKOUT_SESSION_ID_PATTERN, GUEST_COOKIE_PATTERN, EMAIL_PATTERN]) {
    const match = serialized.match(pattern);
    if (match) {
      leaks.push(...match);
    }
  }
  return [...new Set(leaks)];
}

export async function runGuestBuyNowFreshnessCanary(options) {
  const errors = validateGuestBuyNowCanaryOptions(options);
  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }

  const observation =
    typeof options.observe === "function" ? await options.observe(options) : await observeGuestBuyNowCheckout(options);
  const evidence = buildGuestBuyNowCanaryEvidence({
    checkedAt: options.checkedAt,
    environment: options.environment,
    fixtureKey: options.fixtureKey,
    diagnosticCorrelationId: options.diagnosticCorrelationId,
    observation,
  });
  const leaks = assertRedactedEvidence(evidence);
  if (leaks.length > 0) {
    throw new Error(`Guest Buy Now canary evidence leaked sensitive values: ${leaks.join(", ")}`);
  }

  if (options.outPath) {
    await mkdir(dirname(options.outPath), { recursive: true });
    await writeFile(options.outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  }

  return evidence;
}

async function observeGuestBuyNowCheckout(options) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: options.headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  const baseUrl = normalizeUrl(options.baseUrl);

  try {
    const itemPath = await resolveGuestBuyNowItemPath(options);
    const itemUrl = new URL(itemPath, baseUrl);
    await page.goto(itemUrl.toString(), { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    await page
      .locator(
        'button[type="submit"][name="intent"][value="buy-this-listing"]:not([disabled]), button[type="submit"][name="intent"][value="buy-now"]:not([disabled])',
      )
      .first()
      .click({ timeout: options.timeoutMs });
    await page.waitForURL(/\/checkout\/start/, { timeout: options.timeoutMs });
    await page.getByLabel(/contact name/i).fill(options.contactName);
    await page.getByLabel(/email/i).fill(options.guestEmail);
    const startedAt = Date.now();
    await page.getByRole("button", { name: /continue as guest/i }).click({ timeout: options.timeoutMs });
    await page.waitForURL(/\/checkout\/chk_/, { timeout: options.timeoutMs });
    await page.waitForLoadState("domcontentloaded", { timeout: options.timeoutMs });

    const finalUrl = new URL(page.url());
    const cookies = await context.cookies(baseUrl);
    const pageText = await page
      .locator("body")
      .innerText({ timeout: options.timeoutMs })
      .catch(() => "");
    const waitMode = detectWaitMode(pageText);
    const observation = {
      latencyMs: Date.now() - startedAt,
      afterWritePresent: finalUrl.searchParams.has("afterWrite"),
      guestCookiePresent: cookies.some((cookie) => cookie.name === "chase_sets_guest_checkout"),
      permanentNotFoundVisible: /Checkout session not found|We could not find this checkout session/i.test(pageText),
      temporaryRecoveryVisible: /Preparing checkout|Refresh checkout/i.test(pageText),
      checkoutReviewVisible: /Continue to payment|Checkout Summary|Payable total/i.test(pageText),
      waitMode,
      pageText,
    };

    return observation;
  } finally {
    await browser.close();
  }
}

export async function resolveGuestBuyNowItemPath(options, fetchImpl = fetch) {
  const configuredPath = normalizePath(options.itemPath);
  if (configuredPath) {
    return configuredPath;
  }

  const baseUrl = normalizeUrl(options.baseUrl);
  const searchQuery = normalizeString(options.searchQuery);
  if (!baseUrl || !searchQuery) {
    throw new Error("Guest Buy Now canary requires a base URL and either an item path or search query.");
  }

  const searchUrl = new URL("/api/marketplace/items", baseUrl);
  searchUrl.searchParams.set("q", searchQuery);
  searchUrl.searchParams.set("includeTotal", "true");
  const response = await fetchImpl(searchUrl);
  if (!response.ok) {
    throw new Error(`Guest Buy Now canary fixture search failed with HTTP ${response.status}.`);
  }

  const body = await response.json();
  const candidates = (Array.isArray(body?.items) ? body.items : []).filter((candidate) => {
    const summary = candidate?.market_summary;
    return (
      normalizeString(candidate?.slug) &&
      Number(summary?.active_listing_count ?? 0) > 0 &&
      Number(summary?.total_visible_quantity ?? 0) > 0
    );
  });

  for (const candidate of candidates) {
    const detailUrl = new URL(`/api/marketplace/items/${encodeURIComponent(candidate.slug)}`, baseUrl);
    const detailResponse = await fetchImpl(detailUrl);
    if (!detailResponse.ok) {
      continue;
    }

    const path = pathFromBuyableDetail(candidate.slug, await detailResponse.json());
    if (path) {
      return path;
    }
  }

  throw new Error(`Guest Buy Now canary found no active buyable marketplace item for search query '${searchQuery}'.`);
}

function pathFromBuyableDetail(slug, detail) {
  const listing = (Array.isArray(detail?.market_listings) ? detail.market_listings : []).find(
    (candidate) =>
      normalizeString(candidate?.listing_id) &&
      String(candidate?.status ?? "").toLowerCase() === "active" &&
      Number(candidate?.visible_quantity ?? candidate?.quantity_cap ?? 0) > 0,
  );
  if (!listing) {
    return null;
  }

  const params = new URLSearchParams({ market: "buy" });
  for (const selection of Array.isArray(listing.selected_options) ? listing.selected_options : []) {
    const dimensionId = normalizeString(selection?.dimensionId);
    const optionId = normalizeString(selection?.optionId);
    if (dimensionId && optionId) {
      params.append(`dimension.${dimensionId}`, optionId);
    }
  }

  return `/items/${slug}?${params.toString()}`;
}

function detectWaitMode(text) {
  if (/exact-dependency/i.test(text)) {
    return "exact-dependency";
  }
  if (/target-context/i.test(text)) {
    return "target-context";
  }
  return null;
}

function sanitizeDiagnosticCorrelationId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, "-")
    .slice(0, 80);
}

function createDiagnosticCorrelationId() {
  return `guest-buy-now-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeWaitMode(value) {
  return value === "exact-dependency" || value === "target-context" ? value : null;
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function normalizePath(value) {
  const text = normalizeString(value);
  if (!text) {
    return null;
  }
  return text.startsWith("/") ? text : `/${text}`;
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePositiveInteger(value, fallback) {
  const normalized = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

function normalizeNonNegativeInteger(value) {
  const normalized = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : 0;
}

function readBoolean(value) {
  return /^(1|true|yes)$/i.test(String(value ?? "").trim());
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

async function main(argv, env = process.env) {
  try {
    const options = parseGuestBuyNowCanaryArgs(argv, env);
    const evidence = await runGuestBuyNowFreshnessCanary({
      ...options,
      guestEmail: options.guestEmail ?? DEFAULT_GUEST_EMAIL,
    });
    console.log(JSON.stringify(evidence, null, 2));
    return evidence.finalState === "fail" ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
