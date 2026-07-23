#!/usr/bin/env node
// Staging push-wake recovery and load drills.
//
// Drills run against deployed staging surfaces plus direct staging database
// access (the same Terraform-state-derived URLs the staging operational
// workflows already use). They never mutate platform state themselves: the
// only write generator is the existing guest Buy Now freshness canary, and
// every database query is read-only.
//
// Drill kinds:
//   reconciliation  Audit relay source high-water cursors against durable
//                   event-store positions and projection checkpoints, then
//                   (optionally) generate bounded synthetic Buy Now
//                   single-write attempts and prove durable convergence within
//                   a bounded budget. This is the executable
//                   missed-notification/missed-fan-out detection drill.
//   load            Bounded synthetic load: N canary iterations at
//                   concurrency C (hard caps), followed by the same
//                   reconciliation convergence audit. Bounded staging load
//                   evidence; explicitly not a production-like
//                   volume load test.
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";
import { postgresClientConfig, safeFailureFields } from "./lib/postgres-connection.mjs";

export const STAGING_WAKE_DRILLS_VERSION = "staging-wake-drills/v1";
export const DRILL_KINDS = Object.freeze(["reconciliation", "load"]);
export const LOAD_LIMITS = Object.freeze({
  maxIterations: 12,
  maxConcurrency: 4,
});
export const DEFAULT_CONVERGENCE_BUDGET_MS = 120_000;
export const MIN_CONVERGENCE_BUDGET_MS = 5_000;
export const MAX_CONVERGENCE_BUDGET_MS = 600_000;
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_WAKE_RUNTIME_READY_BUDGET_MS = 120_000;
export const DEFAULT_SOURCE_CONTEXTS = Object.freeze(["checkout"]);
export const DEFAULT_BUY_NOW_CONVERGENCE_PROJECTION_NAMES = Object.freeze(["checkout.session-projection"]);
export const DEFAULT_FIXTURE_KEY = "staging-guest-buy-now-fixture";
export const DEFAULT_LOAD_ITERATIONS = 6;
export const DEFAULT_LOAD_CONCURRENCY = 2;
export const DEFAULT_RECONCILIATION_CANARY_ATTEMPTS = 3;
export const MAX_RECONCILIATION_CANARY_ATTEMPTS = 3;
export const CANARY_BROWSER_SEGMENTS = Object.freeze([
  "writeToRedirectMs",
  "redirectToDocumentMs",
  "documentToReadyMs",
  "writeToCheckoutReadyMs",
]);
export const MAX_WAKE_RUNTIME_PREFLIGHT_SAMPLES = 60;

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CANARY_SCRIPT_PATH = join(REPO_ROOT, "scripts", "guest-buy-now-freshness-probe.mjs");
const POSTGRES_URL_PATTERN = /postgres(?:ql)?:\/\/[^"'\s]+/gi;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._-]+/g;
const SESSION_TOKEN_FIELD_PATTERN = /"sessionToken"/g;
const WORKER_HEARTBEAT_STALE_AGE_MS = 120_000;

export function contextDatabaseEnvName(sourceContextName) {
  return `DATABASE_URL_${String(sourceContextName).toUpperCase().replaceAll("-", "_")}`;
}

export function parseStagingWakeDrillArgs(argv, env = process.env) {
  const drillKind = argv[0] && !argv[0].startsWith("--") ? argv[0] : (readEnv("WAKE_DRILL_KIND", env) ?? "");
  const optionArgs = argv[0] && !argv[0].startsWith("--") ? argv.slice(1) : argv;
  const sourceContexts = readCsv(
    readOption(optionArgs, "--source-contexts") ?? readEnv("WAKE_DRILL_SOURCE_CONTEXTS", env),
    DEFAULT_SOURCE_CONTEXTS,
  );
  const skipCanaryWrite =
    readFlag(optionArgs, "--skip-canary-write") || readBoolean(readEnv("WAKE_DRILL_SKIP_CANARY_WRITE", env));
  const convergenceProjectionNames = readConvergenceProjectionNames(
    readOption(optionArgs, "--convergence-projection-names") ?? readEnv("WAKE_DRILL_CONVERGENCE_PROJECTION_NAMES", env),
    { drillKind, sourceContexts, skipCanaryWrite },
  );

  return {
    drillKind,
    baseUrl: readOption(optionArgs, "--base-url") ?? readEnv("WAKE_DRILL_BASE_URL", env),
    adminBaseUrl: readOption(optionArgs, "--admin-base-url") ?? readEnv("WAKE_DRILL_ADMIN_BASE_URL", env),
    workerStatusUrl: readOption(optionArgs, "--worker-status-url") ?? readEnv("WAKE_DRILL_WORKER_STATUS_URL", env),
    outPath:
      readOption(optionArgs, "--out") ??
      readEnv("WAKE_DRILL_OUT", env) ??
      `artifacts/wake-drills/staging-wake-drill-${drillKind || "unknown"}.json`,
    sourceContexts,
    convergenceProjectionNames,
    convergenceBudgetMs: clampInteger(
      readOption(optionArgs, "--convergence-budget-ms") ?? readEnv("WAKE_DRILL_CONVERGENCE_BUDGET_MS", env),
      DEFAULT_CONVERGENCE_BUDGET_MS,
      MIN_CONVERGENCE_BUDGET_MS,
      MAX_CONVERGENCE_BUDGET_MS,
    ),
    pollIntervalMs: clampInteger(
      readOption(optionArgs, "--poll-interval-ms") ?? readEnv("WAKE_DRILL_POLL_INTERVAL_MS", env),
      DEFAULT_POLL_INTERVAL_MS,
      250,
      30_000,
    ),
    wakeRuntimeReadyBudgetMs: clampInteger(
      readOption(optionArgs, "--wake-runtime-ready-budget-ms") ?? readEnv("WAKE_DRILL_RUNTIME_READY_BUDGET_MS", env),
      DEFAULT_WAKE_RUNTIME_READY_BUDGET_MS,
      0,
      MAX_CONVERGENCE_BUDGET_MS,
    ),
    wakeRuntimeReadyPollIntervalMs: clampInteger(
      readOption(optionArgs, "--wake-runtime-ready-poll-interval-ms") ??
        readEnv("WAKE_DRILL_RUNTIME_READY_POLL_INTERVAL_MS", env),
      DEFAULT_POLL_INTERVAL_MS,
      250,
      30_000,
    ),
    skipCanaryWrite,
    searchQuery:
      readOption(optionArgs, "--search-query") ??
      readEnv("WAKE_DRILL_SEARCH_QUERY", env) ??
      readEnv("GUEST_BUY_NOW_PROBE_SEARCH_QUERY", env) ??
      "air balloon",
    itemPath: readOption(optionArgs, "--item-path") ?? readEnv("GUEST_BUY_NOW_PROBE_ITEM_PATH", env),
    fixtureKey:
      readOption(optionArgs, "--fixture-key") ?? readEnv("GUEST_BUY_NOW_PROBE_FIXTURE_KEY", env) ?? DEFAULT_FIXTURE_KEY,
    timeoutMs: clampInteger(
      readOption(optionArgs, "--timeout-ms") ?? readEnv("GUEST_BUY_NOW_PROBE_TIMEOUT_MS", env),
      45_000,
      5_000,
      120_000,
    ),
    readySloMs: clampInteger(
      readOption(optionArgs, "--ready-slo-ms") ?? readEnv("GUEST_BUY_NOW_PROBE_READY_SLO_MS", env),
      10_000,
      1_000,
      60_000,
    ),
    canaryAttempts: clampInteger(
      readOption(optionArgs, "--canary-attempts") ??
        readEnv("WAKE_DRILL_CANARY_ATTEMPTS", env) ??
        readEnv("GUEST_BUY_NOW_PROBE_ATTEMPTS", env),
      DEFAULT_RECONCILIATION_CANARY_ATTEMPTS,
      1,
      MAX_RECONCILIATION_CANARY_ATTEMPTS,
    ),
    flow: readOption(optionArgs, "--flow") ?? readEnv("WAKE_DRILL_FLOW", env) ?? "guest",
    iterations: readOption(optionArgs, "--iterations") ?? readEnv("WAKE_DRILL_LOAD_ITERATIONS", env),
    concurrency: readOption(optionArgs, "--concurrency") ?? readEnv("WAKE_DRILL_LOAD_CONCURRENCY", env),
    correlationPrefix:
      readOption(optionArgs, "--correlation-prefix") ??
      readEnv("WAKE_DRILL_CORRELATION_PREFIX", env) ??
      `wake-drill-${Date.now().toString(36)}`,
    adminEmail: readEnv("PLATFORM_ADMIN_EMAIL", env),
    adminPassword: readEnv("PLATFORM_ADMIN_PASSWORD", env),
    controlDatabaseUrl: readEnv("PLATFORM_CONTROL_DATABASE_URL", env),
    contextDatabaseUrls: Object.fromEntries(
      sourceContexts.map((contextName) => [contextName, readEnv(contextDatabaseEnvName(contextName), env)]),
    ),
    checkedAt: readOption(optionArgs, "--checked-at") ?? new Date().toISOString(),
  };
}

export function validateStagingWakeDrillOptions(options) {
  const errors = [];

  if (!DRILL_KINDS.includes(options.drillKind)) {
    errors.push(`Drill kind must be one of: ${DRILL_KINDS.join(", ")}.`);
  }
  if (!Array.isArray(options.sourceContexts) || options.sourceContexts.length === 0) {
    errors.push("At least one source context is required (--source-contexts).");
  }
  if (!normalizeString(options.controlDatabaseUrl)) {
    errors.push("PLATFORM_CONTROL_DATABASE_URL is required for the relay cursor audit.");
  }
  for (const contextName of options.sourceContexts ?? []) {
    if (!normalizeString(options.contextDatabaseUrls?.[contextName])) {
      errors.push(`${contextDatabaseEnvName(contextName)} is required to audit source context '${contextName}'.`);
    }
  }

  const needsWriteGenerator =
    options.drillKind === "load" || (options.drillKind === "reconciliation" && !options.skipCanaryWrite);
  if (needsWriteGenerator) {
    if (!normalizeUrl(options.baseUrl)) {
      errors.push("--base-url or WAKE_DRILL_BASE_URL is required when the drill generates canary writes.");
    }
    if (!normalizeString(options.itemPath) && !normalizeString(options.searchQuery)) {
      errors.push("--item-path or --search-query is required when the drill generates canary writes.");
    }
  }
  if (options.drillKind === "load" && options.flow !== "guest" && options.flow !== "account") {
    errors.push("--flow must be 'guest' or 'account' for the load drill.");
  }
  if (
    normalizeUrl(options.adminBaseUrl) &&
    (!normalizeString(options.adminEmail) || !normalizeString(options.adminPassword))
  ) {
    errors.push(
      "PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are required when --admin-base-url is set for wake-status snapshots.",
    );
  }

  return errors;
}

export function clampLoadPlan(input = {}) {
  const iterations = clampInteger(input.iterations, DEFAULT_LOAD_ITERATIONS, 1, LOAD_LIMITS.maxIterations);
  const concurrency = clampInteger(input.concurrency, DEFAULT_LOAD_CONCURRENCY, 1, LOAD_LIMITS.maxConcurrency);

  return {
    iterations,
    concurrency: Math.min(concurrency, iterations),
    bounded: true,
    limits: LOAD_LIMITS,
  };
}

export function defaultConvergenceProjectionNames(input = {}) {
  const usesSyntheticBuyNowWrite =
    input.drillKind === "load" || (input.drillKind === "reconciliation" && input.skipCanaryWrite !== true);
  const sourceContexts = Array.isArray(input.sourceContexts) ? input.sourceContexts : [];
  return usesSyntheticBuyNowWrite && sourceContexts.includes("checkout")
    ? [...DEFAULT_BUY_NOW_CONVERGENCE_PROJECTION_NAMES]
    : [];
}

// Subscription checkpoint rows can include retired subscription versions
// (checkpoint_key '<projection>:<source>:v<N>'). Only the highest version per
// projection participates in convergence: a stale v1 row behind an active v2
// row is rebuild residue, not lag.
export function selectActiveCheckpoints(rows) {
  const byProjection = new Map();
  for (const row of rows ?? []) {
    const projectionName = String(row.projection_name ?? row.projectionName ?? "");
    const version = Number.parseInt(String(row.subscription_version ?? row.subscriptionVersion ?? "1"), 10) || 1;
    const existing = byProjection.get(projectionName);
    if (!existing || version > existing.subscriptionVersion) {
      byProjection.set(projectionName, {
        checkpointKey: String(row.checkpoint_key ?? row.checkpointKey ?? ""),
        projectionName,
        subscriptionVersion: version,
        position: String(row.position ?? row.last_global_position ?? "0"),
        ageMs: toFiniteNumber(row.age_ms ?? row.ageMs),
      });
    }
  }

  return [...byProjection.values()].sort((left, right) => left.checkpointKey.localeCompare(right.checkpointKey));
}

export function evaluateConvergenceSample(sample, scope = {}) {
  const head = toBigInt(sample.head);
  const reasons = [];
  const requestedProjectionNames = normalizeProjectionNames(scope.projectionNames);

  let relayCursorGap = null;
  if (!sample.relayCursor) {
    reasons.push("relay-cursor-missing");
  } else {
    relayCursorGap = head - toBigInt(sample.relayCursor.position);
    if (relayCursorGap > 0n) {
      reasons.push("relay-cursor-behind-event-store-head");
    }
  }

  const allCheckpoints = sample.checkpoints ?? [];
  const checkpoints =
    requestedProjectionNames.length === 0
      ? allCheckpoints
      : allCheckpoints.filter((checkpoint) => requestedProjectionNames.includes(checkpoint.projectionName));
  const missingProjectionNames = requestedProjectionNames.filter(
    (projectionName) => !checkpoints.some((checkpoint) => checkpoint.projectionName === projectionName),
  );
  if (missingProjectionNames.length > 0) {
    reasons.push("required-projection-checkpoint-not-found");
  }
  if (checkpoints.length === 0) {
    reasons.push("no-projection-checkpoints-found");
  }
  const checkpointGaps = checkpoints.map((checkpoint) => {
    const gap = head - toBigInt(checkpoint.position);
    return {
      checkpointKey: checkpoint.checkpointKey,
      projectionName: checkpoint.projectionName,
      subscriptionVersion: checkpoint.subscriptionVersion,
      position: checkpoint.position,
      gap: gap.toString(),
      converged: gap <= 0n,
    };
  });
  if (checkpointGaps.some((entry) => !entry.converged)) {
    reasons.push("projection-checkpoint-behind-event-store-head");
  }
  const excludedCheckpointGaps =
    requestedProjectionNames.length === 0
      ? []
      : allCheckpoints
          .filter((checkpoint) => !requestedProjectionNames.includes(checkpoint.projectionName))
          .map((checkpoint) => {
            const gap = head - toBigInt(checkpoint.position);
            return {
              checkpointKey: checkpoint.checkpointKey,
              projectionName: checkpoint.projectionName,
              subscriptionVersion: checkpoint.subscriptionVersion,
              position: checkpoint.position,
              gap: gap.toString(),
              converged: gap <= 0n,
            };
          });

  return {
    head: head.toString(),
    relayCursorPosition: sample.relayCursor ? String(sample.relayCursor.position) : null,
    relayCursorGap: relayCursorGap === null ? null : relayCursorGap.toString(),
    relayCursorAgeMs: sample.relayCursor ? toFiniteNumber(sample.relayCursor.ageMs) : null,
    relayCursorOwnerId: sample.relayCursor ? (sample.relayCursor.ownerId ?? null) : null,
    checkpointScope: {
      mode: requestedProjectionNames.length === 0 ? "all-active-projections" : "projection-names",
      projectionNames: requestedProjectionNames,
      missingProjectionNames,
      excludedCheckpointCount: excludedCheckpointGaps.length,
      excludedLaggingCheckpointCount: excludedCheckpointGaps.filter((entry) => !entry.converged).length,
      excludedMaxCheckpointGap: maxBigIntString(excludedCheckpointGaps.map((entry) => entry.gap)),
    },
    checkpointGaps,
    converged: reasons.length === 0,
    reasons,
  };
}

export function summarizeLoadResults(results) {
  const attempted = results.length;
  const evidenceProduced = results.filter((result) => result.exitCode === 0 || result.exitCode === 1).length;
  const configErrors = results.filter((result) => result.exitCode === 2 || result.exitCode === null).length;
  const promoted = results.filter((result) => result.promotionDecision === "promote").length;
  const readyLatencies = results
    .map((result) => result.readyLatencyMs)
    .filter((value) => Number.isInteger(value) && value >= 0)
    .sort((left, right) => left - right);

  return {
    attempted,
    evidenceProduced,
    configErrors,
    promoted,
    readinessPassRate: attempted === 0 ? null : Number((promoted / attempted).toFixed(4)),
    readyLatencyMs: {
      samples: readyLatencies.length,
      min: readyLatencies.at(0) ?? null,
      p50: percentile(readyLatencies, 0.5),
      p95: percentile(readyLatencies, 0.95),
      max: readyLatencies.at(-1) ?? null,
    },
  };
}

export function summarizeSegmentSlo(input = {}) {
  const readySloMs = toFiniteNumber(input.readySloMs);
  const canaryAttempts = Array.isArray(input.canaryAttempts)
    ? input.canaryAttempts.filter((result) => result?.attempted)
    : [];
  const singleWriteResults =
    canaryAttempts.length > 0 ? canaryAttempts : input.canaryWrite?.attempted ? [input.canaryWrite] : [];
  const loadResults = Array.isArray(input.loadResults) ? input.loadResults : [];

  return {
    browser: {
      readySloMs,
      singleWrite: summarizeCanarySegmentResults(singleWriteResults, readySloMs),
      load: summarizeCanarySegmentResults(loadResults, readySloMs),
    },
    durableConvergence: summarizeDurableConvergence(input.convergence ?? null, input.convergenceBudgetMs),
    metricGaps: [
      "server-side notify/relay/store/claim segment distributions remain dashboard-joined by correlation window",
    ],
  };
}

export function deriveLoadReadinessDecision(input = {}) {
  const loadSummary = input.loadSummary;
  const loadSegment = input.loadSegment;
  if (!loadSummary || loadSummary.attempted === 0) {
    return null;
  }

  const readinessPassRate = toFiniteNumber(loadSummary.readinessPassRate);
  const promoted = toFiniteNumber(loadSummary.promoted) ?? 0;
  const attempted = toFiniteNumber(loadSummary.attempted) ?? 0;
  if (attempted > 0 && promoted >= attempted && loadSegment?.sloStatus !== "miss") {
    return {
      status: "met-readiness-budget",
      readySloMs: toFiniteNumber(input.readySloMs),
      readinessPassRate,
    };
  }

  return {
    status: "accepted-burst-saturation-degradation",
    decision: "bounded-load-per-write-readiness-is-best-effort-when-durable-convergence-passes",
    reason: "ratified-burst-saturation-slo",
    acceptedBy: "docs/architecture/push-wake-slo-load-proof.md",
    readySloMs: toFiniteNumber(input.readySloMs),
    readinessPassRate,
    durableConvergenceStatus: input.durableConvergence?.status ?? null,
  };
}

export function assertRedactedDrillEvidence(evidence) {
  const serialized = JSON.stringify(evidence);
  const leaks = [];
  for (const pattern of [POSTGRES_URL_PATTERN, EMAIL_PATTERN, BEARER_PATTERN, SESSION_TOKEN_FIELD_PATTERN]) {
    pattern.lastIndex = 0;
    const matches = serialized.match(pattern);
    if (matches) {
      leaks.push(...matches);
    }
  }

  return [...new Set(leaks)];
}

export function renderDrillStepSummary(evidence) {
  const lines = [
    `## Staging wake drill: ${evidence.drillKind}`,
    "",
    `- Verdict: **${evidence.verdict}**${evidence.verdictReasons.length > 0 ? ` (${evidence.verdictReasons.join(", ")})` : ""}`,
    `- Convergence budget: ${evidence.convergenceBudgetMs} ms; converged after: ${
      evidence.convergence?.convergedAfterMs ?? "did not converge"
    }${evidence.convergence?.convergedAfterMs !== null && evidence.convergence?.convergedAfterMs !== undefined ? " ms" : ""}`,
    "",
    "| Source context | Event-store head | Relay cursor gap | Checkpoint gaps (key: gap) |",
    "| --- | --- | --- | --- |",
  ];
  for (const [contextName, audit] of Object.entries(evidence.convergence?.finalSamples ?? {})) {
    lines.push(
      `| ${contextName} | ${audit.head} | ${audit.relayCursorGap ?? "cursor missing"} | ${
        audit.checkpointGaps.map((entry) => `${entry.checkpointKey}: ${entry.gap}`).join("<br>") || "none found"
      } |`,
    );
  }
  if (evidence.loadSummary) {
    lines.push(
      "",
      `Load: ${evidence.loadSummary.attempted} iterations (concurrency ${evidence.loadPlan?.concurrency}), readiness pass rate ${
        evidence.loadSummary.readinessPassRate ?? "n/a"
      }, write-to-ready ms min/p50/p95/max: ${evidence.loadSummary.readyLatencyMs.min ?? "-"}/${
        evidence.loadSummary.readyLatencyMs.p50 ?? "-"
      }/${evidence.loadSummary.readyLatencyMs.p95 ?? "-"}/${evidence.loadSummary.readyLatencyMs.max ?? "-"}`,
    );
  }
  if (evidence.canaryWrite?.attempted && evidence.canaryWrite?.maxAttempts) {
    lines.push(
      "",
      `Single-write canary: ${evidence.canaryWrite.attemptCount ?? 1}/${evidence.canaryWrite.maxAttempts} attempt(s), decision ${evidence.canaryWrite.promotionDecision ?? "unknown"}.`,
    );
  }
  if (evidence.wakeRuntimePreflight?.attempted) {
    const preflight = evidence.wakeRuntimePreflight;
    const lastSample = Array.isArray(preflight.samples) ? preflight.samples.at(-1) : null;
    const lastReasons = lastSample?.reasons?.length ? lastSample.reasons.join(", ") : "none";
    lines.push(
      "",
      `Wake runtime preflight: ${preflight.ready ? "ready" : "not ready"} after ${preflight.sampleCount} samples; ready streak ${preflight.readySampleCount ?? 0}; omitted samples ${preflight.omittedSampleCount ?? 0}; latest reasons: ${lastReasons}.`,
    );
  }
  if (evidence.wakeRuntimeAfterLoad?.attempted) {
    lines.push(
      "",
      `Wake runtime after load: ${
        evidence.wakeRuntimeAfterLoad.ready ? "ready" : "not ready"
      } after ${evidence.wakeRuntimeAfterLoad.readyAfterMs ?? "the configured budget"} ms; samples ${
        evidence.wakeRuntimeAfterLoad.sampleCount
      }.`,
    );
  }
  if (evidence.wakeRuntimeAfterDrill) {
    lines.push(
      "",
      `Wake runtime after drill: ${
        evidence.wakeRuntimeAfterDrill.ready ? "ready" : "not ready"
      }; reasons ${evidence.wakeRuntimeAfterDrill.reasons.join(", ") || "none"}.`,
    );
  }
  if (evidence.segmentSlo) {
    lines.push(
      "",
      `Segment SLO: single-write ${evidence.segmentSlo.browser.singleWrite.sloStatus}; load ${evidence.segmentSlo.browser.load.sloStatus}; durable convergence ${evidence.segmentSlo.durableConvergence.status}.`,
    );
  }
  lines.push(
    "",
    "Interpretation: docs/runbooks/push-wake-recovery-drills.md. Wake-status snapshots and per-iteration canary evidence are in the uploaded drill artifact.",
  );

  return `${lines.join("\n")}\n`;
}

export function buildDrillEvidence(input) {
  const verdictReasons = [...(input.verdictReasons ?? [])];
  const segmentSlo = summarizeSegmentSlo({
    readySloMs: input.readySloMs,
    canaryWrite: input.canaryWrite ?? null,
    canaryAttempts: input.canaryAttempts ?? null,
    loadResults: input.loadResults ?? null,
    convergence: input.convergence ?? null,
    convergenceBudgetMs: input.convergenceBudgetMs,
  });
  const loadReadinessDecision =
    input.loadReadinessDecision ??
    deriveLoadReadinessDecision({
      loadSummary: input.loadSummary,
      loadSegment: segmentSlo.browser.load,
      durableConvergence: segmentSlo.durableConvergence,
      readySloMs: input.readySloMs,
    });

  const evidence = {
    schemaVersion: STAGING_WAKE_DRILLS_VERSION,
    drillKind: input.drillKind,
    environment: "staging",
    checkedAt: input.checkedAt,
    completedAt: input.completedAt,
    correlationPrefix: input.correlationPrefix,
    sourceContexts: input.sourceContexts,
    convergenceProjectionNames: normalizeProjectionNames(input.convergenceProjectionNames),
    convergenceBudgetMs: input.convergenceBudgetMs,
    pollIntervalMs: input.pollIntervalMs,
    wakeRuntimeReadyBudgetMs: input.wakeRuntimeReadyBudgetMs ?? null,
    wakeRuntimeReadyPollIntervalMs: input.wakeRuntimeReadyPollIntervalMs ?? null,
    readySloMs: input.readySloMs ?? null,
    canaryWrite: input.canaryWrite ?? { attempted: false },
    canaryAttempts: input.canaryAttempts ?? [],
    loadPlan: input.loadPlan ?? null,
    loadResults: input.loadResults ?? null,
    loadSummary: input.loadSummary ?? null,
    loadReadinessDecision,
    convergence: input.convergence ?? null,
    segmentSlo,
    wakeRuntimePreflight: input.wakeRuntimePreflight ?? null,
    wakeRuntimeAfterLoad: input.wakeRuntimeAfterLoad ?? null,
    wakeRuntimeAfterDrill: input.wakeRuntimeAfterDrill ?? null,
    wakeStatusBefore: input.wakeStatusBefore ?? null,
    workerStatusBefore: input.workerStatusBefore ?? null,
    workerStatusAfterLoad: input.workerStatusAfterLoad ?? null,
    workerStatusAfter: input.workerStatusAfter ?? null,
    wakeStatusAfter: input.wakeStatusAfter ?? null,
    verdict: verdictReasons.length === 0 ? "pass" : "fail",
    verdictReasons,
    redaction: {
      databaseUrls: "never-recorded",
      adminCredentials: "never-recorded",
      sessionTokens: "never-recorded",
      guestEmails: "never-recorded",
    },
  };

  const leaks = assertRedactedDrillEvidence(evidence);
  if (leaks.length > 0) {
    throw new Error(`Staging wake drill evidence leaked sensitive values: ${leaks.join(", ")}`);
  }

  return evidence;
}

// --- Live adapters (injected in tests through runStagingWakeDrill deps) ---

export async function createDatabaseAudit(options) {
  const { default: pg } = await import("pg");
  const clients = new Map();

  async function clientFor(url) {
    if (!clients.has(url)) {
      const client = new pg.Client(postgresClientConfig(url));
      await client.connect();
      clients.set(url, client);
    }
    return clients.get(url);
  }

  return {
    sampleSourceContext: async (contextName) => {
      const sourceClient = await clientFor(options.contextDatabaseUrls[contextName]);
      const controlClient = await clientFor(options.controlDatabaseUrl);

      const headResult = await sourceClient.query(
        "SELECT COALESCE(MAX(global_position), 0)::text AS head FROM event_store_events WHERE stream_context_name = $1",
        [contextName],
      );
      const cursorResult = await controlClient.query(
        `SELECT last_fanout_position::text AS position,
                owner_id,
                (EXTRACT(EPOCH FROM (now() - updated_at)) * 1000)::double precision AS age_ms
         FROM platform_projection_wake_relay_cursors
         WHERE source_context_name = $1`,
        [contextName],
      );
      const checkpointResult = await sourceClient.query(
        `SELECT checkpoint_key,
                projection_name,
                subscription_version,
                last_global_position::text AS position,
                (EXTRACT(EPOCH FROM (now() - updated_at)) * 1000)::double precision AS age_ms
         FROM event_subscription_checkpoints
         WHERE source_context_name = $1
         ORDER BY checkpoint_key`,
        [contextName],
      );

      return {
        head: headResult.rows[0]?.head ?? "0",
        relayCursor: cursorResult.rows[0]
          ? {
              position: cursorResult.rows[0].position,
              ownerId: cursorResult.rows[0].owner_id,
              ageMs: cursorResult.rows[0].age_ms,
            }
          : null,
        checkpoints: selectActiveCheckpoints(checkpointResult.rows),
      };
    },
    close: async () => {
      for (const client of clients.values()) {
        await client.end().catch(() => undefined);
      }
      clients.clear();
    },
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

export async function fetchWorkerStatusSnapshot(options, fetchImpl = fetch) {
  const workerStatusUrl = normalizeUrl(options.workerStatusUrl);
  if (!workerStatusUrl) {
    return null;
  }

  const statusResponse = await fetchImpl(workerStatusUrl);
  if (!statusResponse.ok) {
    throw new Error(`Worker-status request failed with HTTP ${statusResponse.status}.`);
  }

  return sanitizeWorkerStatusSnapshot(await statusResponse.json());
}

export function sanitizeWorkerStatusSnapshot(snapshot) {
  const record = asRecord(snapshot);
  const generatedAt = normalizeString(record.generatedAt) ?? normalizeString(record.checkedAt) ?? null;
  const generatedAtMs = Date.parse(generatedAt ?? "");
  const workers = asArray(record.workers)
    .map((worker) => sanitizeWorkerHeartbeat(worker, generatedAtMs))
    .filter(Boolean);
  return {
    generatedAt,
    databasePoolPressure: sanitizeDatabasePoolPressure(record.databasePoolPressure),
    capacity: sanitizeCapacity(record.capacity),
    projectionWakeControls: sanitizeProjectionWakeControls(record.projectionWakeControls),
    projectionWakeIntents: sanitizeProjectionWakeIntents(record.projectionWakeIntents),
    projectionWakeIntentBreakdown: asArray(record.projectionWakeIntentBreakdown).map(sanitizeWakeIntentBreakdownRow),
    loops: asArray(record.loops).map(sanitizeLoopStatus).filter(Boolean),
    workerHeartbeatSummary: summarizeSanitizedWorkerHeartbeats(workers),
    workers,
    runners: asArray(record.runners).map(sanitizeRunnerStatus).filter(Boolean),
  };
}

export async function runCanaryWrite(options, iteration) {
  const correlationId = `${options.correlationPrefix}-${iteration}`;
  const canaryOutPath = join(dirname(options.outPath), "canary", `${correlationId}.json`);
  await mkdir(dirname(canaryOutPath), { recursive: true });

  const args = [
    CANARY_SCRIPT_PATH,
    "--environment",
    "staging",
    "--flow",
    options.flow ?? "guest",
    "--base-url",
    options.baseUrl,
    "--fixture-key",
    options.fixtureKey,
    "--timeout-ms",
    String(options.timeoutMs),
    "--ready-slo-ms",
    String(options.readySloMs),
    "--attempts",
    // Reconciliation retries are orchestrated by the wake drill so every
    // attempt has its own correlation id and artifact. Load mode also remains
    // one canary write per configured iteration, preserving the bounded cap.
    "1",
    "--diagnostic-correlation-id",
    correlationId,
    "--out",
    canaryOutPath,
  ];
  if (options.itemPath) {
    args.push("--item-path", options.itemPath);
  } else {
    args.push("--search-query", options.searchQuery);
  }
  if ((options.flow ?? "guest") === "guest") {
    args.push("--guest-email", `wake-drill+${correlationId}@chasesets.test`);
  }
  if (options.skipNegativeProbe) {
    args.push("--skip-negative-probe");
  }

  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });

  let evidence = null;
  try {
    evidence = JSON.parse(await readFile(canaryOutPath, "utf8"));
  } catch {
    evidence = null;
  }

  return {
    iteration,
    correlationId,
    exitCode,
    finalState: evidence?.finalState ?? null,
    promotionDecision: evidence?.promotionDecision ?? null,
    failureReason: evidence?.failureReason ?? null,
    readyLatencyMs: evidence?.readyLatencyMs ?? null,
    segments: evidence?.segments ?? null,
    evidencePath: canaryOutPath,
  };
}

function toCanaryWriteEvidence(result) {
  if (!result) {
    return { attempted: false };
  }

  return {
    attempted: true,
    iteration: result.iteration ?? null,
    correlationId: result.correlationId,
    exitCode: result.exitCode,
    finalState: result.finalState,
    promotionDecision: result.promotionDecision,
    failureReason: result.failureReason,
    readyLatencyMs: result.readyLatencyMs,
    segments: result.segments,
  };
}

function retryableCanaryWriteResult(result) {
  return (
    result?.failureReason === "checkout-ready-slo-exceeded" ||
    result?.failureReason === "browser-navigation-timeout" ||
    result?.failureReason === "platform-temporary-unavailable"
  );
}

function selectReconciliationCanaryWrite(results) {
  return results.find((result) => result.promotionDecision === "promote") ?? results.at(-1) ?? null;
}

export async function runReconciliationCanaryWrites(options, deps) {
  const maxAttempts = clampInteger(
    options.canaryAttempts,
    DEFAULT_RECONCILIATION_CANARY_ATTEMPTS,
    1,
    MAX_RECONCILIATION_CANARY_ATTEMPTS,
  );
  const results = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await deps.runCanaryWrite(options, `w${attempt}`);
    results.push(result);
    if (result.promotionDecision === "promote" || !retryableCanaryWriteResult(result)) {
      break;
    }
  }

  return {
    maxAttempts,
    results,
    selected: selectReconciliationCanaryWrite(results),
  };
}

