#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const GUEST_BUY_NOW_FRESHNESS_PROBE_VERSION = "guest-buy-now-freshness-probe/v2";
export const PROBE_STATES = Object.freeze(["pass", "temporary", "fail"]);
export const PROBE_FLOWS = Object.freeze(["guest", "account"]);
export const DEFAULT_READY_SLO_MS = 10_000;
export const DEFAULT_MAX_ATTEMPTS = 1;
export const DEFAULT_WAKE_RUNTIME_READY_BUDGET_MS = 120_000;
export const DEFAULT_WAKE_RUNTIME_READY_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_PROJECTION_CONVERGENCE_BUDGET_MS = 300_000;
export const DEFAULT_PROJECTION_CONVERGENCE_POLL_INTERVAL_MS = 5_000;
export const PROJECTION_CONVERGENCE_GATE_VERSION = "guest-buy-now-projection-convergence-gate/v1";
// Setup-stage projection lag (the account flow's synthetic invitation waiting on
// the auth-identity-invitation-projection to catch up after a fleet rollout) is a
// transient post-restart catch-up condition, not a defect. It must consume the
// remaining attempt budget instead of aborting the probe on the first observation.
// Steady-state setup errors still surface once the budget is spent.
export const SETUP_STAGE_PROJECTION_LAG_FAILURE_REASON = "setup-stage-projection-lag";
export const PRODUCTION_FEASIBILITY_DECISION = Object.freeze({
  feasible: false,
  decision: "production-proof-mode-only",
  reason:
    "Public production guest Buy Now browser probe remains not feasible: it would create persistent guest checkout artifacts without a payment/order cleanup contract. Production Buy Now readiness evidence comes from the authenticated proof-mode probe on the permission-gated proof marketplace host (--environment production-proof), which stops at checkout review and never confirms payment.",
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
  interpretationRunbook: "docs/runbooks/guest-buy-now-freshness-probe.md",
});

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_CONTACT_NAME = "Guest Buy Now Probe";
const DEFAULT_GUEST_EMAIL = "guest-buy-now-probe@chasesets.test";
const DEFAULT_SEARCH_QUERY = "charizard";
const MAX_ATTEMPT_LIMIT = 10;
const MAX_FIXTURE_CANDIDATES = 20;
const READY_POLL_INTERVAL_MS = 250;
const SLO_MODES = ["warn", "gate"];
// The 10s ready budget is the ratified single-write readiness SLO (see
// docs/architecture/projection-freshness-slos.md). SLO-exceeded results with
// a user-safe final state warn instead of aborting the release
// unless --slo-mode gate is set. Unsafe states
// (permanent not-found, missing after-write/cookies, platform errors,
// negative-probe failures) always abort regardless of mode.
const DEFAULT_SLO_MODE = "warn";
const RAW_AFTER_WRITE_PATTERN = /afterWrite=[^&\s")]+/gi;
const RAW_POST_WRITE_TOKEN_PATTERN = /postWriteToken=[^&\s")]+/gi;
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
const CHASE_SETS_COMMIT_RECEIPT_HEADER = "chase-sets-commit-receipt";
const SYNTHETIC_INVITATION_PROJECTION_TIMEOUT_MS = 90_000;
const SYNTHETIC_INVITATION_PROJECTION_POLL_MS = 1_000;

export function isBuyReadinessUrl(value) {
  return BUY_READINESS_URL_PATTERN.test(String(value ?? ""));
}

export function isBuySessionUrl(value) {
  return BUY_SESSION_URL_PATTERN.test(String(value ?? ""));
}

export function isCheckoutSessionDocumentResponseUrl(value) {
  return isBuySessionUrl(value);
}

export function detectFreshWriteMetadata(url) {
  const searchParams = url instanceof URL ? url.searchParams : new URL(String(url ?? "")).searchParams;
  const afterWritePresent = searchParams.has("afterWrite");
  const postWriteTokenPresent = searchParams.has("postWriteToken");
  return {
    afterWritePresent,
    postWriteTokenPresent,
    freshWriteMetadataPresent: afterWritePresent || postWriteTokenPresent,
  };
}

export function buyNowRouteTransitionWaitOptions(timeoutMs) {
  return {
    waitUntil: "commit",
    timeout: normalizePositiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS),
  };
}

export function buyNowItemPageNavigationWaitOptions(timeoutMs) {
  return {
    waitUntil: "commit",
    timeout: normalizePositiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS),
  };
}

export function parseGuestBuyNowProbeArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("GUEST_BUY_NOW_PROBE_OUT", env),
    baseUrl: readOption(argv, "--base-url") ?? readEnv("GUEST_BUY_NOW_PROBE_BASE_URL", env),
    adminBaseUrl: readOption(argv, "--admin-base-url") ?? readEnv("GUEST_BUY_NOW_PROBE_ADMIN_BASE_URL", env),
    flow: readOption(argv, "--flow") ?? readEnv("GUEST_BUY_NOW_PROBE_FLOW", env) ?? "guest",
    itemPath: readOption(argv, "--item-path") ?? readEnv("GUEST_BUY_NOW_PROBE_ITEM_PATH", env),
    searchQuery:
      readOption(argv, "--search-query") ?? readEnv("GUEST_BUY_NOW_PROBE_SEARCH_QUERY", env) ?? DEFAULT_SEARCH_QUERY,
    fixtureKey: readOption(argv, "--fixture-key") ?? readEnv("GUEST_BUY_NOW_PROBE_FIXTURE_KEY", env),
    guestEmail: readOption(argv, "--guest-email") ?? readEnv("GUEST_BUY_NOW_PROBE_GUEST_EMAIL", env),
    contactName:
      readOption(argv, "--contact-name") ?? readEnv("GUEST_BUY_NOW_PROBE_CONTACT_NAME", env) ?? DEFAULT_CONTACT_NAME,
    accountEmail:
      readOption(argv, "--account-email") ??
      readEnv("GUEST_BUY_NOW_PROBE_ACCOUNT_EMAIL", env) ??
      readEnv("MARKETPLACE_E2E_EMAIL", env),
    accountPassword:
      readOption(argv, "--account-password") ??
      readEnv("GUEST_BUY_NOW_PROBE_ACCOUNT_PASSWORD", env) ??
      readEnv("MARKETPLACE_E2E_PASSWORD", env),
    adminEmail:
      readEnv("GUEST_BUY_NOW_PROBE_ADMIN_EMAIL", env) ??
      readEnv("PLATFORM_ADMIN_EMAIL", env) ??
      readEnv("TF_VAR_platform_admin_email", env),
    adminPassword:
      readEnv("GUEST_BUY_NOW_PROBE_ADMIN_PASSWORD", env) ??
      readEnv("PLATFORM_ADMIN_PASSWORD", env) ??
      readEnv("TF_VAR_platform_admin_password", env),
    environment: readOption(argv, "--environment") ?? readEnv("GUEST_BUY_NOW_PROBE_ENVIRONMENT", env) ?? "staging",
    productionProofReference:
      readOption(argv, "--production-proof-reference") ??
      readEnv("GUEST_BUY_NOW_PROBE_PRODUCTION_PROOF_REFERENCE", env),
    timeoutMs: normalizePositiveInteger(
      readOption(argv, "--timeout-ms") ?? readEnv("GUEST_BUY_NOW_PROBE_TIMEOUT_MS", env),
      DEFAULT_TIMEOUT_MS,
    ),
    readySloMs: normalizePositiveInteger(
      readOption(argv, "--ready-slo-ms") ?? readEnv("GUEST_BUY_NOW_PROBE_READY_SLO_MS", env),
      DEFAULT_READY_SLO_MS,
    ),
    sloMode: readOption(argv, "--slo-mode") ?? readEnv("GUEST_BUY_NOW_PROBE_SLO_MODE", env) ?? DEFAULT_SLO_MODE,
    maxAttempts: Math.min(
      normalizePositiveInteger(
        readOption(argv, "--attempts") ?? readEnv("GUEST_BUY_NOW_PROBE_ATTEMPTS", env),
        DEFAULT_MAX_ATTEMPTS,
      ),
      MAX_ATTEMPT_LIMIT,
    ),
    wakeRuntimeReadyBudgetMs: normalizeNonNegativeInteger(
      readOption(argv, "--wake-runtime-ready-budget-ms") ??
        readEnv("GUEST_BUY_NOW_PROBE_WAKE_RUNTIME_READY_BUDGET_MS", env) ??
        DEFAULT_WAKE_RUNTIME_READY_BUDGET_MS,
    ),
    wakeRuntimeReadyPollIntervalMs: normalizePositiveInteger(
      readOption(argv, "--wake-runtime-ready-poll-interval-ms") ??
        readEnv("GUEST_BUY_NOW_PROBE_WAKE_RUNTIME_READY_POLL_INTERVAL_MS", env),
      DEFAULT_WAKE_RUNTIME_READY_POLL_INTERVAL_MS,
    ),
    convergenceGate:
      readFlag(argv, "--convergence-gate") || readBoolean(readEnv("GUEST_BUY_NOW_PROBE_CONVERGENCE_GATE", env)),
    convergenceBudgetMs: normalizeNonNegativeInteger(
      readOption(argv, "--convergence-budget-ms") ??
        readEnv("GUEST_BUY_NOW_PROBE_CONVERGENCE_BUDGET_MS", env) ??
        DEFAULT_PROJECTION_CONVERGENCE_BUDGET_MS,
    ),
    convergencePollIntervalMs: normalizePositiveInteger(
      readOption(argv, "--convergence-poll-interval-ms") ??
        readEnv("GUEST_BUY_NOW_PROBE_CONVERGENCE_POLL_INTERVAL_MS", env),
      DEFAULT_PROJECTION_CONVERGENCE_POLL_INTERVAL_MS,
    ),
    convergenceProjectionNames:
      readOption(argv, "--convergence-projection-names") ??
      readEnv("GUEST_BUY_NOW_PROBE_CONVERGENCE_PROJECTION_NAMES", env),
    skipNegativeProbe:
      readFlag(argv, "--skip-negative-probe") || readBoolean(readEnv("GUEST_BUY_NOW_PROBE_SKIP_NEGATIVE_PROBE", env)),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    diagnosticCorrelationId:
      readOption(argv, "--diagnostic-correlation-id") ??
      readEnv("GUEST_BUY_NOW_PROBE_CORRELATION_ID", env) ??
      createDiagnosticCorrelationId(),
    headless: readBoolean(readOption(argv, "--headed") ?? readEnv("GUEST_BUY_NOW_PROBE_HEADED", env)) ? false : true,
  };
}

