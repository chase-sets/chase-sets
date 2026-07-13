#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const READ_CONSISTENCY_ROUTE_MATRIX_DEPLOY_WINDOW_VERSION = "read-consistency-route-matrix-deploy-window/v1";

const DEPLOY_WINDOW_STATUSES = ["active", "settled", "unknown"];
const ACTIVE_WORKFLOW_STATUSES = new Set(["queued", "in_progress"]);
const ACTIVE_ROLLOUT_PHASES = new Set(["progressing", "degraded", "paused", "aborted"]);

export function parseReadConsistencyRouteMatrixDeployWindowArgs(argv, env = process.env) {
  return {
    environment:
      readOption(argv, "--environment") ?? readEnv("ROUTE_MATRIX_DEPLOY_WINDOW_ENVIRONMENT", env) ?? "staging",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    githubRunsPath:
      readOption(argv, "--github-runs-file") ?? readEnv("ROUTE_MATRIX_DEPLOY_WINDOW_GITHUB_RUNS_FILE", env),
    argoRolloutsPath:
      readOption(argv, "--argo-rollouts-file") ?? readEnv("ROUTE_MATRIX_DEPLOY_WINDOW_ARGO_ROLLOUTS_FILE", env),
    outPath:
      readOption(argv, "--out") ??
      readEnv("ROUTE_MATRIX_DEPLOY_WINDOW_OUT", env) ??
      "artifacts/wake-drills/read-consistency-route-matrix-deploy-window.json",
  };
}

export async function runReadConsistencyRouteMatrixDeployWindow(options = {}) {
  const githubRuns = await readOptionalJson(options.githubRunsPath);
  const argoRollouts = await readOptionalJson(options.argoRolloutsPath);
  const report = buildRouteMatrixDeployWindowReport({
    environment: options.environment,
    checkedAt: options.checkedAt,
    githubRuns,
    argoRollouts,
    githubRunsAvailable: githubRuns !== null && githubRuns?.available !== false,
    argoRolloutsAvailable: argoRollouts !== null && argoRollouts?.available !== false,
  });
  if (options.outPath) {
    await writeJsonRecord(options.outPath, report);
  }
  return report;
}

export function buildRouteMatrixDeployWindowReport(input = {}) {
  const activeRuns = activeWorkflowRuns(input.githubRuns);
  const activeRollouts = activeArgoRollouts(input.argoRollouts);
  const githubRunsAvailable = input.githubRunsAvailable === true && input.githubRuns?.available !== false;
  const argoRolloutsAvailable = input.argoRolloutsAvailable === true && input.argoRollouts?.available !== false;
  const sourceParts = [];
  if (githubRunsAvailable) {
    sourceParts.push("github-actions");
  }
  if (argoRolloutsAvailable) {
    sourceParts.push("argo-rollouts");
  }

  const status =
    activeRuns.length > 0 || activeRollouts.length > 0 ? "active" : sourceParts.length > 0 ? "settled" : "unknown";

  return {
    schemaVersion: READ_CONSISTENCY_ROUTE_MATRIX_DEPLOY_WINDOW_VERSION,
    environment: normalizeCategory(input.environment) ?? "staging",
    checkedAt: input.checkedAt,
    status,
    source: sourceParts.length > 0 ? sourceParts.join("+") : "unavailable",
    activeRunCount: activeRuns.length,
    activeRolloutCount: activeRollouts.length,
    activeSince: earliestTimestamp([...activeRuns, ...activeRollouts]),
    redaction: {
      supportSafe: true,
      runIds: "not-written",
      rolloutNames: "not-written",
      urls: "not-written",
      secrets: "not-written",
    },
  };
}

export function normalizeRouteMatrixDeployWindow(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const status = DEPLOY_WINDOW_STATUSES.includes(value.status) ? value.status : "unknown";
  return {
    schemaVersion: READ_CONSISTENCY_ROUTE_MATRIX_DEPLOY_WINDOW_VERSION,
    status,
    source: normalizeCategory(value.source) ?? "unavailable",
    activeRunCount: nonNegativeInteger(value.activeRunCount),
    activeRolloutCount: nonNegativeInteger(value.activeRolloutCount),
    activeSince: isIsoTimestamp(value.activeSince) ? value.activeSince : null,
  };
}

function activeWorkflowRuns(value) {
  const runs = Array.isArray(value?.workflow_runs) ? value.workflow_runs : Array.isArray(value) ? value : [];
  return runs.filter((run) => ACTIVE_WORKFLOW_STATUSES.has(normalizeCategory(run?.status)?.toLowerCase()));
}

function activeArgoRollouts(value) {
  const rollouts = Array.isArray(value?.items) ? value.items : Array.isArray(value) ? value : [];
  return rollouts.filter((rollout) =>
    ACTIVE_ROLLOUT_PHASES.has(normalizeCategory(rollout?.status?.phase)?.toLowerCase()),
  );
}

function earliestTimestamp(values) {
  const timestamps = values
    .map((value) => value?.started_at ?? value?.created_at ?? value?.metadata?.creationTimestamp)
    .filter(isIsoTimestamp)
    .sort();
  return timestamps[0] ?? null;
}

async function readOptionalJson(path) {
  if (typeof path !== "string" || path.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function normalizeCategory(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return value.replace(/[^A-Za-z0-9_.:+-]+/g, "_").slice(0, 120) || null;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function isIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && value.includes("T");
}

async function main(argv, env = process.env) {
  try {
    const report = await runReadConsistencyRouteMatrixDeployWindow(
      parseReadConsistencyRouteMatrixDeployWindowArgs(argv, env),
    );
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