// --- Drill orchestration ---

export async function pollForConvergence(options, deps) {
  const startedAt = deps.now();
  const deadline = startedAt + options.convergenceBudgetMs;
  const finalSamples = {};
  let convergedAfterMs = null;
  let sampleCount = 0;

  for (;;) {
    sampleCount += 1;
    let allConverged = true;
    for (const contextName of options.sourceContexts) {
      const sample = await deps.sampleSourceContext(contextName);
      const evaluation = evaluateConvergenceSample(sample, {
        projectionNames: options.convergenceProjectionNames,
      });
      finalSamples[contextName] = evaluation;
      if (!evaluation.converged) {
        allConverged = false;
      }
    }

    if (allConverged) {
      convergedAfterMs = Math.max(0, deps.now() - startedAt);
      break;
    }
    if (deps.now() + options.pollIntervalMs > deadline) {
      break;
    }
    await deps.sleep(options.pollIntervalMs);
  }

  return {
    converged: convergedAfterMs !== null,
    convergedAfterMs,
    sampleCount,
    finalSamples,
  };
}

export function evaluateWakeRuntimeReadiness(snapshot) {
  const reasons = [];
  const schedulers = snapshot?.schedulers ?? null;
  const relay = snapshot?.relay ?? null;
  const activeWakeCapableWorkerCount = toFiniteNumber(schedulers?.activeWakeCapableWorkerCount) ?? 0;
  const relayLeaseState = relay?.lease?.state ?? null;
  const relayOwnerId = relay?.lease?.ownerId ?? null;
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
    relayLeaseRenewedAt: relay?.lease?.renewedAt ?? null,
    relayLeaseExpiresAt: relay?.lease?.expiresAt ?? null,
    relayOwnerWorkerState: relayOwnerWorker?.workerState ?? null,
    relayOwnerHeartbeatAgeMs: relayOwnerWorker?.heartbeatAgeMs ?? null,
    reasons,
  };
}