export function validateGuestBuyNowProbeOptions(options) {
  const errors = [];
  const flow = normalizeFlow(options.flow ?? "guest");
  const environment = String(options.environment ?? "").toLowerCase();
  if (!flow) {
    errors.push(`GUEST_BUY_NOW_PROBE_FLOW or --flow must be one of: ${PROBE_FLOWS.join(", ")}.`);
  }
  if (!normalizeUrl(options.baseUrl)) {
    errors.push("GUEST_BUY_NOW_PROBE_BASE_URL or --base-url is required.");
  }
  if (
    normalizeUrl(options.adminBaseUrl) &&
    (!normalizeString(options.adminEmail) || !normalizeString(options.adminPassword))
  ) {
    errors.push(
      "PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are required when --admin-base-url is set for wake-runtime preflight.",
    );
  }
  if (!normalizePath(options.itemPath) && !normalizeString(options.searchQuery)) {
    errors.push(
      "GUEST_BUY_NOW_PROBE_ITEM_PATH/--item-path or GUEST_BUY_NOW_PROBE_SEARCH_QUERY/--search-query is required.",
    );
  }
  if (!normalizeString(options.fixtureKey)) {
    errors.push("GUEST_BUY_NOW_PROBE_FIXTURE_KEY or --fixture-key is required.");
  }
  if (options.sloMode !== undefined && !SLO_MODES.includes(options.sloMode)) {
    errors.push(`GUEST_BUY_NOW_PROBE_SLO_MODE or --slo-mode must be one of: ${SLO_MODES.join(", ")}.`);
  }
  if (flow === "guest" && !normalizeString(options.guestEmail)) {
    errors.push("GUEST_BUY_NOW_PROBE_GUEST_EMAIL or --guest-email is required for the guest flow.");
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
        "Production proof mode requires configured operator credentials (GUEST_BUY_NOW_PROBE_ACCOUNT_EMAIL/PASSWORD); synthetic account registration is not allowed in production.",
      );
    }
    if (!normalizeString(options.productionProofReference)) {
      errors.push(
        "Production proof mode requires GUEST_BUY_NOW_PROBE_PRODUCTION_PROOF_REFERENCE or --production-proof-reference (the approved proof-mode evidence reference).",
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
  if (!freshWriteMetadataPresent(observation)) {
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
  } else if (
    observation.temporaryRecoveryVisible ||
    observation.temporaryRecoveryObserved ||
    TEMPORARY_RECOVERY_PATTERN.test(pageText)
  ) {
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

export function buildGuestBuyNowProbeEvidence(input) {
  const flow = normalizeFlow(input.flow) ?? "guest";
  const readySloMs = normalizePositiveInteger(input.readySloMs, DEFAULT_READY_SLO_MS);
  const sloMode = SLO_MODES.includes(input.sloMode) ? input.sloMode : DEFAULT_SLO_MODE;
  const observation = input.observation ?? {};
  const classification = classifyGuestBuyNowObservation(observation, { flow, readySloMs, sloMode });
  return {
    schemaVersion: GUEST_BUY_NOW_FRESHNESS_PROBE_VERSION,
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
    wakeRuntimePreflight: normalizeWakeRuntimePreflight(input.wakeRuntimePreflight),
    waitMode: normalizeWaitMode(observation.waitMode),
    afterWritePresent: Boolean(observation.afterWritePresent),
    postWriteTokenPresent: Boolean(observation.postWriteTokenPresent),
    freshWriteMetadataPresent: freshWriteMetadataPresent(observation),
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
    accountItemPageFallback: normalizeRuntimeFallback(observation.accountItemPageFallback),
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
      postWriteToken: "redacted",
      checkoutSessionId: "redacted",
      accountIds: "redacted",
      eventIds: "redacted",
      fullUrls: "redacted",
    },
    productionFeasibility: PRODUCTION_FEASIBILITY_DECISION,
  };
}

function normalizeWakeRuntimePreflight(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    attempted: Boolean(value.attempted),
    ready: value.ready === true ? true : value.ready === false ? false : null,
    readyAfterMs: normalizeOptionalNonNegativeInteger(value.readyAfterMs),
    sampleCount: normalizeNonNegativeInteger(value.sampleCount),
    initial: normalizeWakeRuntimeReadiness(value.initial),
    final: normalizeWakeRuntimeReadiness(value.final),
  };
}

function normalizeWakeRuntimeReadiness(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    ready: value.ready === true,
    activeWakeCapableWorkerCount: normalizeNonNegativeInteger(value.activeWakeCapableWorkerCount),
    relayLeaseState: normalizeString(value.relayLeaseState),
    relayOwnerId: normalizeString(value.relayOwnerId),
    relayLeaseRenewedAt: normalizeString(value.relayLeaseRenewedAt),
    relayLeaseExpiresAt: normalizeString(value.relayLeaseExpiresAt),
    relayOwnerWorkerState: normalizeString(value.relayOwnerWorkerState),
    relayOwnerHeartbeatAgeMs: normalizeOptionalNonNegativeInteger(value.relayOwnerHeartbeatAgeMs),
    reasons: Array.isArray(value.reasons) ? value.reasons.map((reason) => normalizeString(reason)).filter(Boolean) : [],
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

function normalizeRuntimeFallback(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    stage: normalizeString(value.stage) ?? "unknown",
    reason: normalizeString(value.reason) ?? "browser-runtime-error",
    message: value.message ? sanitizeRuntimeErrorMessage(value.message) : null,
  };
}

function freshWriteMetadataPresent(observation) {
  return Boolean(
    observation.afterWritePresent || observation.postWriteTokenPresent || observation.freshWriteMetadataPresent,
  );
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
    RAW_POST_WRITE_TOKEN_PATTERN,
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

export async function runGuestBuyNowFreshnessProbe(options) {
  const errors = validateGuestBuyNowProbeOptions(options);
  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }

  const maxAttempts = Math.min(normalizePositiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS), MAX_ATTEMPT_LIMIT);
  const observe = typeof options.observe === "function" ? options.observe : observeBuyNowCheckout;
  const wakeRuntimePreflight = await waitForWakeRuntimePreflight(options);
  const attemptSummaries = [];
  let evidence = null;

  if (wakeRuntimePreflight?.ready === false) {
    evidence = buildGuestBuyNowProbeEvidence({
      checkedAt: options.checkedAt,
      environment: options.environment,
      flow: options.flow,
      fixtureKey: options.fixtureKey,
      diagnosticCorrelationId: options.diagnosticCorrelationId,
      productionProofReference: options.productionProofReference,
      readySloMs: options.readySloMs,
      sloMode: options.sloMode,
      wakeRuntimePreflight,
      observation: wakeRuntimePreflightFailureObservation(wakeRuntimePreflight),
    });
    evidence = { ...evidence, attemptCount: 0, maxAttempts, attemptSummaries };
    await persistProbeEvidence(options, evidence);
    return evidence;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const observation = await observe(options, attempt).catch((error) => runtimeFailureObservation(error));
    evidence = buildGuestBuyNowProbeEvidence({
      checkedAt: options.checkedAt,
      environment: options.environment,
      flow: options.flow,
      fixtureKey: options.fixtureKey,
      diagnosticCorrelationId: options.diagnosticCorrelationId,
      productionProofReference: options.productionProofReference,
      readySloMs: options.readySloMs,
      sloMode: options.sloMode,
      wakeRuntimePreflight,
      observation,
    });
    attemptSummaries.push({
      attempt,
      finalState: evidence.finalState,
      promotionDecision: evidence.promotionDecision,
      failureReason: evidence.failureReason,
      readyLatencyMs: evidence.readyLatencyMs,
    });

    if (evidence.promotionDecision === "promote" || !retryableProbeFailure(evidence.failureReason)) {
      break;
    }
  }

  evidence = { ...evidence, attemptCount: attemptSummaries.length, maxAttempts, attemptSummaries };

  await persistProbeEvidence(options, evidence);

  return evidence;
}

