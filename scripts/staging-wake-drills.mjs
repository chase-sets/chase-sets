#!/usr/bin/env node
// Staging push-wake recovery and load drills (#1234 / #1237, Milestone #19).
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
//                   (optionally) generate one synthetic Buy Now write and
//                   prove durable convergence within a bounded budget. This
//                   is the executable missed-notification/missed-fan-out
//                   detection drill from the #1234 review update.
//   load            Bounded synthetic load: N canary iterations at
//                   concurrency C (hard caps), followed by the same
//                   reconciliation convergence audit. Bounded staging load
//                   evidence for #1237; explicitly not a production-like
//                   volume load test.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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
export const DEFAULT_SOURCE_CONTEXTS = Object.freeze(["checkout"]);
export const DEFAULT_FIXTURE_KEY = "staging-guest-buy-now-fixture";
export const DEFAULT_LOAD_ITERATIONS = 6;
export const DEFAULT_LOAD_CONCURRENCY = 2;

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CANARY_SCRIPT_PATH = join(REPO_ROOT, "scripts", "guest-buy-now-freshness-canary.mjs");
const POSTGRES_URL_PATTERN = /postgres(?:ql)?:\/\/[^"'\s]+/gi;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._-]+/g;
const SESSION_TOKEN_FIELD_PATTERN = /"sessionToken"/g;

export function contextDatabaseEnvName(sourceContextName) {
  return `DATABASE_URL_${String(sourceContextName).toUpperCase().replaceAll("-", "_")}`;
}

export function parseStagingWakeDrillArgs(argv, env = process.env) {
  const drillKind = argv[0] && !argv[0].startsWith("--") ? argv[0] : (readEnv("WAKE_DRILL_KIND", env) ?? "");
  const optionArgs = argv[0] && !argv[0].startsWith("--") ? argv.slice(1) : argv;

  return {
    drillKind,
    baseUrl: readOption(optionArgs, "--base-url") ?? readEnv("WAKE_DRILL_BASE_URL", env),
    adminBaseUrl: readOption(optionArgs, "--admin-base-url") ?? readEnv("WAKE_DRILL_ADMIN_BASE_URL", env),
    outPath:
      readOption(optionArgs, "--out") ??
      readEnv("WAKE_DRILL_OUT", env) ??
      `artifacts/wake-drills/staging-wake-drill-${drillKind || "unknown"}.json`,
    sourceContexts: readCsv(
      readOption(optionArgs, "--source-contexts") ?? readEnv("WAKE_DRILL_SOURCE_CONTEXTS", env),
      DEFAULT_SOURCE_CONTEXTS,
    ),
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
    skipCanaryWrite:
      readFlag(optionArgs, "--skip-canary-write") || readBoolean(readEnv("WAKE_DRILL_SKIP_CANARY_WRITE", env)),
    searchQuery:
      readOption(optionArgs, "--search-query") ??
      readEnv("WAKE_DRILL_SEARCH_QUERY", env) ??
      readEnv("GUEST_BUY_NOW_CANARY_SEARCH_QUERY", env) ??
      "charizard",
    itemPath: readOption(optionArgs, "--item-path") ?? readEnv("GUEST_BUY_NOW_CANARY_ITEM_PATH", env),
    fixtureKey:
      readOption(optionArgs, "--fixture-key") ??
      readEnv("GUEST_BUY_NOW_CANARY_FIXTURE_KEY", env) ??
      DEFAULT_FIXTURE_KEY,
    timeoutMs: clampInteger(
      readOption(optionArgs, "--timeout-ms") ?? readEnv("GUEST_BUY_NOW_CANARY_TIMEOUT_MS", env),
      45_000,
      5_000,
      120_000,
    ),
    readySloMs: clampInteger(
      readOption(optionArgs, "--ready-slo-ms") ?? readEnv("GUEST_BUY_NOW_CANARY_READY_SLO_MS", env),
      10_000,
      1_000,
      60_000,
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
      readCsv(
        readOption(optionArgs, "--source-contexts") ?? readEnv("WAKE_DRILL_SOURCE_CONTEXTS", env),
        DEFAULT_SOURCE_CONTEXTS,
      ).map((contextName) => [contextName, readEnv(contextDatabaseEnvName(contextName), env)]),
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

export function evaluateConvergenceSample(sample) {
  const head = toBigInt(sample.head);
  const reasons = [];

  let relayCursorGap = null;
  if (!sample.relayCursor) {
    reasons.push("relay-cursor-missing");
  } else {
    relayCursorGap = head - toBigInt(sample.relayCursor.position);
    if (relayCursorGap > 0n) {
      reasons.push("relay-cursor-behind-event-store-head");
    }
  }

  const checkpoints = sample.checkpoints ?? [];
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

  return {
    head: head.toString(),
    relayCursorPosition: sample.relayCursor ? String(sample.relayCursor.position) : null,
    relayCursorGap: relayCursorGap === null ? null : relayCursorGap.toString(),
    relayCursorAgeMs: sample.relayCursor ? toFiniteNumber(sample.relayCursor.ageMs) : null,
    relayCursorOwnerId: sample.relayCursor ? (sample.relayCursor.ownerId ?? null) : null,
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
  lines.push(
    "",
    "Interpretation: docs/runbooks/push-wake-recovery-drills.md. Wake-status snapshots and per-iteration canary evidence are in the uploaded drill artifact.",
  );

  return `${lines.join("\n")}\n`;
}

export function buildDrillEvidence(input) {
  const verdictReasons = [...(input.verdictReasons ?? [])];

  const evidence = {
    schemaVersion: STAGING_WAKE_DRILLS_VERSION,
    drillKind: input.drillKind,
    environment: "staging",
    checkedAt: input.checkedAt,
    completedAt: input.completedAt,
    correlationPrefix: input.correlationPrefix,
    sourceContexts: input.sourceContexts,
    convergenceBudgetMs: input.convergenceBudgetMs,
    pollIntervalMs: input.pollIntervalMs,
    canaryWrite: input.canaryWrite ?? { attempted: false },
    loadPlan: input.loadPlan ?? null,
    loadResults: input.loadResults ?? null,
    loadSummary: input.loadSummary ?? null,
    convergence: input.convergence ?? null,
    wakeStatusBefore: input.wakeStatusBefore ?? null,
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
      const client = new pg.Client({ connectionString: url });
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
      const evaluation = evaluateConvergenceSample(sample);
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

export async function runStagingWakeDrill(options, deps) {
  const verdictReasons = [];
  let canaryWrite = { attempted: false };
  let loadPlan = null;
  let loadResults = null;
  let loadSummary = null;

  const wakeStatusBefore = await safeWakeStatus(deps, verdictReasons, "before");

  if (options.drillKind === "load") {
    loadPlan = clampLoadPlan({ iterations: options.iterations, concurrency: options.concurrency });
    loadResults = await runBoundedLoad(options, deps, loadPlan);
    loadSummary = summarizeLoadResults(loadResults);
    if (loadSummary.configErrors > 0) {
      verdictReasons.push("load-iterations-config-error");
    }
  } else if (!options.skipCanaryWrite) {
    const writeResult = await deps.runCanaryWrite(options, "w1");
    canaryWrite = {
      attempted: true,
      correlationId: writeResult.correlationId,
      exitCode: writeResult.exitCode,
      finalState: writeResult.finalState,
      promotionDecision: writeResult.promotionDecision,
      failureReason: writeResult.failureReason,
      readyLatencyMs: writeResult.readyLatencyMs,
      segments: writeResult.segments,
    };
    const writeFailure = classifyCanaryWriteResult(writeResult);
    if (writeFailure) {
      verdictReasons.push(writeFailure);
    }
  }

  const convergence = await pollForConvergence(options, deps);
  if (!convergence.converged) {
    verdictReasons.push("durable-positions-did-not-converge-within-budget");
  }

  const wakeStatusAfter = await safeWakeStatus(deps, verdictReasons, "after");

  return buildDrillEvidence({
    drillKind: options.drillKind,
    checkedAt: options.checkedAt,
    completedAt: new Date(deps.now()).toISOString(),
    correlationPrefix: options.correlationPrefix,
    sourceContexts: options.sourceContexts,
    convergenceBudgetMs: options.convergenceBudgetMs,
    pollIntervalMs: options.pollIntervalMs,
    canaryWrite,
    loadPlan,
    loadResults,
    loadSummary,
    convergence,
    wakeStatusBefore: wakeStatusBefore ?? null,
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
    console.error(error instanceof Error ? error.message : String(error));
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

function toBigInt(value) {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
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

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
      },
    );

    await mkdir(dirname(options.outPath), { recursive: true });
    await writeFile(options.outPath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence, null, 2));

    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, renderDrillStepSummary(evidence));
    }

    return evidence.verdict === "pass" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
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