function evaluateWakeRuntimeStability(firstReady, currentReady) {
  const firstRenewedAt = firstReady?.relayLeaseRenewedAt ?? null;
  const currentRenewedAt = currentReady?.relayLeaseRenewedAt ?? null;
  const firstOwnerId = firstReady?.relayOwnerId ?? null;
  const currentOwnerId = currentReady?.relayOwnerId ?? null;
  const requiresLeaseProgress = Boolean(firstRenewedAt && currentRenewedAt);
  const observedRelayLeaseRenewal =
    requiresLeaseProgress &&
    firstOwnerId === currentOwnerId &&
    Date.parse(currentRenewedAt) > Date.parse(firstRenewedAt);
  const observedRelayLeaseTakeover = Boolean(firstOwnerId && currentOwnerId && firstOwnerId !== currentOwnerId);

  return {
    stable: !requiresLeaseProgress || observedRelayLeaseRenewal || observedRelayLeaseTakeover,
    requiresLeaseProgress,
    observedRelayLeaseRenewal,
    observedRelayLeaseTakeover,
    firstRelayOwnerId: firstOwnerId,
    finalRelayOwnerId: currentOwnerId,
    firstRelayLeaseRenewedAt: firstRenewedAt,
    finalRelayLeaseRenewedAt: currentRenewedAt,
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
    workerState: typeof worker.workerState === "string" ? worker.workerState : "unknown",
    heartbeatAgeMs: toFiniteNumber(worker.heartbeatAgeMs),
  };
}