async function persistProbeEvidence(options, evidence) {
  const leaks = assertRedactedEvidence(evidence);
  if (leaks.length > 0) {
    throw new Error(`Guest Buy Now probe evidence leaked sensitive values: ${leaks.join(", ")}`);
  }

  if (options.outPath) {
    await writeJsonRecord(options.outPath, evidence);
  }
}

function retryableProbeFailure(failureReason) {
  return (
    failureReason === "checkout-ready-slo-exceeded" ||
    failureReason === "browser-navigation-timeout" ||
    failureReason === "platform-temporary-unavailable" ||
    failureReason === SETUP_STAGE_PROJECTION_LAG_FAILURE_REASON
  );
}

function runtimeFailureObservation(error) {
  const runtimeFailure = normalizeRuntimeError(error);
  return {
    latencyMs: 0,
    readyLatencyMs: null,
    segments: {},
    afterWritePresent: false,
    postWriteTokenPresent: false,
    freshWriteMetadataPresent: false,
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

function wakeRuntimePreflightFailureObservation(preflight) {
  const reasons = preflight?.final?.reasons?.length ? preflight.final.reasons.join(", ") : "unknown";
  return {
    latencyMs: 0,
    readyLatencyMs: null,
    segments: {},
    afterWritePresent: false,
    postWriteTokenPresent: false,
    freshWriteMetadataPresent: false,
    guestCookiePresent: false,
    sessionCookiePresent: false,
    permanentNotFoundVisible: false,
    checkoutStartRecoveryVisible: false,
    temporaryRecoveryVisible: false,
    temporaryRecoveryObserved: false,
    checkoutReviewVisible: false,
    platformErrorVisible: false,
    checkoutDocumentStatus: null,
    stateWaitOutcome: null,
    waitMode: null,
    pageText: "",
    runtimeFailureReason: "wake-runtime-not-ready-before-probe",
    runtimeFailureStage: "wake-runtime-preflight",
    runtimeFailureMessage: `Wake runtime did not become ready before the Buy Now probe: ${reasons}.`,
    negativeProbe: { attempted: false },
  };
}

export function evaluateWakeRuntimeReadiness(snapshot) {
  const reasons = [];
  const schedulers = snapshot?.schedulers ?? null;
  const relay = snapshot?.relay ?? null;
  const activeWakeCapableWorkerCount = normalizeNonNegativeInteger(schedulers?.activeWakeCapableWorkerCount);
  const relayLeaseState = normalizeString(relay?.lease?.state);
  const relayOwnerId = normalizeString(relay?.lease?.ownerId);
  const relayOwnerWorker = findWakeCapableWorker(schedulers, relayOwnerId);

  if (!schedulers || schedulers.available === false) {
    reasons.push("wake-scheduler-status-unavailable");
  } else if (activeWakeCapableWorkerCount < 1) {
    reasons.push("no-active-wake-capable-workers");
  }

  if (!relay || relay.available === false) {
    reasons.push("wake-relay-status-unavailable");
  } else if (relayLeaseState !== "active") {
    reasons.push("projection-wake-relay-lease-not-active");
    if (Array.isArray(schedulers?.workers) && relayOwnerId) {
      if (!relayOwnerWorker) {
        reasons.push("projection-wake-relay-owner-heartbeat-missing");
      } else if (relayOwnerWorker.workerState === "active") {
        reasons.push("projection-wake-relay-owner-not-renewing-lease");
      } else {
        reasons.push("projection-wake-relay-owner-heartbeat-not-active");
      }
    }
  }

  return {
    ready: reasons.length === 0,
    activeWakeCapableWorkerCount,
    relayLeaseState,
    relayOwnerId,
    relayLeaseRenewedAt: normalizeString(relay?.lease?.renewedAt),
    relayLeaseExpiresAt: normalizeString(relay?.lease?.expiresAt),
    relayOwnerWorkerState: relayOwnerWorker?.workerState ?? null,
    relayOwnerHeartbeatAgeMs: relayOwnerWorker?.heartbeatAgeMs ?? null,
    reasons,
  };
}

function findWakeCapableWorker(schedulers, workerId) {
  if (!workerId || !Array.isArray(schedulers?.workers)) {
    return null;
  }
  const worker = schedulers.workers.find((candidate) => candidate?.workerId === workerId);
  if (!worker) {
    return null;
  }
  return {
    workerState: normalizeString(worker.workerState) ?? "unknown",
    heartbeatAgeMs: normalizeOptionalNonNegativeInteger(worker.heartbeatAgeMs),
  };
}

export async function fetchWakeStatusSnapshot(options, fetchImpl = fetch) {
  const adminBaseUrl = normalizeUrl(options.adminBaseUrl);
  if (!adminBaseUrl) {
    return null;
  }

  const signInResponse = await fetchImpl(`${adminBaseUrl}/api/auth/password-sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: options.adminEmail, password: options.adminPassword }),
  });
  if (!signInResponse.ok) {
    throw new Error(`Wake-status admin sign-in failed with HTTP ${signInResponse.status}.`);
  }
  const sessionToken = (await signInResponse.json())?.sessionToken;
  if (!sessionToken) {
    throw new Error("Wake-status admin sign-in did not return a session token.");
  }

  const statusResponse = await fetchImpl(`${adminBaseUrl}/api/platform/projections/wake-status`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  if (!statusResponse.ok) {
    throw new Error(`Wake-status request failed with HTTP ${statusResponse.status}.`);
  }

  return statusResponse.json();
}

function readNow(options) {
  return typeof options.now === "function" ? options.now() : Date.now();
}

async function sleepFor(options, ms) {
  if (typeof options.sleep === "function") {
    await options.sleep(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForWakeRuntimePreflight(options) {
  const adminBaseUrl = normalizeUrl(options.adminBaseUrl);
  if (!adminBaseUrl && !options.fetchWakeStatus) {
    return null;
  }

  const startedAt = readNow(options);
  const deadline =
    startedAt + normalizeNonNegativeInteger(options.wakeRuntimeReadyBudgetMs ?? DEFAULT_WAKE_RUNTIME_READY_BUDGET_MS);
  const pollIntervalMs = normalizePositiveInteger(
    options.wakeRuntimeReadyPollIntervalMs,
    DEFAULT_WAKE_RUNTIME_READY_POLL_INTERVAL_MS,
  );
  const fetchWakeStatus =
    typeof options.fetchWakeStatus === "function"
      ? options.fetchWakeStatus
      : () => fetchWakeStatusSnapshot(options, options.fetchImpl ?? fetch);
  let sampleCount = 0;
  let initial = null;
  let final = null;

  for (;;) {
    let snapshot;
    try {
      snapshot = await fetchWakeStatus();
    } catch {
      const failed = {
        ready: false,
        activeWakeCapableWorkerCount: 0,
        relayLeaseState: null,
        relayOwnerId: null,
        reasons: ["wake-status-preflight-fetch-failed"],
      };
      return {
        attempted: true,
        ready: false,
        readyAfterMs: null,
        sampleCount,
        initial: initial ?? failed,
        final: failed,
      };
    }

    sampleCount += 1;
    const evaluation = evaluateWakeRuntimeReadiness(snapshot);
    initial ??= evaluation;
    final = evaluation;
    if (evaluation.ready) {
      return {
        attempted: true,
        ready: true,
        readyAfterMs: Math.max(0, readNow(options) - startedAt),
        sampleCount,
        initial,
        final,
      };
    }

    const remainingMs = deadline - readNow(options);
    if (remainingMs <= 0) {
      break;
    }
    await sleepFor(options, Math.min(pollIntervalMs, remainingMs));
  }

  return {
    attempted: true,
    ready: false,
    readyAfterMs: null,
    sampleCount,
    initial,
    final,
  };
}

export function normalizeConvergenceProjectionNames(value) {
  const text = normalizeString(value);
  if (!text || text.toLowerCase() === "all") {
    return null;
  }
  const names = text
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 ? names : null;
}

function isProjectionGroupCaughtUp(group) {
  if (group?.caughtUp === true) {
    return true;
  }
  if (group?.caughtUp === false) {
    return false;
  }
  const state = normalizeString(group?.state);
  return state === "caught-up" || state === "idle";
}

export function evaluateProjectionConvergence(snapshot, projectionNames = null) {
  const allGroups = Array.isArray(snapshot?.projectionGroups) ? snapshot.projectionGroups : null;
  if (!allGroups) {
    return {
      converged: false,
      available: false,
      totalGroups: 0,
      caughtUpGroups: 0,
      laggingGroups: [],
      reasons: ["projection-status-unavailable"],
    };
  }

  const requested = Array.isArray(projectionNames) && projectionNames.length > 0 ? projectionNames : null;
  const reasons = [];
  if (requested) {
    const missing = requested.filter(
      (name) => !allGroups.some((group) => normalizeString(group?.projectionName) === name),
    );
    if (missing.length > 0) {
      reasons.push("required-projection-group-not-found");
    }
  }

  const groups = requested
    ? allGroups.filter((group) => requested.includes(normalizeString(group?.projectionName)))
    : allGroups;
  if (groups.length === 0) {
    reasons.push("no-projection-groups-found");
    return { converged: false, available: true, totalGroups: 0, caughtUpGroups: 0, laggingGroups: [], reasons };
  }

  const laggingGroups = groups
    .filter((group) => !isProjectionGroupCaughtUp(group))
    .map((group) => normalizeString(group?.projectionName) ?? "unknown");
  if (laggingGroups.length > 0) {
    reasons.push("projection-groups-not-caught-up");
  }

  return {
    converged: laggingGroups.length === 0 && reasons.length === 0,
    available: true,
    totalGroups: groups.length,
    caughtUpGroups: groups.length - laggingGroups.length,
    laggingGroups,
    reasons,
  };
}

export async function fetchProjectionStatusSnapshot(options, fetchImpl = fetch) {
  const adminBaseUrl = normalizeUrl(options.adminBaseUrl);
  if (!adminBaseUrl) {
    return null;
  }

  const signInResponse = await fetchImpl(`${adminBaseUrl}/api/auth/password-sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: options.adminEmail, password: options.adminPassword }),
  });
  if (!signInResponse.ok) {
    throw new Error(`Projection-status admin sign-in failed with HTTP ${signInResponse.status}.`);
  }
  const sessionToken = (await signInResponse.json())?.sessionToken;
  if (!sessionToken) {
    throw new Error("Projection-status admin sign-in did not return a session token.");
  }

  const statusResponse = await fetchImpl(`${adminBaseUrl}/api/platform/projections/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!statusResponse.ok) {
    throw new Error(`Projection-status refresh failed with HTTP ${statusResponse.status}.`);
  }

  return statusResponse.json();
}

export async function waitForProjectionConvergence(options) {
  const adminBaseUrl = normalizeUrl(options.adminBaseUrl);
  if (!adminBaseUrl && !options.fetchProjectionStatus) {
    return null;
  }

  const startedAt = readNow(options);
  const deadline =
    startedAt + normalizeNonNegativeInteger(options.convergenceBudgetMs ?? DEFAULT_PROJECTION_CONVERGENCE_BUDGET_MS);
  const pollIntervalMs = normalizePositiveInteger(
    options.convergencePollIntervalMs,
    DEFAULT_PROJECTION_CONVERGENCE_POLL_INTERVAL_MS,
  );
  const projectionNames = normalizeConvergenceProjectionNames(options.convergenceProjectionNames);
  const fetchProjectionStatus =
    typeof options.fetchProjectionStatus === "function"
      ? options.fetchProjectionStatus
      : () => fetchProjectionStatusSnapshot(options, options.fetchImpl ?? fetch);
  let sampleCount = 0;
  let initial = null;
  let final = null;

  for (;;) {
    let snapshot;
    try {
      snapshot = await fetchProjectionStatus();
    } catch {
      // A just-restarted fleet often refuses the status request for a few seconds.
      // Treat transient fetch failures as "not converged yet" and keep polling until
      // the budget expires rather than aborting the gate.
      const fetchFailed = {
        converged: false,
        available: false,
        totalGroups: 0,
        caughtUpGroups: 0,
        laggingGroups: [],
        reasons: ["projection-status-fetch-failed"],
      };
      initial ??= fetchFailed;
      final = fetchFailed;
      const remainingMs = deadline - readNow(options);
      if (remainingMs <= 0) {
        break;
      }
      await sleepFor(options, Math.min(pollIntervalMs, remainingMs));
      continue;
    }

    sampleCount += 1;
    const evaluation = evaluateProjectionConvergence(snapshot, projectionNames);
    initial ??= evaluation;
    final = evaluation;
    if (evaluation.converged) {
      return {
        attempted: true,
        converged: true,
        convergedAfterMs: Math.max(0, readNow(options) - startedAt),
        sampleCount,
        initial,
        final,
      };
    }

    const remainingMs = deadline - readNow(options);
    if (remainingMs <= 0) {
      break;
    }
    await sleepFor(options, Math.min(pollIntervalMs, remainingMs));
  }

  return {
    attempted: true,
    converged: false,
    convergedAfterMs: null,
    sampleCount,
    initial,
    final,
  };
}

export async function runProjectionConvergenceGate(options) {
  const gate = await waitForProjectionConvergence(options);
  const evidence = {
    schemaVersion: PROJECTION_CONVERGENCE_GATE_VERSION,
    checkedAt: options.checkedAt ?? new Date().toISOString(),
    environment: normalizeString(options.environment) ?? "staging",
    convergenceBudgetMs: normalizeNonNegativeInteger(
      options.convergenceBudgetMs ?? DEFAULT_PROJECTION_CONVERGENCE_BUDGET_MS,
    ),
    convergenceProjectionNames: normalizeConvergenceProjectionNames(options.convergenceProjectionNames) ?? "all",
    // A timing gate never blocks promotion on its own: it waits out the post-rollout
    // catch-up window so the SLO-sensitive Buy Now probe starts against a converged
    // fleet, then proceeds regardless. Steady-state SLO breaches still
    // fail loudly in the probe step that follows.
    promotionDecision: "proceed",
    gate: gate ?? {
      attempted: false,
      converged: null,
      convergedAfterMs: null,
      sampleCount: 0,
      initial: null,
      final: null,
    },
  };

  if (options.outPath) {
    await writeJsonRecord(options.outPath, evidence);
  }

  return evidence;
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
      let accountItemPageFallback = null;
      let startedAt;
      if (flow === "account") {
        try {
          await page.goto(itemUrl.toString(), buyNowItemPageNavigationWaitOptions(options.timeoutMs));
          const buyNowButton = page
            .locator(
              'button[type="submit"][name="intent"][value="buy-this-listing"]:not([disabled]), button[type="submit"][name="intent"][value="buy-now"]:not([disabled])',
            )
            .first();
          startedAt = Date.now();
          stage = "click-account-buy-now";
          await buyNowButton.click({ timeout: options.timeoutMs });
        } catch (error) {
          const fallbackReason = normalizeRuntimeError(error, stage);
          if (
            fallbackReason.stage !== "load-buy-now-item-page" ||
            fallbackReason.reason !== "browser-navigation-timeout"
          ) {
            throw error;
          }
          accountItemPageFallback = fallbackReason;
          startedAt = Date.now();
          stage = "submit-account-buy-now-action-fallback";
          const checkoutUrl = await submitAccountBuyNowActionFallback(
            page,
            itemUrl,
            fixtureCandidate,
            options.timeoutMs,
          );
          stage = "load-account-buy-now-fallback-session";
          await page.goto(checkoutUrl.toString(), buyNowRouteTransitionWaitOptions(options.timeoutMs));
        }
      } else {
        await page.goto(itemUrl.toString(), buyNowItemPageNavigationWaitOptions(options.timeoutMs));
        const buyNowButton = page
          .locator(
            'button[type="submit"][name="intent"][value="buy-this-listing"]:not([disabled]), button[type="submit"][name="intent"][value="buy-now"]:not([disabled])',
          )
          .first();
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
      const freshWriteMetadata = detectFreshWriteMetadata(finalUrl);
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
        ...freshWriteMetadata,
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
        accountItemPageFallback,
        negativeProbe: options.skipNegativeProbe
          ? { attempted: false }
          : await runNegativeProbe(page, baseUrl, options),
      };

      return observation;
    }

    if (checkoutStartRecoveryObservation) {
      return checkoutStartRecoveryObservation;
    }

    throw new Error("Guest Buy Now probe found no checkout-ready marketplace fixture candidates.");
  } catch (error) {
    throw probeRuntimeError(stage, error);
  } finally {
    await browser.close();
  }
}

export function accountBuyNowActionFormForCandidate(candidate) {
  const line = Array.isArray(candidate?.previewRequest?.lines) ? candidate.previewRequest.lines[0] : null;
  const listingId = normalizeString(line?.lockedListingId) ?? normalizeString(line?.listingId) ?? "";
  return {
    intent: "buy-this-listing",
    productId: normalizeString(line?.productId) ?? "",
    selectedOptions: JSON.stringify(Array.isArray(line?.selectedOptions) ? line.selectedOptions : []),
    productSummary: normalizeString(line?.productSummary) ?? "",
    quantity: String(normalizePositiveInteger(line?.quantity, 1)),
    lockedListingId: listingId,
  };
}

export async function submitAccountBuyNowActionFallback(page, itemUrl, fixtureCandidate, timeoutMs) {
  const response = await page.request.post(itemUrl.toString(), {
    form: accountBuyNowActionFormForCandidate(fixtureCandidate),
    maxRedirects: 0,
    timeout: normalizePositiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS),
  });
  const status = response.status();
  const location = response.headers().location;
  if (status >= 300 && status < 400 && location) {
    return new URL(location, itemUrl);
  }
  if (status >= 500) {
    throw probeHttpError(`Buy Now probe account action fallback failed with HTTP ${status}.`, status);
  }
  const error = new Error(
    `Buy Now probe account action fallback expected a checkout redirect but received HTTP ${status}.`,
  );
  error.reason = "account-buy-now-action-unexpected-response";
  throw error;
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
  const freshWriteMetadata = detectFreshWriteMetadata(finalUrl);
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
    ...freshWriteMetadata,
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

function probeRuntimeError(stage, error) {
  const failure = normalizeRuntimeError(error, stage);
  const runtimeError = new Error(failure.message ?? failure.reason);
  runtimeError.stage = failure.stage;
  runtimeError.reason = failure.reason;
  return runtimeError;
}

export async function startAccountSession(page, context, options, baseUrl) {
  const accountEmail = normalizeString(options.accountEmail);
  const accountPassword = normalizeString(options.accountPassword);
  let sessionToken;
  if (accountEmail && accountPassword) {
    const response = await page.request.post(`${baseUrl}/api/auth/password-sign-in`, {
      data: { email: accountEmail, password: accountPassword },
    });
    if (response.status() !== 200) {
      throw probeHttpError(`Buy Now probe account sign-in failed with HTTP ${response.status()}.`, response.status());
    }
    sessionToken = (await response.json())?.sessionToken;
  } else {
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    sessionToken = await registerSyntheticAccountSession(page, options, baseUrl, {
      displayName: `Buy Now Probe Account ${nonce}`,
      email: `buy-now-probe+account-${nonce}@chasesets.test`,
      password: `buy-now-probe-${nonce}`,
    });
  }

  if (!sessionToken) {
    throw new Error("Buy Now probe account session did not return a session token.");
  }

  await addAccountSessionCookie(context, baseUrl, sessionToken);
}

// Resolve the server-minted registration consent resolution, then register with
// the value we were handed. A probe is an ordinary client of the register route
// and has to satisfy the same requirement the product path does.
async function resolveRegistrationConsentSubmission(page, baseUrl) {
  const response = await page.request.get(`${baseUrl}/api/auth/registration-consent`);
  if (response.status() !== 200) {
    throw probeHttpError(
      `Buy Now probe registration consent resolution failed with HTTP ${response.status()}.`,
      response.status(),
    );
  }
  return { resolution: await response.json(), affirmed: false };
}

async function registerSyntheticAccountSession(page, options, baseUrl, account) {
  await provisionSyntheticAccountInvitation(page, options, baseUrl, account.email);
  const response = await page.request.post(`${baseUrl}/api/auth/register`, {
    data: { ...account, registrationConsent: await resolveRegistrationConsentSubmission(page, baseUrl) },
  });
  if (response.status() !== 201) {
    throw probeHttpError(
      `Buy Now probe synthetic account registration failed with HTTP ${response.status()}.`,
      response.status(),
    );
  }
  return (await response.json())?.sessionToken;
}

async function provisionSyntheticAccountInvitation(page, options, baseUrl, email) {
  const adminEmail = normalizeString(options.adminEmail);
  const adminPassword = normalizeString(options.adminPassword);
  if (!adminEmail || !adminPassword) {
    return;
  }

  const adminSession = await startPasswordSession(page, baseUrl, {
    email: adminEmail,
    password: adminPassword,
    label: "platform-admin password sign-in",
  });
  const adminCookie = `chase_sets_session=${adminSession}`;
  const actorResponse = await page.request.get(`${baseUrl}/api/identity/current-actor-display`, {
    headers: { Cookie: adminCookie },
  });
  if (actorResponse.status() !== 200) {
    throw probeHttpError(
      `Buy Now probe platform admin actor lookup failed with HTTP ${actorResponse.status()}.`,
      actorResponse.status(),
    );
  }

  const actor = await actorResponse.json();
  const accountId = normalizeString(actor?.account?.account_id);
  if (!accountId) {
    throw new Error("Buy Now probe platform admin actor lookup did not return an account id.");
  }

  const invitationResponse = await page.request.post(`${baseUrl}/api/identity/invitations`, {
    headers: { Cookie: adminCookie },
    data: {
      invitationId: createSyntheticInvitationId(),
      accountId,
      email,
      roleKey: "viewer",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  });
  if (invitationResponse.status() !== 201) {
    throw probeHttpError(
      `Buy Now probe synthetic account invitation failed with HTTP ${invitationResponse.status()}.`,
      invitationResponse.status(),
    );
  }

  await waitForAuthInvitationProjection(page, baseUrl, adminCookie, invitationResponse);
}

async function startPasswordSession(page, baseUrl, input) {
  const response = await page.request.post(`${baseUrl}/api/auth/password-sign-in`, {
    data: { email: input.email, password: input.password },
  });
  if (response.status() !== 200) {
    throw probeHttpError(`Buy Now probe ${input.label} failed with HTTP ${response.status()}.`, response.status());
  }
  const sessionToken = (await response.json())?.sessionToken;
  if (!sessionToken) {
    throw new Error(`Buy Now probe ${input.label} did not return a session token.`);
  }
  return sessionToken;
}

async function waitForAuthInvitationProjection(page, baseUrl, adminCookie, response) {
  const identityCommit = decodeCommitReceipt(response.headers()[CHASE_SETS_COMMIT_RECEIPT_HEADER])?.find(
    (source) => source.sourceContextName === "identity",
  );
  if (!identityCommit) {
    return;
  }

  const deadline = Date.now() + SYNTHETIC_INVITATION_PROJECTION_TIMEOUT_MS;
  let lastObservedPosition = "0";
  while (Date.now() < deadline) {
    const refreshResponse = await page.request.post(`${baseUrl}/api/platform/projections/refresh`, {
      headers: { Cookie: adminCookie },
    });
    if (refreshResponse.status() !== 200) {
      throw probeHttpError(
        `Buy Now probe auth invitation projection refresh failed with HTTP ${refreshResponse.status()}.`,
        refreshResponse.status(),
      );
    }

    const body = await refreshResponse.json();
    const authInvitationProjection = body?.projectionGroups?.find(
      (group) => group?.targetContextName === "auth" && group?.projectionName === "auth-identity-invitation-projection",
    );
    lastObservedPosition = maxObservedPosition(authInvitationProjection, "identity") ?? lastObservedPosition;
    if (BigInt(lastObservedPosition) >= BigInt(identityCommit.maxGlobalPosition)) {
      return;
    }

    await page.waitForTimeout(SYNTHETIC_INVITATION_PROJECTION_POLL_MS);
  }

  throw setupStageProjectionLagError(
    `Buy Now probe auth invitation projection did not reach identity position ${identityCommit.maxGlobalPosition}; last observed ${lastObservedPosition}.`,
  );
}

function setupStageProjectionLagError(message) {
  const error = new Error(message);
  error.reason = SETUP_STAGE_PROJECTION_LAG_FAILURE_REASON;
  error.stage = "start-account-session";
  return error;
}

function maxObservedPosition(group, sourceContextName) {
  const positions =
    group?.subscriptions
      ?.filter((subscription) => subscription?.sourceContextName === sourceContextName)
      .map((subscription) => subscription?.lastGlobalPosition)
      .filter((position) => typeof position === "string" && /^(0|[1-9]\d*)$/.test(position)) ?? [];

  return positions.reduce((max, position) => (BigInt(position) > BigInt(max) ? position : max), "0");
}

function decodeCommitReceipt(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    return Array.isArray(parsed) ? parsed.filter(isSourceCommitPosition) : [];
  } catch {
    return [];
  }
}

function isSourceCommitPosition(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.sourceContextName === "string" &&
    value.sourceContextName.length > 0 &&
    typeof value.maxGlobalPosition === "string" &&
    /^(0|[1-9]\d*)$/.test(value.maxGlobalPosition) &&
    Array.isArray(value.eventIds) &&
    value.eventIds.every((eventId) => typeof eventId === "string" && eventId.length > 0)
  );
}

function createSyntheticInvitationId() {
  return `ivt_buy_now_probe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function addAccountSessionCookie(context, baseUrl, sessionToken) {
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

function probeHttpError(message, status) {
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
  const probeUrl = new URL(`/checkout/buy/session/chk_probe_negative_${nonce}`, baseUrl);
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
    throw new Error("Guest Buy Now probe requires a base URL and either an item path or search query.");
  }

  const searchUrl = new URL("/api/marketplace/items", baseUrl);
  searchUrl.searchParams.set("search", searchQuery);
  searchUrl.searchParams.set("includeTotal", "true");
  const response = await fetchImpl(searchUrl);
  if (!response.ok) {
    throw new Error(`Guest Buy Now probe fixture search failed with HTTP ${response.status}.`);
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

  throw new Error(`Guest Buy Now probe found no active buyable marketplace item for search query '${searchQuery}'.`);
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
    checkoutSessionId: `chk_probe_fixture_preview_${listingId.replace(/[^A-Za-z0-9_:-]/g, "_").slice(0, 80)}`,
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
  return PROBE_FLOWS.includes(normalized) ? normalized : null;
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
    .replace(RAW_POST_WRITE_TOKEN_PATTERN, "postWriteToken=[redacted]")
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
    const options = parseGuestBuyNowProbeArgs(argv, env);
    if (options.convergenceGate) {
      const gateEvidence = await runProjectionConvergenceGate({
        ...options,
        outPath: options.outPath,
      });
      console.log(JSON.stringify(gateEvidence, null, 2));
      if (gateEvidence.gate.attempted && gateEvidence.gate.converged === false) {
        console.error(
          `WARNING: staging projections did not fully converge within ${gateEvidence.convergenceBudgetMs}ms before the Buy Now probe (lagging: ${gateEvidence.gate.final?.laggingGroups?.join(", ") || "unknown"}). Proceeding to probes; steady-state SLO breaches still fail loudly.`,
        );
      }
      return 0;
    }
    const evidence = await runGuestBuyNowFreshnessProbe({
      ...options,
      guestEmail: options.guestEmail ?? DEFAULT_GUEST_EMAIL,
    });
    console.log(JSON.stringify(evidence, null, 2));
    if (evidence.promotionDecision === "warn") {
      console.error(
        `WARNING: Buy Now freshness probe exceeded the ready SLO (${evidence.readySloMs}ms) with user-safe final state '${evidence.finalState}'. Recorded as a release-health warning; the release is not blocked (slo-mode=warn, ratified single-write SLO per docs/architecture/push-wake-slo-load-proof.md).`,
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
