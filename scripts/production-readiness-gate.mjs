#!/usr/bin/env node
// Post-deploy production readiness gate.
//
// Polls until the wave source contexts' projection checkpoints reach the
// event-store head (steady state) or a bounded budget expires, so the
// production smoke checks measure steady-state behavior instead of post-deploy
// catch-up. Reuses the read-only reconciliation audit machinery from
// scripts/staging-wake-drills.mjs against the production database URLs the
// deploy job derives from Terraform state.
//
// This gate fails closed when the budget expires so projection-dependent smoke
// assertions do not race post-deploy catch-up. The relay cursor is recorded as
// informational context only and never affects readiness, because production
// runs with the relay killed until push enablement.
//
// Exit codes: 0 ready, 1 budget expired (not ready), 2 configuration error.
import { appendFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";
import { postgresFailureFields } from "./lib/postgres-connection.mjs";
import { assertRedactedDrillEvidence, contextDatabaseEnvName, createDatabaseAudit } from "./staging-wake-drills.mjs";

export const PRODUCTION_READINESS_GATE_VERSION = "production-readiness-gate/v1";
export const DEFAULT_READINESS_BUDGET_MS = 300_000;
export const MIN_READINESS_BUDGET_MS = 5_000;
export const MAX_READINESS_BUDGET_MS = 900_000;
export const DEFAULT_READINESS_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_READINESS_SOURCE_CONTEXTS = Object.freeze(["checkout", "public-presence"]);

export function parseProductionReadinessGateArgs(argv, env = process.env) {
  const sourceContexts = readSourceContexts(
    readOption(argv, "--source-contexts") ?? readEnv("READINESS_GATE_SOURCE_CONTEXTS", env),
    DEFAULT_READINESS_SOURCE_CONTEXTS,
  );

  return {
    sourceContexts,
    budgetMs: clampInteger(
      readOption(argv, "--budget-ms") ?? readEnv("READINESS_GATE_BUDGET_MS", env),
      DEFAULT_READINESS_BUDGET_MS,
      MIN_READINESS_BUDGET_MS,
      MAX_READINESS_BUDGET_MS,
    ),
    pollIntervalMs: clampInteger(
      readOption(argv, "--poll-interval-ms") ?? readEnv("READINESS_GATE_POLL_INTERVAL_MS", env),
      DEFAULT_READINESS_POLL_INTERVAL_MS,
      250,
      30_000,
    ),
    outPath:
      readOption(argv, "--out") ??
      readEnv("READINESS_GATE_OUT", env) ??
      "artifacts/release-health/production-readiness-gate.json",
    controlDatabaseUrl: readEnv("PLATFORM_CONTROL_DATABASE_URL", env),
    contextDatabaseUrls: Object.fromEntries(
      sourceContexts.map((contextName) => [contextName, readEnv(contextDatabaseEnvName(contextName), env)]),
    ),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export function validateProductionReadinessGateOptions(options) {
  const errors = [];

  if (!Array.isArray(options.sourceContexts) || options.sourceContexts.length === 0) {
    errors.push("At least one source context is required (--source-contexts).");
  }
  if (!normalizeString(options.controlDatabaseUrl)) {
    errors.push("PLATFORM_CONTROL_DATABASE_URL is required for the informational relay cursor sample.");
  }
  for (const contextName of options.sourceContexts ?? []) {
    if (!normalizeString(options.contextDatabaseUrls?.[contextName])) {
      errors.push(`${contextDatabaseEnvName(contextName)} is required to audit source context '${contextName}'.`);
    }
  }

  return errors;
}

// Readiness is checkpoint-vs-head convergence only. The relay cursor is
// recorded for context but never a readiness reason: production runs
// polling-only (relay killed) until push enablement, so no cursor row exists
// by design.
export function evaluateReadinessSample(sample) {
  const head = toBigInt(sample.head);
  const reasons = [];

  const checkpoints = sample.checkpoints ?? [];
  if (checkpoints.length === 0) {
    // A context with no events and no checkpoints is vacuously ready - there
    // is nothing to catch up. Only an event head with zero checkpoints means
    // projections have not bootstrapped yet.
    if (toBigInt(sample.head ?? 0) > 0n) {
      reasons.push("no-projection-checkpoints-found");
    }
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
    checkpointGaps,
    relayCursor: sample.relayCursor
      ? { position: String(sample.relayCursor.position), ageMs: toFiniteNumber(sample.relayCursor.ageMs) }
      : null,
    ready: reasons.length === 0,
    reasons,
  };
}

export async function pollForReadiness(options, deps) {
  const startedAt = deps.now();
  const deadline = startedAt + options.budgetMs;
  const finalSamples = {};
  let readyAfterMs = null;
  let sampleCount = 0;

  for (;;) {
    sampleCount += 1;
    let allReady = true;
    for (const contextName of options.sourceContexts) {
      const sample = await deps.sampleSourceContext(contextName);
      const evaluation = evaluateReadinessSample(sample);
      finalSamples[contextName] = evaluation;
      if (!evaluation.ready) {
        allReady = false;
      }
    }

    if (allReady) {
      readyAfterMs = Math.max(0, deps.now() - startedAt);
      break;
    }
    if (deps.now() + options.pollIntervalMs > deadline) {
      break;
    }
    await deps.sleep(options.pollIntervalMs);
  }

  return {
    ready: readyAfterMs !== null,
    readyAfterMs,
    sampleCount,
    finalSamples,
  };
}

export function buildReadinessEvidence(input) {
  const evidence = {
    schemaVersion: PRODUCTION_READINESS_GATE_VERSION,
    environment: "production",
    gateBehavior: "fail-closed",
    checkedAt: input.checkedAt,
    completedAt: input.completedAt,
    sourceContexts: input.sourceContexts,
    budgetMs: input.budgetMs,
    pollIntervalMs: input.pollIntervalMs,
    outcome: input.readiness.ready ? "ready" : "budget-expired",
    readyAfterMs: input.readiness.readyAfterMs,
    sampleCount: input.readiness.sampleCount,
    finalSamples: input.readiness.finalSamples,
    redaction: {
      databaseUrls: "never-recorded",
      adminCredentials: "never-recorded",
    },
  };

  const leaks = assertRedactedDrillEvidence(evidence);
  if (leaks.length > 0) {
    throw new Error(`Production readiness gate evidence leaked sensitive values: ${leaks.join(", ")}`);
  }

  return evidence;
}

export function renderReadinessStepSummary(evidence) {
  const lines = [
    "## Production post-deploy readiness gate",
    "",
    `- Outcome: **${evidence.outcome}** (fail-closed before projection-dependent production smoke asserts)`,
    `- Budget: ${evidence.budgetMs} ms; ready after: ${evidence.readyAfterMs ?? "budget expired"}${
      evidence.readyAfterMs !== null && evidence.readyAfterMs !== undefined ? " ms" : ""
    } across ${evidence.sampleCount} sample(s)`,
    "",
    "| Source context | Event-store head | Checkpoint gaps (key: gap) | Not-ready reasons |",
    "| --- | --- | --- | --- |",
  ];
  for (const [contextName, sample] of Object.entries(evidence.finalSamples ?? {})) {
    lines.push(
      `| ${contextName} | ${sample.head} | ${
        sample.checkpointGaps.map((entry) => `${entry.checkpointKey}: ${entry.gap}`).join("<br>") || "none found"
      } | ${sample.reasons.join(", ") || "—"} |`,
    );
  }
  lines.push(
    "",
    "A budget-expired outcome means the canaries below measure post-deploy catch-up, not steady state — interpret per docs/architecture/push-wake-slo-load-proof.md.",
  );

  return `${lines.join("\n")}\n`;
}

function readCsv(value, fallback) {
  const entries = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? [...new Set(entries)] : [...fallback];
}

function readSourceContexts(value, requiredContexts) {
  return [...new Set([...readCsv(value, requiredContexts), ...requiredContexts])];
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
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

export async function runProductionReadinessGateCommand(argv, env = process.env, dependencies = {}) {
  const createAudit = dependencies.createDatabaseAudit ?? createDatabaseAudit;
  const writeRecord = dependencies.writeJsonRecord ?? writeJsonRecord;
  const log = dependencies.log ?? console.log;
  const logError = dependencies.logError ?? console.error;
  const appendSummary = dependencies.appendFileSync ?? appendFileSync;
  let audit = null;
  try {
    const options = parseProductionReadinessGateArgs(argv, env);
    const errors = validateProductionReadinessGateOptions(options);
    if (errors.length > 0) {
      logError(errors.join(" "));
      return 2;
    }

    audit = await createAudit(options);
    const readiness = await pollForReadiness(options, {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      sampleSourceContext: audit.sampleSourceContext,
    });

    const evidence = buildReadinessEvidence({
      checkedAt: options.checkedAt,
      completedAt: new Date().toISOString(),
      sourceContexts: options.sourceContexts,
      budgetMs: options.budgetMs,
      pollIntervalMs: options.pollIntervalMs,
      readiness,
    });

    await writeRecord(options.outPath, evidence);
    log(JSON.stringify(evidence, null, 2));

    if (env.GITHUB_STEP_SUMMARY) {
      appendSummary(env.GITHUB_STEP_SUMMARY, renderReadinessStepSummary(evidence));
    }

    return evidence.outcome === "ready" ? 0 : 1;
  } catch (error) {
    logError(JSON.stringify(postgresFailureFields(error)));
    return 2;
  } finally {
    await audit?.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runProductionReadinessGateCommand(
    process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--")),
  );
}