function wakeRuntimePreflightSample(sampleNumber, elapsedMs, evaluation, stability = null) {
  return {
    sampleNumber,
    elapsedMs: Math.max(0, elapsedMs),
    ready: evaluation.ready,
    activeWakeCapableWorkerCount: evaluation.activeWakeCapableWorkerCount,
    relayLeaseState: evaluation.relayLeaseState,
    relayOwnerWorkerState: evaluation.relayOwnerWorkerState ?? null,
    relayOwnerHeartbeatAgeMs: evaluation.relayOwnerHeartbeatAgeMs ?? null,
    relayLeaseRenewedAt: evaluation.relayLeaseRenewedAt ?? null,
    relayLeaseExpiresAt: evaluation.relayLeaseExpiresAt ?? null,
    reasons: evaluation.reasons,
    stability,
  };
}

function appendWakeRuntimePreflightSample(samples, sample, omittedSampleCount) {
  if (samples.length < MAX_WAKE_RUNTIME_PREFLIGHT_SAMPLES) {
    samples.push(sample);
    return omittedSampleCount;
  }

  samples[MAX_WAKE_RUNTIME_PREFLIGHT_SAMPLES - 1] = sample;
  return omittedSampleCount + 1;
}

export async function waitForWakeRuntimeReady(options, deps, initialSnapshot = null) {
  if (!deps.fetchWakeStatus) {
    return {
      attempted: false,
      ready: null,
      readyAfterMs: null,
      sampleCount: 0,
      omittedSampleCount: 0,
      samples: [],
      initial: null,
      final: null,
    };
  }

  const startedAt = deps.now();
  const deadline = startedAt + Math.max(0, options.wakeRuntimeReadyBudgetMs ?? 0);
  const pollIntervalMs = Math.max(250, options.wakeRuntimeReadyPollIntervalMs ?? options.pollIntervalMs ?? 5_000);
  let sampleCount = 0;
  let snapshot = initialSnapshot;
  let initial = null;
  let final = null;
  let firstReady = null;
  let readySampleCount = 0;
  let stability = null;
  const samples = [];
  let omittedSampleCount = 0;

  for (;;) {
    if (!snapshot) {
      try {
        snapshot = await deps.fetchWakeStatus();
      } catch {
        const failed = {
          ready: false,
          activeWakeCapableWorkerCount: 0,
          relayLeaseState: null,
          relayOwnerId: null,
          reasons: ["wake-status-preflight-fetch-failed"],
        };
        const attemptedSampleCount = sampleCount + 1;
        omittedSampleCount = appendWakeRuntimePreflightSample(
          samples,
          wakeRuntimePreflightSample(attemptedSampleCount, deps.now() - startedAt, failed),
          omittedSampleCount,
        );
        return {
          attempted: true,
          ready: false,
          readyAfterMs: null,
          sampleCount: attemptedSampleCount,
          omittedSampleCount,
          samples,
          initial: initial ?? failed,
          final: failed,
        };
      }
    }
    sampleCount += 1;
    const evaluation = evaluateWakeRuntimeReadiness(snapshot);
    initial ??= evaluation;
    final = evaluation;
    if (evaluation.ready) {
      readySampleCount += 1;
      firstReady ??= evaluation;
      stability = evaluateWakeRuntimeStability(firstReady, evaluation);
      omittedSampleCount = appendWakeRuntimePreflightSample(
        samples,
        wakeRuntimePreflightSample(sampleCount, deps.now() - startedAt, evaluation, stability),
        omittedSampleCount,
      );
      if (stability.stable) {
        return {
          attempted: true,
          ready: true,
          readyAfterMs: Math.max(0, deps.now() - startedAt),
          sampleCount,
          readySampleCount,
          omittedSampleCount,
          samples,
          initial,
          final,
          stability,
        };
      }
    } else {
      firstReady = null;
      readySampleCount = 0;
      stability = null;
      omittedSampleCount = appendWakeRuntimePreflightSample(
        samples,
        wakeRuntimePreflightSample(sampleCount, deps.now() - startedAt, evaluation),
        omittedSampleCount,
      );
    }

    const remainingMs = deadline - deps.now();
    if (remainingMs <= 0) {
      break;
    }
    await deps.sleep(Math.min(pollIntervalMs, remainingMs));
    snapshot = null;
  }

  return {
    attempted: true,
    ready: false,
    readyAfterMs: null,
    sampleCount,
    readySampleCount,
    omittedSampleCount,
    samples,
    initial,
    final,
    stability,
  };
}

