#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const GUEST_BUY_NOW_FRESHNESS_CANARY_VERSION = "guest-buy-now-freshness-canary/v2";
export const CANARY_STATES = Object.freeze(["pass", "temporary", "fail"]);
export const CANARY_FLOWS = Object.freeze(["guest", "account"]);
export const DEFAULT_READY_SLO_MS = 10_000;
export const DEFAULT_MAX_ATTEMPTS = 1;
export const PRODUCTION_FEASIBILITY_DECISION = Object.freeze({
  feasible: false,
  decision: "production-proof-mode-only",
  reason:
    "Public production guest Buy Now browser canary remains not feasible: it would create persistent guest checkout artifacts without a payment/order cleanup contract. Production Buy Now readiness evidence comes from the authenticated proof-mode canary on the permission-gated proof marketplace host (--environment production-proof), which stops at checkout review and never confirms payment.",
});
export const SEGMENT_METRIC_REFERENCES = Object.freeze({
  joinKey: "diagnosticCorrelationId",
  routeTemplate: "/account/checkout-sessions/:sessionId",
  projectionGroup: "checkout.session-projection",
  freshnessAuditRecordType: "read-after-write.freshness",
  wakeStatusEndpoint: "/api/platform/projections/wake-status",
  wakePipelineDashboard: "chase-sets-projection-wake-pipeline",
  serverSegments: Object.freeze([
    "commit-to-notify",
    "notify-to-relay",
    "relay-to-control-plane-store",
    "control-plane-claim-to-worker",
    "checkpoint-readiness",
    "route-wait",
  ]),
  interpretationRunbook: "docs/runbooks/guest-buy-now-freshness-canary.md",
});

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_CONTACT_NAME = "Guest Buy Now Canary";
const DEFAULT_GUEST_EMAIL = "guest-buy-now-canary@chasesets.test";
const DEFAULT_SEARCH_QUERY = "charizard";
const MAX_ATTEMPT_LIMIT = 10;
const MAX_FIXTURE_CANDIDATES = 20;
const READY_POLL_INTERVAL_MS = 250;
const SLO_MODES = ["warn", "gate"];
// The 10s ready budget is an interim value pending the #1237 numeric SLO/load
// proof. Until it is ratified, SLO-exceeded results with a user-safe final
// state warn instead of aborting the release (issue #1323). Unsafe states
// (permanent not-found, missing after-write/cookies, platform errors,
// negative-probe failures) always abort regardless of mode.
const DEFAULT_SLO_MODE = "warn";
const RAW_AFTER_WRITE_PATTERN = /afterWrite=[^&\s")]+/gi;
const CHECKOUT_SESSION_ID_PATTERN = /\bchk_[0-9A-Za-z_:-]+\b/g;
const GUEST_COOKIE_PATTERN = /chase_sets_guest_checkout=[^;\s]+/gi;
const SESSION_COOKIE_PATTERN = /chase_sets_session=[^;\s]+/gi;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PLATFORM_ERROR_PATTERN = /Error code:\s*(?:502|503|504)|Well,\s*This is unexpected/i;
const PERMANENT_NOT_FOUND_PATTERN = /Checkout session not found|We could not find this checkout session/i;
const PERMANENT_RECOVERY_PATTERN =
  /Checkout session not found|We could not find this checkout session|Checkout access required/i;
const TEMPORARY_RECOVERY_PATTERN = /Preparing checkout|Refresh checkout/i;
const CHECKOUT_START_RECOVERY_PATTERN =
  /Checkout needs attention|We could not start checkout from the current cart or item/i;
const CHECKOUT_REVIEW_PATTERN = /Continue to payment|Checkout Summary|Payable total/i;
const BUY_READINESS_URL_PATTERN = /\/checkout\/buy\/readiness(?:[/?#]|$)/;
const BUY_SESSION_URL_PATTERN = /\/checkout\/buy\/session\/chk_[^/?#]+(?:[/?#]|$)/;

export function isBuyReadinessUrl(value) {
  return BUY_READINESS_URL_PATTERN.test(String(value ?? ""));
}

export function isBuySessionUrl(value) {
  return BUY_SESSION_URL_PATTERN.test(String(value ?? ""));
}

export function isCheckoutSessionDocumentResponseUrl(value) {
  return isBuySessionUrl(value);
}

export function buyNowRouteTransitionWaitOptions(timeoutMs) {
  return {
    waitUntil: "commit",
    timeout: normalizePositiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS),
  };
}

export function parseGuestBuyNowCanaryArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("GUEST_BUY_NOW_CANARY_OUT", env),
    baseUrl: readOption(argv, "--base-url") ?? readEnv("GUEST_BUY_NOW_CANARY_BASE_URL", env),
    flow: readOption(argv, "--flow") ?? readEnv("GUEST_BUY_NOW_CANARY_FLOW", env) ?? "guest",
    itemPath: readOption(argv, "--item-path") ?? readEnv("GUEST_BUY_NOW_CANARY_ITEM_PATH", env),
    searchQuery:
      readOption(argv, "--search-query") ?? readEnv("GUEST_BUY_NOW_CANARY_SEARCH_QUERY", env) ?? DEFAULT_SEARCH_QUERY,
    fixtureKey: readOption(argv, "--fixture-key") ?? readEnv("GUEST_BUY_NOW_CANARY_FIXTURE_KEY", env),
    guestEmail: readOption(argv, "--guest-email") ?? readEnv("GUEST_BUY_NOW_CANARY_GUEST_EMAIL", env),
    contactName:
      readOption(argv, "--contact-name") ?? readEnv("GUEST_BUY_NOW_CANARY_CONTACT_NAME", env) ?? DEFAULT_CONTACT_NAME,
    accountEmail:
      readOption(argv, "--account-email") ??
      readEnv("GUEST_BUY_NOW_CANARY_ACCOUNT_EMAIL", env) ??
      readEnv("MARKETPLACE_E2E_EMAIL", env),
    accountPassword:
      readOption(argv, "--account-password") ??
      readEnv("GUEST_BUY_NOW_CANARY_ACCOUNT_PASSWORD", env) ??
      readEnv("MARKETPLACE_E2E_PASSWORD", env),
    environment: readOption(argv, "--environment") ?? readEnv("GUEST_BUY_NOW_CANARY_ENVIRONMENT", env) ?? "staging",
    productionProofReference:
      readOption(argv, "--production-proof-reference") ??
      readEnv("GUEST_BUY_NOW_CANARY_PRODUCTION_PROOF_REFERENCE", env),
    timeoutMs: normalizePositiveInteger(
      readOption(argv, "--timeout-ms") ?? readEnv("GUEST_BUY_NOW_CANARY_TIMEOUT_MS", env),
      DEFAULT_TIMEOUT_MS,
    ),
    readySloMs: normalizePositiveInteger(
      readOption(argv, "--ready-slo-ms") ?? readEnv("GUEST_BUY_NOW_CANARY_READY_SLO_MS", env),
      DEFAULT_READY_SLO_MS,
    ),
    sloMode: readOption(argv, "--slo-mode") ?? readEnv("GUEST_BUY_NOW_CANARY_SLO_MODE", env) ?? DEFAULT_SLO_MODE,
    maxAttempts: Math.min(
      normalizePositiveInteger(
        readOption(argv, "--attempts") ?? readEnv("GUEST_BUY_NOW_CANARY_ATTEMPTS", env),
        DEFAULT_MAX_ATTEMPTS,
      ),
      MAX_ATTEMPT_LIMIT,
    ),
    skipNegativeProbe:
      readFlag(argv, "--skip-negative-probe") || readBoolean(readEnv("GUEST_BUY_NOW_CANARY_SKIP_NEGATIVE_PROBE", env)),
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
  const flow = normalizeFlow(options.flow ?? "guest");
  const environment = String(options.environment ?? "").toLowerCase();
  if (!flow) {
    errors.push(`GUEST_BUY_NOW_CANARY_FLOW or --flow must be one of: ${CANARY_FLOWS.join(", ")}.`);
  }
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
  if (options.sloMode !== undefined && !SLO_MODES.includes(options.sloMode)) {
    errors.push(`GUEST_BUY_NOW_CANARY_SLO_MODE or --slo-mode must be one of: ${SLO_MODES.join(", ")}.`);
  }
  if (flow === "guest" && !normalizeString(options.guestEmail)) {
    errors.push("GUEST_BUY_NOW_CANARY_GUEST_EMAIL or --guest-email is required for the guest flow.");
  }
  if (environment === "production") {
    errors.push(PRODUCTION_FEASIBILITY_DECISION.reason);
  }
  if (environment === "production-proof") {
    if (flow !== "account") {
      errors.push(
        "Production proof mode gates the marketplace host behind operator sign-in; only --flow account can run there.",
      );
    }
    if (!normalizeString(options.accountEmail) || !normalizeString(options.accountPassword)) {
      errors.push(
        "Production proof mode requires configured operator credentials (GUEST_BUY_NOW_CANARY_ACCOUNT_EMAIL/PASSWORD); synthetic account registration is not allowed in production.",
      );
    }
    if (!normalizeString(options.productionProofReference)) {
      errors.push(
        "Production proof mode requires GUEST_BUY_NOW_CANARY_PRODUCTION_PROOF_REFERENCE or --production-proof-reference (the approved proof-mode evidence reference).",
      );
    }
  }
  return errors;
}

export function classifyGuestBuyNowObservation(observation, gate = {}) {
  const flow = normalizeFlow(gate.flow) ?? "guest";
  const readySloMs = normalizePositiveInteger(gate.readySloMs, DEFAULT_READY_SLO_MS);
  const sloMode = SLO_MODES.includes(gate.sloMode) ? gate.sloMode : DEFAULT_SLO_MODE;
  const pageText = observation.pageText ?? "";

  if (observation.runtimeFailureReason) {
    return abort("fail", observation.runtimeFailureReason);
  }
  if (observation.permanentNotFoundVisible || PERMANENT_NOT_FOUND_PATTERN.test(pageText)) {
    return abort("fail", "permanent-checkout-session-not-found");
  }
  if (observation.checkoutStartRecoveryVisible || CHECKOUT_START_RECOVERY_PATTERN.test(pageText)) {
    return abort("fail", "checkout-start-recovery-visible");
  }
  if (!observation.afterWritePresent) {
    return abort("fail", "missing-after-write");
  }
  if (flow === "guest" && !observation.guestCookiePresent) {
    return abort("fail", "missing-guest-cookie");
  }
  if (flow === "account" && !observation.sessionCookiePresent) {
    return abort("fail", "missing-session-cookie");
  }
  if (observation.platformErrorVisible || PLATFORM_ERROR_PATTERN.test(pageText)) {
    return abort("fail", "platform-error-page-detected");
  }

  const readyLatencyMs = resolveReadyLatencyMs(observation);
  let readiness;
  if (readyLatencyMs !== null && readyLatencyMs <= readySloMs) {
    readiness = { finalState: "pass", promotionDecision: "promote", failureReason: null };
  } else if (readyLatencyMs !== null) {
    readiness = sloExceeded("pass", sloMode);
  } else if (observation.temporaryRecoveryVisible || TEMPORARY_RECOVERY_PATTERN.test(pageText)) {
    readiness = sloExceeded("temporary", sloMode);
  } else {
    readiness = abort("fail", "checkout-review-state-not-detected");
  }

  const probeFailureReason = classifyNegativeProbe(observation.negativeProbe);
  if (readiness.promotionDecision !== "abort" && probeFailureReason) {
    return abort(readiness.finalState, probeFailureReason);
  }
  return readiness;
}

function abort(finalState, failureReason) {
  return { finalState, promotionDecision: "abort", failureReason };
}

function sloExceeded(finalState, sloMode) {
  return {
    finalState,
    promotionDecision: sloMode === "gate" ? "abort" : "warn",
    failureReason: "checkout-ready-slo-exceeded",
  };
}

function resolveReadyLatencyMs(observation) {
  const measured = normalizeOptionalNonNegativeInteger(observation.readyLatencyMs);
  if (measured !== null) {
    return measured;
  }
  if (observation.checkoutReviewVisible || CHECKOUT_REVIEW_PATTERN.test(observation.pageText ?? "")) {
    return normalizeNonNegativeInteger(observation.latencyMs ?? 0);
  }
  return null;
}

function classifyNegativeProbe(probe) {
  if (!probe || probe.attempted === false) {
    return null;
  }
  const documentStatus = normalizeHttpStatus(probe.documentStatus);
  if (probe.platformErrorVisible || (documentStatus !== null && documentStatus >= 500)) {
    return "negative-probe-platform-error";
  }
  if (probe.temporaryRecoveryVisible || probe.checkoutReviewVisible) {
    return "negative-probe-masked-invalid-session";
  }
  if (!probe.permanentRecoveryVisible) {
    return "negative-probe-unexpected-state";
  }
  return null;
}

export function buildGuestBuyNowCanaryEvidence(input) {
  const flow = normalizeFlow(input.flow) ?? "guest";
  const readySloMs = normalizePositiveInteger(input.readySloMs, DEFAULT_READY_SLO_MS);
  const sloMode = SLO_MODES.includes(input.sloMode) ? input.sloMode : DEFAULT_SLO_MODE;
  const observation = input.observation ?? {};
  const classification = classifyGuestBuyNowObservation(observation, { flow, readySloMs, sloMode });
  return {
    schemaVersion: GUEST_BUY_NOW_FRESHNESS_CANARY_VERSION,
    checkedAt: input.checkedAt,
    environment: normalizeString(input.environment) ?? "staging",
    flow,
    fixtureKey: normalizeString(input.fixtureKey) ?? "",
    diagnosticCorrelationId: sanitizeDiagnosticCorrelationId(input.diagnosticCorrelationId),
    productionProofReference: normalizeString(input.productionProofReference),
    finalState: classification.finalState,
    promotionDecision: classification.promotionDecision,
    failureReason: classification.failureReason,
    readySloMs,
    sloMode,
    readyLatencyMs: resolveReadyLatencyMs(observation),
    latencyMs: normalizeNonNegativeInteger(observation.latencyMs ?? 0),
    segments: {
      writeToRedirectMs: normalizeOptionalNonNegativeInteger(observation.segments?.writeToRedirectMs),
      redirectToDocumentMs: normalizeOptionalNonNegativeInteger(observation.segments?.redirectToDocumentMs),
      documentToReadyMs: normalizeOptionalNonNegativeInteger(observation.segments?.documentToReadyMs),
      writeToCheckoutReadyMs: normalizeOptionalNonNegativeInteger(observation.segments?.writeToCheckoutReadyMs),
    },
    segmentReferences: SEGMENT_METRIC_REFERENCES,
    waitMode: normalizeWaitMode(observation.waitMode),
    afterWritePresent: Boolean(observation.afterWritePresent),
    guestCookiePresent: Boolean(observation.guestCookiePresent),
    sessionCookiePresent: Boolean(observation.sessionCookiePresent),
    permanentNotFoundVisible: Boolean(observation.permanentNotFoundVisible),
    checkoutStartRecoveryVisible: Boolean(observation.checkoutStartRecoveryVisible),
    temporaryRecoveryVisible: Boolean(observation.temporaryRecoveryVisible),
    temporaryRecoveryObserved: Boolean(observation.temporaryRecoveryObserved || observation.temporaryRecoveryVisible),
    checkoutReviewVisible: Boolean(observation.checkoutReviewVisible),
    platformErrorVisible: Boolean(observation.platformErrorVisible),
    checkoutDocumentStatus: normalizeHttpStatus(observation.checkoutDocumentStatus),
    stateWaitOutcome: normalizeStateWaitOutcome(observation.stateWaitOutcome),
    runtimeFailure: normalizeRuntimeFailure(observation),
    negativeProbe: normalizeNegativeProbe(observation.negativeProbe),
    paymentOrOrderSideEffects: "not-attempted",
    redaction: {
      guestEmail: "redacted",
      contactName: "redacted",
      guestToken: "redacted",
      accountEmail: "redacted",
      accountPassword: "redacted",
      sessionToken: "redacted",
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

function normalizeRuntimeFailure(observation) {
  if (!observation.runtimeFailureReason) {
    return null;
  }

  return {
    stage: normalizeString(observation.runtimeFailureStage) ?? "unknown",
    reason: normalizeString(observation.runtimeFailureReason) ?? "browser-runtime-error",
    message: normalizeString(observation.runtimeFailureMessage) ?? null,
  };
}

function normalizeNegativeProbe(probe) {
  if (!probe || probe.attempted === false) {
    return { attempted: false, outcome: "skipped" };
  }
  const failureReason = classifyNegativeProbe(probe);
  return {
    attempted: true,
    documentStatus: normalizeHttpStatus(probe.documentStatus),
    permanentRecoveryVisible: Boolean(probe.permanentRecoveryVisible),
    temporaryRecoveryVisible: Boolean(probe.temporaryRecoveryVisible),
    checkoutReviewVisible: Boolean(probe.checkoutReviewVisible),
    platformErrorVisible: Boolean(probe.platformErrorVisible),
    outcome: failureReason ?? "permanent-recovery",
  };
}

export function assertRedactedEvidence(evidence) {
  const serialized = JSON.stringify(evidence);
  const leaks = [];
  for (const pattern of [
    RAW_AFTER_WRITE_PATTERN,
    CHECKOUT_SESSION_ID_PATTERN,
    GUEST_COOKIE_PATTERN,
    SESSION_COOKIE_PATTERN,
    EMAIL_PATTERN,
  ]) {
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

  const maxAttempts = Math.min(normalizePositiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS), MAX_ATTEMPT_LIMIT);
  const observe = typeof options.observe === "function" ? options.observe : observeBuyNowCheckout;
  const attemptSummaries = [];
  let evidence = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const observation = await observe(options, attempt).catch((error) => runtimeFailureObservation(error));
    evidence = buildGuestBuyNowCanaryEvidence({
      checkedAt: options.checkedAt,
      environment: options.environment,
      flow: options.flow,
      fixtureKey: options.fixtureKey,
      diagnosticCorrelationId: options.diagnosticCorrelationId,
      productionProofReference: options.productionProofReference,
      readySloMs: options.readySloMs,
      sloMode: options.sloMode,
      observation,
    });
    attemptSummaries.push({
      attempt,
      finalState: evidence.finalState,
      promotionDecision: evidence.promotionDecision,
      failureReason: evidence.failureReason,
      readyLatencyMs: evidence.readyLatencyMs,
    });

    if (evidence.promotionDecision === "promote" || !retryableCanaryFailure(evidence.failureReason)) {
      break;
    }
  }

  evidence = { ...evidence, attemptCount: attemptSummaries.length, maxAttempts, attemptSummaries };

  const leaks = assertRedactedEvidence(evidence);
  if (leaks.length > 0) {
    throw new Error(`Guest Buy Now canary evidence leaked sensitive values: ${leaks.join(", ")}`);
  }

  if (options.outPath) {
    await writeJsonRecord(options.outPath, evidence);
  }

  return evidence;
}

function retryableCanaryFailure(failureReason) {
  return (
    failureReason === "checkout-ready-slo-exceeded" ||
    failureReason === "browser-navigation-timeout" ||
    failureReason === "platform-temporary-unavailable"
  );
}

function runtimeFailureObservation(error) {
  const runtimeFailure = normalizeRuntimeError(error);
  return {
    latencyMs: 0,
    readyLatencyMs: null,
    segments: {},
    afterWritePresent: false,
    guestCookiePresent: false,
    sessionCookiePresent: false,
    permanentNotFoundVisible: false,
    checkoutStartRecoveryVisible: false,
    temporaryRecoveryVisible: false,
    temporaryRecoveryObserved: false,
    checkoutReviewVisible: false,
    platformErrorVisible: false,
    checkoutDocumentStatus: null,
    stateWaitOutcome: runtimeFailure.reason === "browser-navigation-timeout" ? "timed-out" : null,
    waitMode: null,
    pageText: "",
    runtimeFailureReason: runtimeFailure.reason,
    runtimeFailureStage: runtimeFailure.stage,
    runtimeFailureMessage: runtimeFailure.message,
    negativeProbe: { attempted: false },
  };
}

async function observeBuyNowCheckout(options) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: options.headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  const baseUrl = normalizeUrl(options.baseUrl);
  const flow = normalizeFlow(options.flow) ?? "guest";
  let stage = "initialize-browser";
  const checkoutDocumentStatuses = [];
  page.on("response", (response) => {
    if (response.request().resourceType() !== "document") {
      return;
    }
    try {
      if (isCheckoutSessionDocumentResponseUrl(response.url())) {
        checkoutDocumentStatuses.push(response.status());
      }
    } catch {
      // Ignore non-URL response identifiers from browser internals.
    }
  });

  try {
    let fixtureFetch;
    if (flow === "account") {
      stage = "start-account-session";
      await startAccountSession(page, context, options, baseUrl);
      fixtureFetch = createPageRequestFetch(page);
    }

    stage = "resolve-buy-now-fixture";
    const fixtureCandidates = await resolveGuestBuyNowItemCandidates(options, fixtureFetch ?? fetch, {
      requireCheckoutReady: flow === "account",
    });
    let checkoutStartRecoveryObservation = null;

    for (const fixtureCandidate of fixtureCandidates) {
      const itemUrl = new URL(fixtureCandidate.path, baseUrl);
      stage = "load-buy-now-item-page";
      await page.goto(itemUrl.toString(), { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
      const buyNowButton = page
        .locator(
          'button[type="submit"][name="intent"][value="buy-this-listing"]:not([disabled]), button[type="submit"][name="intent"][value="buy-now"]:not([disabled])',
        )
        .first();

      let startedAt;
      if (flow === "account") {
        startedAt = Date.now();
        stage = "click-account-buy-now";
        await buyNowButton.click({ timeout: options.timeoutMs });
      } else {
        stage = "click-guest-buy-now";
        await buyNowButton.click({ timeout: options.timeoutMs });
        stage = "wait-guest-buy-readiness";
        await page.waitForURL(BUY_READINESS_URL_PATTERN, buyNowRouteTransitionWaitOptions(options.timeoutMs));
        stage = "fill-guest-contact";
        await page.getByLabel(/contact name/i).fill(options.contactName);
        await page.getByLabel(/email/i).fill(options.guestEmail);
        startedAt = Date.now();
        stage = "submit-guest-contact";
        await page.getByRole("button", { name: /continue as guest/i }).click({ timeout: options.timeoutMs });
      }

      stage = "wait-buy-checkout-session";
      const sessionStart = await waitForBuyCheckoutSessionStart(page, startedAt, options.timeoutMs);
      if (sessionStart.kind === "checkout-start-recovery") {
        checkoutStartRecoveryObservation = await checkoutStartRecoveryObservationFromPage({
          context,
          baseUrl,
          page,
          sessionStart,
          startedAt,
          checkoutDocumentStatuses,
        });
        continue;
      }
      const redirectedAt = sessionStart.observedAt;
      stage = "load-checkout-session-document";
      await page.waitForLoadState("domcontentloaded", { timeout: options.timeoutMs });
      const documentAt = Date.now();
      stage = "watch-checkout-readiness";
      const readiness = await watchCheckoutReadiness(page, startedAt, options.readySloMs);

      const finalUrl = new URL(page.url());
      const cookies = await context.cookies(baseUrl);
      const pageText = readiness.pageText;
      const waitMode = detectWaitMode(pageText);
      const observation = {
        latencyMs: Date.now() - startedAt,
        readyLatencyMs: readiness.readyAt === null ? null : readiness.readyAt - startedAt,
        segments: {
          writeToRedirectMs: redirectedAt - startedAt,
          redirectToDocumentMs: documentAt - redirectedAt,
          documentToReadyMs: readiness.readyAt === null ? null : readiness.readyAt - documentAt,
          writeToCheckoutReadyMs: readiness.readyAt === null ? null : readiness.readyAt - startedAt,
        },
        afterWritePresent: finalUrl.searchParams.has("afterWrite"),
        guestCookiePresent: cookies.some((cookie) => cookie.name === "chase_sets_guest_checkout"),
        sessionCookiePresent: cookies.some((cookie) => cookie.name === "chase_sets_session"),
        permanentNotFoundVisible: PERMANENT_NOT_FOUND_PATTERN.test(pageText),
        checkoutStartRecoveryVisible: CHECKOUT_START_RECOVERY_PATTERN.test(pageText),
        temporaryRecoveryVisible: TEMPORARY_RECOVERY_PATTERN.test(pageText),
        temporaryRecoveryObserved: readiness.temporaryRecoveryObserved,
        checkoutReviewVisible: CHECKOUT_REVIEW_PATTERN.test(pageText),
        platformErrorVisible: PLATFORM_ERROR_PATTERN.test(pageText),
        checkoutDocumentStatus: checkoutDocumentStatuses.at(-1) ?? null,
        stateWaitOutcome: readiness.stateWaitOutcome,
        waitMode,
        pageText,
        negativeProbe: options.skipNegativeProbe
          ? { attempted: false }
          : await runNegativeProbe(page, baseUrl, options),
      };

      return observation;
    }

    if (checkoutStartRecoveryObservation) {
      return checkoutStartRecoveryObservation;
    }

    throw new Error("Guest Buy Now canary found no checkout-ready marketplace fixture candidates.");
  } catch (error) {
    throw canaryRuntimeError(stage, error);
  } finally {
    await browser.close();
  }
}

async function checkoutStartRecoveryObservationFromPage({
  context,
  baseUrl,
  page,
  sessionStart,
  startedAt,
  checkoutDocumentStatuses,
}) {
  const cookies = await context.cookies(baseUrl);
  const finalUrl = new URL(page.url());
  const pageText = sessionStart.pageText;
  return {
    latencyMs: sessionStart.observedAt - startedAt,
    readyLatencyMs: null,
    segments: {
      writeToRedirectMs: null,
      redirectToDocumentMs: null,
      documentToReadyMs: null,
      writeToCheckoutReadyMs: null,
    },
    afterWritePresent: finalUrl.searchParams.has("afterWrite"),
    guestCookiePresent: cookies.some((cookie) => cookie.name === "chase_sets_guest_checkout"),
    sessionCookiePresent: cookies.some((cookie) => cookie.name === "chase_sets_session"),
    permanentNotFoundVisible: PERMANENT_NOT_FOUND_PATTERN.test(pageText),
    checkoutStartRecoveryVisible: CHECKOUT_START_RECOVERY_PATTERN.test(pageText),
    temporaryRecoveryVisible: TEMPORARY_RECOVERY_PATTERN.test(pageText),
    temporaryRecoveryObserved: TEMPORARY_RECOVERY_PATTERN.test(pageText),
    checkoutReviewVisible: CHECKOUT_REVIEW_PATTERN.test(pageText),
    platformErrorVisible: PLATFORM_ERROR_PATTERN.test(pageText),
    checkoutDocumentStatus: checkoutDocumentStatuses.at(-1) ?? null,
    stateWaitOutcome: "matched",
    waitMode: detectWaitMode(pageText),
    pageText,
    negativeProbe: { attempted: false },
  };
}

function canaryRuntimeError(stage, error) {
  const failure = normalizeRuntimeError(error, stage);
  const runtimeError = new Error(failure.message ?? failure.reason);
  runtimeError.stage = failure.stage;
  runtimeError.reason = failure.reason;
  return runtimeError;
}

async function startAccountSession(page, context, options, baseUrl) {
  const accountEmail = normalizeString(options.accountEmail);
  const accountPassword = normalizeString(options.accountPassword);
  let sessionToken;
  if (accountEmail && accountPassword) {
    const response = await page.request.post(`${baseUrl}/api/auth/password-sign-in`, {
      data: { email: accountEmail, password: accountPassword },
    });
    if (response.status() !== 200) {
      throw canaryHttpError(`Buy Now canary account sign-in failed with HTTP ${response.status()}.`, response.status());
    }
    sessionToken = (await response.json())?.sessionToken;
  } else {
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const response = await page.request.post(`${baseUrl}/api/auth/register`, {
      data: {
        displayName: `Buy Now Canary Account ${nonce}`,
        email: `buy-now-canary+account-${nonce}@chasesets.test`,
        password: `buy-now-canary-${nonce}`,
      },
    });
    if (response.status() !== 201) {
      throw canaryHttpError(
        `Buy Now canary synthetic account registration failed with HTTP ${response.status()}.`,
        response.status(),
      );
    }
    sessionToken = (await response.json())?.sessionToken;
  }

  if (!sessionToken) {
    throw new Error("Buy Now canary account session did not return a session token.");
  }

  await context.addCookies([
    {
      name: "chase_sets_session",
      value: sessionToken,
      url: baseUrl,
      httpOnly: true,
      sameSite: "Lax",
      secure: baseUrl.startsWith("https://"),
    },
  ]);
}

function canaryHttpError(message, status) {
  const error = new Error(message);
  if (Number(status) >= 500) {
    error.reason = "platform-temporary-unavailable";
  }
  return error;
}

function createPageRequestFetch(page) {
  return async (url, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    const headers = init.headers && typeof init.headers === "object" ? init.headers : undefined;
    const requestOptions = headers ? { headers } : {};
    let response;
    if (method === "POST") {
      response = await page.request.post(String(url), {
        ...requestOptions,
        data: parseFetchBody(init.body),
      });
    } else {
      response = await page.request.get(String(url), requestOptions);
    }
    return {
      ok: response.ok(),
      status: response.status(),
      json: () => response.json(),
    };
  };
}

function parseFetchBody(body) {
  if (typeof body !== "string") {
    return body;
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

async function waitForBuyCheckoutSessionStart(page, startedAt, timeoutMs) {
  const deadline = Date.now() + normalizePositiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS);
  let pageText = "";

  while (Date.now() <= deadline) {
    if (BUY_SESSION_URL_PATTERN.test(page.url())) {
      return { kind: "checkout-session", observedAt: Date.now() };
    }

    pageText = await page
      .locator("body")
      .innerText({ timeout: READY_POLL_INTERVAL_MS * 4 })
      .catch(() => pageText);
    if (CHECKOUT_START_RECOVERY_PATTERN.test(pageText)) {
      return { kind: "checkout-start-recovery", observedAt: Date.now(), pageText };
    }

    await page.waitForTimeout(READY_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for Buy Now checkout session after ${Date.now() - startedAt}ms at ${page.url()}.`);
}

async function watchCheckoutReadiness(page, startedAt, readySloMs) {
  const deadline = startedAt + normalizePositiveInteger(readySloMs, DEFAULT_READY_SLO_MS);
  let temporaryRecoveryObserved = false;
  let knownStateObserved = false;
  let readyAt = null;
  let pageText = "";

  for (;;) {
    pageText = await page
      .locator("body")
      .innerText({ timeout: READY_POLL_INTERVAL_MS * 4 })
      .catch(() => pageText);

    if (CHECKOUT_REVIEW_PATTERN.test(pageText)) {
      knownStateObserved = true;
      readyAt = Date.now();
      break;
    }
    if (PERMANENT_NOT_FOUND_PATTERN.test(pageText) || PLATFORM_ERROR_PATTERN.test(pageText)) {
      knownStateObserved = true;
      break;
    }
    if (TEMPORARY_RECOVERY_PATTERN.test(pageText)) {
      knownStateObserved = true;
      temporaryRecoveryObserved = true;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await page.waitForTimeout(READY_POLL_INTERVAL_MS);
  }

  return {
    readyAt,
    temporaryRecoveryObserved,
    stateWaitOutcome: knownStateObserved ? "matched" : "timed-out",
    pageText,
  };
}

async function runNegativeProbe(page, baseUrl, options) {
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const probeUrl = new URL(`/checkout/buy/session/chk_canary_negative_probe_${nonce}`, baseUrl);
  const response = await page
    .goto(probeUrl.toString(), { waitUntil: "domcontentloaded", timeout: options.timeoutMs })
    .catch(() => null);
  // Give the route a bounded moment to settle on a recovery state before sampling.
  await page
    .locator("body")
    .waitFor({ state: "visible", timeout: options.timeoutMs })
    .catch(() => {});
  await page
    .waitForFunction(
      (patternSource) => new RegExp(patternSource, "i").test(document.body?.innerText ?? ""),
      `${PERMANENT_RECOVERY_PATTERN.source}|${TEMPORARY_RECOVERY_PATTERN.source}|${CHECKOUT_REVIEW_PATTERN.source}|${PLATFORM_ERROR_PATTERN.source}`,
      { timeout: 10_000 },
    )
    .catch(() => {});
  const pageText = await page
    .locator("body")
    .innerText({ timeout: options.timeoutMs })
    .catch(() => "");

  return {
    attempted: true,
    documentStatus: response?.status() ?? null,
    permanentRecoveryVisible: PERMANENT_RECOVERY_PATTERN.test(pageText),
    temporaryRecoveryVisible: TEMPORARY_RECOVERY_PATTERN.test(pageText),
    checkoutReviewVisible: CHECKOUT_REVIEW_PATTERN.test(pageText),
    platformErrorVisible: PLATFORM_ERROR_PATTERN.test(pageText),
  };
}

export async function resolveGuestBuyNowItemPath(options, fetchImpl = fetch) {
  const candidates = await resolveGuestBuyNowItemCandidates(options, fetchImpl, {
    requireCheckoutReady: Boolean(options.requireCheckoutReady),
  });
  return candidates[0]?.path;
}

export async function resolveGuestBuyNowItemCandidates(options, fetchImpl = fetch, resolverOptions = {}) {
  const configuredPath = normalizePath(options.itemPath);
  if (configuredPath) {
    return [{ path: configuredPath }];
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

  const buyNowCandidates = [];
  for (const candidate of candidates) {
    const detailUrl = new URL(`/api/marketplace/items/${encodeURIComponent(candidate.slug)}`, baseUrl);
    const detailResponse = await fetchImpl(detailUrl);
    if (!detailResponse.ok) {
      continue;
    }

    buyNowCandidates.push(...buyNowCandidatesFromDetail(candidate.slug, await detailResponse.json()));
    if (buyNowCandidates.length >= MAX_FIXTURE_CANDIDATES) {
      break;
    }
  }

  const boundedCandidates = buyNowCandidates.slice(0, MAX_FIXTURE_CANDIDATES);
  if (resolverOptions.requireCheckoutReady) {
    const checkoutReadyCandidates = [];
    for (const candidate of boundedCandidates) {
      if (await isCheckoutReadyFixtureCandidate(baseUrl, candidate, fetchImpl)) {
        checkoutReadyCandidates.push(candidate);
      }
    }
    if (checkoutReadyCandidates.length > 0) {
      return checkoutReadyCandidates;
    }
  } else if (boundedCandidates.length > 0) {
    return boundedCandidates;
  }

  throw new Error(`Guest Buy Now canary found no active buyable marketplace item for search query '${searchQuery}'.`);
}

function buyNowCandidatesFromDetail(slug, detail) {
  return (Array.isArray(detail?.market_listings) ? detail.market_listings : [])
    .filter(
      (candidate) =>
        normalizeString(candidate?.listing_id) &&
        normalizeString(candidate?.catalog_catalog_item_id) &&
        normalizeString(candidate?.product_id) &&
        String(candidate?.status ?? "").toLowerCase() === "active" &&
        Number(candidate?.price_amount ?? 0) >= 0 &&
        Array.isArray(candidate?.selected_options) &&
        Number(candidate?.visible_quantity ?? candidate?.quantity_cap ?? 0) > 0,
    )
    .map((listing) => ({
      path: pathFromBuyableListing(slug, listing),
      previewRequest: checkoutPreviewRequestForListing(listing),
    }));
}

function pathFromBuyableListing(slug, listing) {
  const params = new URLSearchParams({ market: "buy", listing: normalizeString(listing?.listing_id) ?? "" });
  for (const selection of Array.isArray(listing.selected_options) ? listing.selected_options : []) {
    const dimensionId = normalizeString(selection?.dimensionId);
    const optionId = normalizeString(selection?.optionId);
    if (dimensionId && optionId) {
      params.append(`dimension.${dimensionId}`, optionId);
    }
  }

  return `/items/${slug}?${params.toString()}`;
}

function checkoutPreviewRequestForListing(listing) {
  const listingId = normalizeString(listing?.listing_id) ?? "";
  return {
    checkoutSessionId: `chk_canary_fixture_preview_${listingId.replace(/[^A-Za-z0-9_:-]/g, "_").slice(0, 80)}`,
    sourceType: "buy-now",
    shippingOption: "standard",
    optimizationGoal: "lowest-total",
    lines: [
      {
        listingId,
        cartLineId: null,
        catalogItemId: normalizeString(listing?.catalog_catalog_item_id) ?? "",
        productId: normalizeString(listing?.product_id) ?? "",
        itemTitle: normalizeString(listing?.item_title) ?? "",
        itemSubtitle: normalizeString(listing?.item_subtitle),
        selectedOptions: Array.isArray(listing?.selected_options) ? listing.selected_options : [],
        productSummary: normalizeString(listing?.product_summary),
        quantity: 1,
        fulfillmentMode: "locked-listing",
        lockedListingId: listingId,
        sellerPreferenceId: listingId,
      },
    ],
  };
}

async function isCheckoutReadyFixtureCandidate(baseUrl, candidate, fetchImpl) {
  const previewUrl = new URL("/api/marketplace/account/purchases/checkout/preview", baseUrl);
  const response = await fetchImpl(previewUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(candidate.previewRequest),
  });
  if (!response.ok) {
    return false;
  }

  const body = await response.json();
  return Array.isArray(body?.readyLineKeys) && body.readyLineKeys.length > 0;
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

function normalizeFlow(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return CANARY_FLOWS.includes(normalized) ? normalized : null;
}

function normalizeWaitMode(value) {
  return value === "exact-dependency" || value === "target-context" ? value : null;
}

function normalizeStateWaitOutcome(value) {
  return value === "matched" || value === "timed-out" ? value : null;
}

function normalizeRuntimeError(error, fallbackStage = "observe-buy-now-checkout") {
  const stage = normalizeString(error?.stage) ?? fallbackStage;
  const rawMessage = error instanceof Error ? error.message : String(error ?? "");
  const message = sanitizeRuntimeErrorMessage(rawMessage);
  return {
    stage,
    reason: /timeout/i.test(rawMessage)
      ? "browser-navigation-timeout"
      : (normalizeString(error?.reason) ?? "browser-runtime-error"),
    message,
  };
}

function sanitizeRuntimeErrorMessage(message) {
  return String(message ?? "")
    .replace(/https?:\/\/[^\s")]+/gi, "[redacted-url]")
    .replace(RAW_AFTER_WRITE_PATTERN, "afterWrite=[redacted]")
    .replace(CHECKOUT_SESSION_ID_PATTERN, "chk_[redacted]")
    .replace(GUEST_COOKIE_PATTERN, "chase_sets_guest_checkout=[redacted]")
    .replace(SESSION_COOKIE_PATTERN, "chase_sets_session=[redacted]")
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function normalizeHttpStatus(value) {
  const normalized = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(normalized) && normalized >= 100 && normalized <= 599 ? normalized : null;
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

function normalizePositiveInteger(value, fallback) {
  const normalized = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

function normalizeNonNegativeInteger(value) {
  const normalized = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : 0;
}

function normalizeOptionalNonNegativeInteger(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = Number.parseInt(String(value), 10);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : null;
}

function readBoolean(value) {
  return /^(1|true|yes)$/i.test(String(value ?? "").trim());
}

function readFlag(argv, name) {
  return argv.includes(name);
}

async function main(argv, env = process.env) {
  try {
    const options = parseGuestBuyNowCanaryArgs(argv, env);
    const evidence = await runGuestBuyNowFreshnessCanary({
      ...options,
      guestEmail: options.guestEmail ?? DEFAULT_GUEST_EMAIL,
    });
    console.log(JSON.stringify(evidence, null, 2));
    if (evidence.promotionDecision === "warn") {
      console.error(
        `WARNING: Buy Now freshness canary exceeded the ready SLO (${evidence.readySloMs}ms) with user-safe final state '${evidence.finalState}'. Recorded as a release-health warning; the release is not blocked (slo-mode=warn, ratified single-write SLO per docs/architecture/push-wake-slo-load-proof.md).`,
      );
    }
    return evidence.promotionDecision === "abort" ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