function appendWakeRuntimeLossReason(verdictReasons, wakeStatusAfter) {
  if (!wakeStatusAfter) {
    return null;
  }

  const runtime = evaluateWakeRuntimeReadiness(wakeStatusAfter);
  if (!runtime.ready) {
    verdictReasons.push("wake-runtime-lost-during-drill");
  }
  return runtime;
}

export function classifyCanaryWriteResult(result) {
  if (result.exitCode === null || result.exitCode === 2) {
    return "canary-write-config-error";
  }
  // Exit 1 with checkout-ready-slo-exceeded still proves a durable write
  // happened (receipt + redirect present); any other failure reason means the
  // write cannot be trusted as the drill's stimulus.
  if (result.failureReason && result.failureReason !== "checkout-ready-slo-exceeded") {
    return "canary-write-unverified";
  }
  return null;
}

export function classifySingleWriteReadinessResult(result, readySloMs) {
  if (!result?.attempted) {
    return null;
  }
  if (result.promotionDecision === "promote") {
    return null;
  }
  const latency = toFiniteNumber(result.readyLatencyMs);
  const budget = toFiniteNumber(readySloMs);
  if (
    latency === null ||
    budget === null ||
    latency > budget ||
    result.failureReason === "checkout-ready-slo-exceeded"
  ) {
    return "checkout-ready-slo-missed";
  }
  return null;
}

export async function runStagingWakeDrill(options, deps) {
  const verdictReasons = [];
  let canaryWrite = { attempted: false };
  let canaryAttempts = [];
  let loadPlan = null;
  let loadResults = null;
  let loadSummary = null;
  let wakeRuntimeAfterLoad = null;
  let wakeRuntimeAfterDrill = null;

  let wakeStatusBefore = await safeWakeStatus(deps, verdictReasons, "before");
  let workerStatusBefore = await safeWorkerStatus(deps, verdictReasons, "before");
  let wakeRuntimePreflight = null;
  const needsRuntimeReady =
    options.drillKind === "load" || (options.drillKind === "reconciliation" && !options.skipCanaryWrite);
  if (needsRuntimeReady && wakeStatusBefore) {
    wakeRuntimePreflight = await waitForWakeRuntimeReady(options, deps, wakeStatusBefore);
    if (wakeRuntimePreflight.ready === true) {
      wakeStatusBefore = await safeWakeStatus(deps, verdictReasons, "before-ready");
      workerStatusBefore = await safeWorkerStatus(deps, verdictReasons, "before-ready");
    } else if (wakeRuntimePreflight.ready === false) {
      verdictReasons.push("wake-runtime-not-ready-before-drill");
    }
  }

  if (wakeRuntimePreflight?.ready === false) {
    const wakeStatusAfterRuntimeMiss = await safeWakeStatus(deps, verdictReasons, "after");
    return buildDrillEvidence({
      drillKind: options.drillKind,
      checkedAt: options.checkedAt,
      completedAt: new Date(deps.now()).toISOString(),
      correlationPrefix: options.correlationPrefix,
      sourceContexts: options.sourceContexts,
      convergenceProjectionNames: options.convergenceProjectionNames,
      convergenceBudgetMs: options.convergenceBudgetMs,
      pollIntervalMs: options.pollIntervalMs,
      wakeRuntimeReadyBudgetMs: options.wakeRuntimeReadyBudgetMs,
      wakeRuntimeReadyPollIntervalMs: options.wakeRuntimeReadyPollIntervalMs,
      readySloMs: options.readySloMs,
      canaryWrite,
      canaryAttempts,
      loadPlan,
      loadResults,
      loadSummary,
      convergence: null,
      wakeRuntimePreflight,
      wakeRuntimeAfterLoad,
      wakeRuntimeAfterDrill,
      wakeStatusBefore: wakeStatusBefore ?? null,
      workerStatusBefore,
      workerStatusAfterLoad: null,
      workerStatusAfter: await safeWorkerStatus(deps, verdictReasons, "after"),
      wakeStatusAfter: wakeStatusAfterRuntimeMiss ?? null,
      verdictReasons,
    });
  }

  if (options.drillKind === "load") {
    loadPlan = clampLoadPlan({ iterations: options.iterations, concurrency: options.concurrency });
    loadResults = await runBoundedLoad(options, deps, loadPlan);
    loadSummary = summarizeLoadResults(loadResults);
    if (loadSummary.configErrors > 0) {
      verdictReasons.push("load-iterations-config-error");
    }
    wakeRuntimeAfterLoad = await waitForWakeRuntimeReady(options, deps);
    if (wakeRuntimeAfterLoad.ready === false) {
      verdictReasons.push("wake-runtime-not-ready-after-load");
    }
  } else if (!options.skipCanaryWrite) {
    const canaryRun = await runReconciliationCanaryWrites(options, deps);
    const writeResult = canaryRun.selected;
    canaryAttempts = canaryRun.results.map(toCanaryWriteEvidence);
    canaryWrite = {
      ...toCanaryWriteEvidence(writeResult),
      attemptCount: canaryAttempts.length,
      maxAttempts: canaryRun.maxAttempts,
    };
    const writeFailure = classifyCanaryWriteResult(writeResult);
    if (writeFailure) {
      verdictReasons.push(writeFailure);
    }
    const readinessFailure = classifySingleWriteReadinessResult(canaryWrite, options.readySloMs);
    if (readinessFailure) {
      verdictReasons.push(readinessFailure);
    }
  }

  const workerStatusAfterLoad =
    options.drillKind === "load" ? await safeWorkerStatus(deps, verdictReasons, "after-load") : null;
  const convergence = await pollForConvergence(options, deps);
  if (!convergence.converged) {
    verdictReasons.push("durable-positions-did-not-converge-within-budget");
  }

  const wakeStatusAfter = await safeWakeStatus(deps, verdictReasons, "after");
  const workerStatusAfter = await safeWorkerStatus(deps, verdictReasons, "after");
  wakeRuntimeAfterDrill = appendWakeRuntimeLossReason(verdictReasons, wakeStatusAfter);

  return buildDrillEvidence({
    drillKind: options.drillKind,
    checkedAt: options.checkedAt,
    completedAt: new Date(deps.now()).toISOString(),
    correlationPrefix: options.correlationPrefix,
    sourceContexts: options.sourceContexts,
    convergenceProjectionNames: options.convergenceProjectionNames,
    convergenceBudgetMs: options.convergenceBudgetMs,
    pollIntervalMs: options.pollIntervalMs,
    wakeRuntimeReadyBudgetMs: options.wakeRuntimeReadyBudgetMs,
    wakeRuntimeReadyPollIntervalMs: options.wakeRuntimeReadyPollIntervalMs,
    readySloMs: options.readySloMs,
    canaryWrite,
    canaryAttempts,
    loadPlan,
    loadResults,
    loadSummary,
    convergence,
    wakeRuntimePreflight,
    wakeRuntimeAfterLoad,
    wakeRuntimeAfterDrill,
    wakeStatusBefore: wakeStatusBefore ?? null,
    workerStatusBefore,
    workerStatusAfterLoad,
    workerStatusAfter,
    wakeStatusAfter: wakeStatusAfter ?? null,
    verdictReasons,
  });
}

async function runBoundedLoad(options, deps, loadPlan) {
  const iterationIds = Array.from({ length: loadPlan.iterations }, (_, index) => `l${index + 1}`);
  const results = [];
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= iterationIds.length) {
        return;
      }
      results.push(await deps.runCanaryWrite({ ...options, skipNegativeProbe: true }, iterationIds[index]));
    }
  }

  await Promise.all(Array.from({ length: loadPlan.concurrency }, () => worker()));
  return results.sort((left, right) =>
    String(left.iteration).localeCompare(String(right.iteration), "en", { numeric: true }),
  );
}

async function safeWakeStatus(deps, verdictReasons, phase) {
  if (!deps.fetchWakeStatus) {
    return null;
  }
  try {
    return await deps.fetchWakeStatus();
  } catch (error) {
    verdictReasons.push(`wake-status-snapshot-${phase}-failed`);
    console.error(JSON.stringify(safeFailureFields("wake-status-snapshot-failed", error)));
    return null;
  }
}

async function safeWorkerStatus(deps, verdictReasons, phase) {
  if (!deps.fetchWorkerStatus) {
    return null;
  }
  try {
    return await deps.fetchWorkerStatus();
  } catch (error) {
    verdictReasons.push(`worker-status-snapshot-${phase}-failed`);
    console.error(JSON.stringify(safeFailureFields("worker-status-snapshot-failed", error)));
    return null;
  }
}

// --- helpers ---

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) {
    return null;
  }
  const rank = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(ratio * sortedValues.length) - 1));
  return sortedValues[rank];
}

function summarizeCanarySegmentResults(results, readySloMs) {
  const attempted = results.length;
  const promoted = results.filter((result) => result.promotionDecision === "promote").length;
  const readyLatencies = sortedNumbers(results.map((result) => result.readyLatencyMs));
  const segments = Object.fromEntries(
    CANARY_BROWSER_SEGMENTS.map((segmentName) => [
      segmentName,
      summarizeNumberSeries(results.map((result) => result.segments?.[segmentName])),
    ]),
  );

  return {
    attempted,
    promoted,
    readinessPassRate: attempted === 0 ? null : Number((promoted / attempted).toFixed(4)),
    readyLatencyMs: summarizeSortedNumbers(readyLatencies),
    segmentLatencyMs: segments,
    sloStatus:
      attempted === 0 || readySloMs === null
        ? "not-measured"
        : readyLatencies.some((value) => value <= readySloMs)
          ? "pass"
          : "miss",
  };
}

function summarizeDurableConvergence(convergence, convergenceBudgetMs) {
  if (!convergence) {
    return {
      budgetMs: toFiniteNumber(convergenceBudgetMs),
      status: "not-measured",
      convergedAfterMs: null,
      sampleCount: 0,
      sourceContexts: {},
    };
  }

  return {
    budgetMs: toFiniteNumber(convergenceBudgetMs),
    status: convergence.converged ? "pass" : "miss",
    convergedAfterMs: toFiniteNumber(convergence.convergedAfterMs),
    sampleCount: toFiniteNumber(convergence.sampleCount) ?? 0,
    sourceContexts: Object.fromEntries(
      Object.entries(convergence.finalSamples ?? {}).map(([contextName, sample]) => [
        contextName,
        {
          relayCursorGap: sample.relayCursorGap ?? null,
          checkpointScope: sample.checkpointScope ?? null,
          maxCheckpointGap: maxBigIntString(sample.checkpointGaps?.map((entry) => entry.gap)),
          laggingCheckpointCount: (sample.checkpointGaps ?? []).filter((entry) => !entry.converged).length,
        },
      ]),
    ),
  };
}

function summarizeNumberSeries(values) {
  return summarizeSortedNumbers(sortedNumbers(values));
}

function summarizeSortedNumbers(values) {
  return {
    samples: values.length,
    min: values.at(0) ?? null,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.at(-1) ?? null,
  };
}

function sortedNumbers(values) {
  return values
    .map((value) => toFiniteNumber(value))
    .filter((value) => value !== null && value >= 0)
    .sort((left, right) => left - right);
}

function maxBigIntString(values = []) {
  let max = null;
  for (const value of values) {
    const parsed = toBigInt(value);
    if (max === null || parsed > max) {
      max = parsed;
    }
  }
  return max === null ? null : max.toString();
}

function readConvergenceProjectionNames(value, fallbackInput) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return defaultConvergenceProjectionNames(fallbackInput);
  }
  if (/^(all|\*)$/i.test(normalized)) {
    return [];
  }
  return normalizeProjectionNames(readCsv(normalized, []));
}

function normalizeProjectionNames(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : []).map((value) => normalizeString(value)).filter((value) => Boolean(value)),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function toBigInt(value) {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readSafeString(value, fallback = null) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return fallback;
  }
  if (matchesSensitivePattern(normalized) || normalized.toLowerCase().includes("sessiontoken")) {
    return fallback;
  }
  return normalized;
}

function matchesSensitivePattern(value) {
  for (const pattern of [POSTGRES_URL_PATTERN, EMAIL_PATTERN, BEARER_PATTERN]) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      return true;
    }
  }
  return false;
}

function sanitizeDatabasePoolPressure(value) {
  const pool = asRecord(value);
  const sanitized = {
    databasePoolMax: toFiniteNumber(pool.databasePoolMax),
    poolCount: toFiniteNumber(pool.poolCount),
    totalClients: toFiniteNumber(pool.totalClients),
    activeClients: toFiniteNumber(pool.activeClients),
    idleClients: toFiniteNumber(pool.idleClients),
    waitingClients: toFiniteNumber(pool.waitingClients),
    waitingPoolCount: toFiniteNumber(pool.waitingPoolCount),
    saturatedPoolCount: toFiniteNumber(pool.saturatedPoolCount),
    pools: asArray(pool.pools).map(sanitizeDatabasePoolPressurePool).filter(Boolean),
  };
  const pressureCounters = [
    "totalClients",
    "activeClients",
    "idleClients",
    "waitingClients",
    "waitingPoolCount",
    "saturatedPoolCount",
  ];
  const unavailableCounters = pressureCounters.filter((counter) => sanitized[counter] === null);
  return {
    ...sanitized,
    counterAvailability: {
      status:
        unavailableCounters.length === 0
          ? "available"
          : unavailableCounters.length === pressureCounters.length
            ? "unavailable"
            : "partial",
      unavailableCounters,
      unavailableReason:
        unavailableCounters.length === 0 ? null : "node-postgres-pool-counters-unavailable-or-not-exposed",
    },
  };
}

function sanitizeDatabasePoolPressurePool(value) {
  const pool = asRecord(value);
  const nameCount = Array.isArray(pool.names) ? pool.names.filter((name) => readSafeString(name)).length : null;
  const hasSignal =
    nameCount !== null ||
    toFiniteNumber(pool.totalClients) !== null ||
    toFiniteNumber(pool.activeClients) !== null ||
    toFiniteNumber(pool.idleClients) !== null ||
    toFiniteNumber(pool.waitingClients) !== null ||
    typeof pool.saturated === "boolean" ||
    typeof pool.waiting === "boolean";
  if (!hasSignal) {
    return null;
  }
  return {
    nameCount,
    totalClients: toFiniteNumber(pool.totalClients),
    activeClients: toFiniteNumber(pool.activeClients),
    idleClients: toFiniteNumber(pool.idleClients),
    waitingClients: toFiniteNumber(pool.waitingClients),
    saturated: typeof pool.saturated === "boolean" ? pool.saturated : null,
    waiting: typeof pool.waiting === "boolean" ? pool.waiting : null,
  };
}

function sanitizeCapacity(value) {
  const capacity = asRecord(value);
  return {
    configuredRunnerConcurrency: toFiniteNumber(capacity.configuredRunnerConcurrency),
    databasePoolMax: toFiniteNumber(capacity.databasePoolMax),
    overPoolCapacity: Boolean(capacity.overPoolCapacity),
  };
}

function sanitizeProjectionWakeControls(value) {
  const controls = asRecord(value);
  const laneRunnerCounts = asRecord(controls.laneRunnerCounts);
  return {
    schedulerEnabled: typeof controls.schedulerEnabled === "boolean" ? controls.schedulerEnabled : null,
    hotLaneReservedRunnerSlots: toFiniteNumber(controls.hotLaneReservedRunnerSlots),
    laneRunnerCounts: Object.fromEntries(
      Object.entries(laneRunnerCounts)
        .map(([lane, count]) => [readSafeString(lane), toFiniteNumber(count)])
        .filter(([lane, count]) => lane && count !== null),
    ),
  };
}

function sanitizeProjectionWakeIntents(value) {
  const summary = asRecord(value);
  return {
    queuedCount: toFiniteNumber(summary.queuedCount),
    claimedCount: toFiniteNumber(summary.claimedCount),
    failedCount: toFiniteNumber(summary.failedCount),
    expiredCount: toFiniteNumber(summary.expiredCount),
    staleClaimCount: toFiniteNumber(summary.staleClaimCount),
    oldestQueuedAgeMs: toFiniteNumber(summary.oldestQueuedAgeMs),
  };
}

function sanitizeWakeIntentBreakdownRow(value) {
  const row = asRecord(value);
  return {
    priorityLane: readSafeString(row.priorityLane),
    origin: readSafeString(row.origin),
    state: readSafeString(row.state),
    intentCount: toFiniteNumber(row.intentCount),
    maxAttemptCount: toFiniteNumber(row.maxAttemptCount),
    oldestAgeMs: toFiniteNumber(row.oldestAgeMs),
  };
}

function sanitizeLoopStatus(value) {
  const loop = asRecord(value);
  const name = readSafeString(loop.name);
  if (!name) {
    return null;
  }
  return {
    name,
    activeRunnerCount: toFiniteNumber(loop.activeRunnerCount),
    maxConcurrentRunners: toFiniteNumber(loop.maxConcurrentRunners),
    activeReservedSlotCount: toFiniteNumber(loop.activeReservedSlotCount),
    reservedRunnerSlots: toFiniteNumber(loop.reservedRunnerSlots),
    leaseMissCount: toFiniteNumber(loop.leaseMissCount),
  };
}

function sanitizeWorkerHeartbeat(value, generatedAtMs = Number.NaN) {
  const worker = asRecord(value);
  const workerKind = readSafeString(worker.workerKind) ?? readSafeString(worker.worker_kind);
  const heartbeatAgeMs =
    toFiniteNumber(worker.heartbeatAgeMs) ??
    toFiniteNumber(worker.heartbeat_age_ms) ??
    computeAgeMs(worker.heartbeatAt ?? worker.heartbeat_at, generatedAtMs);
  const workerState =
    readSafeString(worker.workerState) ??
    readSafeString(worker.worker_state) ??
    inferWorkerHeartbeatState(heartbeatAgeMs);
  if (!workerKind && !workerState && heartbeatAgeMs === null) {
    return null;
  }
  return {
    workerKind,
    workerState,
    heartbeatAgeMs,
    wakeCapable: typeof worker.wakeCapable === "boolean" ? worker.wakeCapable : null,
  };
}

function summarizeSanitizedWorkerHeartbeats(workers) {
  return {
    workerCount: workers.length,
    activeWorkerCount: workers.filter((worker) => worker.workerState === "active").length,
    staleOrExpiredWorkerCount: workers.filter(
      (worker) => worker.workerState === "stale" || worker.workerState === "expired",
    ).length,
    stateSource: workers.some((worker) => worker.heartbeatAgeMs !== null)
      ? "heartbeat-age-threshold"
      : workers.length > 0
        ? "state-field"
        : "not-observed",
    staleHeartbeatAgeMs: WORKER_HEARTBEAT_STALE_AGE_MS,
  };
}

function sanitizeRunnerStatus(value) {
  const runner = asRecord(value);
  const name = readSafeString(runner.name) ?? readSafeString(runner.runnerName) ?? readSafeString(runner.runner_name);
  if (!name) {
    return null;
  }
  const lastError = readSafeString(runner.lastError) ?? readSafeString(runner.last_error);
  return {
    name,
    state: readSafeString(runner.state),
    lastError: lastError?.includes("projection-group-lease-busy") ? "projection-group-lease-busy" : null,
  };
}

function inferWorkerHeartbeatState(heartbeatAgeMs) {
  if (heartbeatAgeMs === null) {
    return null;
  }
  return heartbeatAgeMs > WORKER_HEARTBEAT_STALE_AGE_MS ? "stale" : "active";
}

function computeAgeMs(timestamp, checkedAtMs) {
  if (!Number.isFinite(checkedAtMs)) {
    return null;
  }
  const timestampValue = timestamp instanceof Date ? timestamp.toISOString() : normalizeString(timestamp);
  const timestampMs = Date.parse(timestampValue ?? "");
  if (!Number.isFinite(timestampMs)) {
    return null;
  }
  return Math.max(0, Math.round(checkedAtMs - timestampMs));
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

function readCsv(value, fallback) {
  const entries = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? [...new Set(entries)] : [...fallback];
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function readBoolean(value) {
  return /^(1|true|yes)$/i.test(String(value ?? "").trim());
}

function readFlag(argv, name) {
  return argv.includes(name);
}

async function main(argv, env = process.env) {
  let audit = null;
  try {
    const options = parseStagingWakeDrillArgs(argv, env);
    const errors = validateStagingWakeDrillOptions(options);
    if (errors.length > 0) {
      console.error(errors.join(" "));
      return 2;
    }

    audit = await createDatabaseAudit(options);
    const baseUrl = normalizeUrl(options.baseUrl);
    const adminConfigured = Boolean(normalizeUrl(options.adminBaseUrl));
    const evidence = await runStagingWakeDrill(
      { ...options, baseUrl },
      {
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        sampleSourceContext: audit.sampleSourceContext,
        runCanaryWrite,
        fetchWakeStatus: adminConfigured ? () => fetchWakeStatusSnapshot(options) : null,
        fetchWorkerStatus: normalizeUrl(options.workerStatusUrl) ? () => fetchWorkerStatusSnapshot(options) : null,
      },
    );

    await writeJsonRecord(options.outPath, evidence);
    console.log(JSON.stringify(evidence, null, 2));

    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, renderDrillStepSummary(evidence));
    }

    return evidence.verdict === "pass" ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify(safeFailureFields("staging-wake-drill-failed", error)));
    return 2;
  } finally {
    await audit?.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // pnpm forwards a literal "--" separator to the script; ignore it so
  // `pnpm run wake:drills -- reconciliation` and the bare form both work.
  process.exitCode = await main(process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--")));
}
