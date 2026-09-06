#!/usr/bin/env node
// Merge-gate verification support for the cancellation-safe merge-gate
// environment (see docs/runbooks/merge-gate-verification.md).
//
// Owns the cancellation-safe merge-gate lifecycle pieces that must be provable
// without a cluster: the fail-before-mutation credential matrix, the cost-wager
// + capacity preflight (unknown cost, missing expiry, or insufficient/unknown
// headroom all fail BEFORE any provider mutation), the atomic gate-namespace
// manifest (labels and annotations created in the same request as the
// namespace, so the label-scoped sweeper contract has no create/label gap),
// phase marks, the per-run `merge-gate-verification-run/v1` instrumentation
// record, and the 10-run proof aggregation.
//
// Deliberately dependency-free beyond scripts/lib so it runs before
// `pnpm install` in workflow preflight jobs. Credential NAMES are passed via
// --require by the workflow step (never hardcoded here) so the step-local
// credential guard in scripts/workflow-provider-credentials.mjs attributes
// each name to the exact step that uses it. No credential value is ever
// printed; the Stripe test-mode probe reports only the detected mode.

import { readFileSync } from "node:fs";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCommitSha, readOption, readRepeatedOptions } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";
import { isStripeTestServerKey } from "./stripe-key-mode.mjs";

export const MERGE_GATE_CONFIG_SCHEMA_VERSION = "merge-gate-verification-config/v1";
export const MERGE_GATE_RUN_RECORD_SCHEMA_VERSION = "merge-gate-verification-run/v1";

export function resolveMergeGateStripeKeyMode(value) {
  return isStripeTestServerKey(value, { allowRestricted: true }) ? "test" : "not-test";
}
export const MERGE_GATE_PROOF_SCHEMA_VERSION = "merge-gate-verification-proof/v1";
export const MERGE_GATE_PREFLIGHT_SCHEMA_VERSION = "merge-gate-preflight/v1";
export const MERGE_GATE_DEFAULT_CONFIG_PATH = "scripts/merge-gate-verification-config.json";
// Ratified with the merge-gate scope fence: the successful-path overhead
// budget for provider preflight plus cleanup, and the run count the proof
// must reach.
export const MERGE_GATE_PROOF_REQUIRED_RUNS = 10;
export const MERGE_GATE_OVERHEAD_BUDGET_MS = 2 * 60 * 1000;
// A checked-in wager expiry may sit at most this far in the future; enforcing
// the bound at runtime also enforces the 30-day check-in rule.
const MAX_WAGER_HORIZON_MS = 31 * 24 * 60 * 60 * 1000;

const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ---------------------------------------------------------------------------
// Resource quantity parsing (Kubernetes CPU/memory quantities).
// ---------------------------------------------------------------------------

export function parseCpuMillicores(value) {
  const text = String(value ?? "").trim();
  if (/^\d+(?:\.\d+)?m$/.test(text)) return Number(text.slice(0, -1));
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1000;
  return null;
}

const memoryUnitMib = new Map([
  ["Ki", 1 / 1024],
  ["Mi", 1],
  ["Gi", 1024],
  ["Ti", 1024 * 1024],
  ["K", 1000 / (1024 * 1024)],
  ["M", 1_000_000 / (1024 * 1024)],
  ["G", 1_000_000_000 / (1024 * 1024)],
]);

export function parseMemoryMib(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!match[2]) return amount / (1024 * 1024);
  return amount * memoryUnitMib.get(match[2]);
}

// ---------------------------------------------------------------------------
// Config + cost wager. Unknown cost or missing expiry fails closed.
// ---------------------------------------------------------------------------

export function validateMergeGateConfig(config, { now = new Date() } = {}) {
  const errors = [];
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return ["config must be a JSON object."];
  }
  if (config.schemaVersion !== MERGE_GATE_CONFIG_SCHEMA_VERSION) {
    return [`config schemaVersion must be ${MERGE_GATE_CONFIG_SCHEMA_VERSION}; readers fail closed on anything else.`];
  }
  if (!Number.isInteger(config.mergeQueueConcurrency) || config.mergeQueueConcurrency < 1) {
    errors.push("mergeQueueConcurrency must be a positive integer.");
  }
  if (typeof config.headroomFactor !== "number" || config.headroomFactor < 1) {
    errors.push("headroomFactor must be a number >= 1 (1.5 encodes the ratified 50% headroom).");
  }
  const requests = config.perRunRequests;
  if (
    typeof requests !== "object" ||
    requests === null ||
    !(Number(requests.cpuMillicores) > 0) ||
    !(Number(requests.memoryMib) > 0)
  ) {
    errors.push("perRunRequests must declare positive cpuMillicores and memoryMib; unknown per-run cost fails closed.");
  }
  const fallback = config.fallbackPreviewNodeAllocatable;
  if (
    typeof fallback !== "object" ||
    fallback === null ||
    !(Number(fallback.cpuMillicores) > 0) ||
    !(Number(fallback.memoryMib) > 0)
  ) {
    errors.push("fallbackPreviewNodeAllocatable must declare positive cpuMillicores and memoryMib.");
  }
  if (typeof config.previewNodePoolName !== "string" || !config.previewNodePoolName.trim()) {
    errors.push("previewNodePoolName must name the autoscaled preview node pool.");
  }
  if (!(Number(config.cleanupDeadlineHours) > 0)) {
    errors.push("cleanupDeadlineHours must be a positive number of hours.");
  }
  if (!(Number(config.orphanSloHours) > 0)) {
    errors.push("orphanSloHours must be a positive number of hours.");
  }

  const wager = config.costWager;
  if (typeof wager !== "object" || wager === null) {
    errors.push("costWager is missing; unknown cost fails preflight.");
  } else {
    if (typeof wager.owner !== "string" || !wager.owner.trim()) {
      errors.push("costWager.owner must name an owner.");
    }
    if (typeof wager.monthlyDollarCeilingUsd !== "number" || wager.monthlyDollarCeilingUsd < 0) {
      errors.push("costWager.monthlyDollarCeilingUsd must be a number; unknown cost fails preflight.");
    }
    if (typeof wager.actionsMinuteRateUsd !== "number" || wager.actionsMinuteRateUsd <= 0) {
      errors.push("costWager.actionsMinuteRateUsd must be a positive number; unknown cost fails preflight.");
    }
    const expiresAt = Date.parse(wager.expiresAt ?? "");
    if (!Number.isFinite(expiresAt)) {
      errors.push("costWager.expiresAt is missing or unparseable; a wager without an expiry fails preflight.");
    } else if (expiresAt <= now.getTime()) {
      errors.push(
        `costWager.expiresAt ${wager.expiresAt} has passed; re-ratify the merge-gate cost wager before running the gate.`,
      );
    } else if (expiresAt - now.getTime() > MAX_WAGER_HORIZON_MS) {
      errors.push(`costWager.expiresAt ${wager.expiresAt} is more than 30 days away; wagers expire within 30 days.`);
    }
  }

  // No permanent capacity increase is authorized for the merge gate. A
  // capacity exception must itself be a complete checked-in wager.
  if (config.capacityException !== null && config.capacityException !== undefined) {
    const exception = config.capacityException;
    if (
      typeof exception !== "object" ||
      typeof exception.owner !== "string" ||
      !exception.owner.trim() ||
      typeof exception.dollarCeilingUsd !== "number" ||
      !Number.isFinite(Date.parse(exception.expiresAt ?? ""))
    ) {
      errors.push("capacityException must declare owner, dollarCeilingUsd, and a parseable expiresAt (or be null).");
    } else {
      const exceptionExpiry = Date.parse(exception.expiresAt);
      if (exceptionExpiry <= now.getTime()) {
        errors.push(`capacityException.expiresAt ${exception.expiresAt} has passed; scale down and remove it.`);
      } else if (exceptionExpiry - now.getTime() > MAX_WAGER_HORIZON_MS) {
        errors.push(`capacityException.expiresAt ${exception.expiresAt} is more than 30 days away.`);
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Capacity headroom. Ratified formula: at least headroomFactor (1.5 = 50%
// headroom) times the configured merge-queue concurrency's per-run requests
// must fit in preview-pool capacity (live allocatable, extended by the
// autoscaler ceiling) minus summed live pod requests — live chase-sets-pr-*
// previews included because they run on the same pool. Insufficient or
// unknown headroom fails before provisioning.
// ---------------------------------------------------------------------------

const PREVIEW_POOL_LABEL_KEY = "chase-sets.com/pool";
const PREVIEW_POOL_LABEL_VALUE = "preview";

export function evaluateMergeGateCapacity({ config, nodes, pods, nodePools }) {
  const errors = [];

  const nodeItems = Array.isArray(nodes?.items) ? nodes.items : null;
  const podItems = Array.isArray(pods?.items) ? pods.items : null;
  const pools = Array.isArray(nodePools) ? nodePools : null;
  if (!nodeItems) errors.push("node listing was unavailable; unknown headroom fails preflight.");
  if (!podItems) errors.push("pod listing was unavailable; unknown headroom fails preflight.");
  if (!pools) errors.push("node-pool listing was unavailable; unknown headroom fails preflight.");
  if (errors.length > 0) return { passed: false, errors };

  const pool = pools.find((candidate) => candidate?.name === config.previewNodePoolName);
  if (!pool || !Number.isInteger(pool.max_nodes ?? pool.maxNodes) || (pool.max_nodes ?? pool.maxNodes) < 1) {
    return {
      passed: false,
      errors: [
        `preview node pool ${JSON.stringify(config.previewNodePoolName)} was not found with a usable max_nodes; unknown headroom fails preflight.`,
      ],
    };
  }
  const maxNodes = pool.max_nodes ?? pool.maxNodes;

  const previewNodes = nodeItems.filter(
    (node) => node?.metadata?.labels?.[PREVIEW_POOL_LABEL_KEY] === PREVIEW_POOL_LABEL_VALUE,
  );
  const previewNodeNames = new Set(previewNodes.map((node) => node.metadata.name));

  let perNodeAllocatable = null;
  for (const node of previewNodes) {
    const cpu = parseCpuMillicores(node?.status?.allocatable?.cpu);
    const memory = parseMemoryMib(node?.status?.allocatable?.memory);
    if (cpu === null || memory === null) {
      return {
        passed: false,
        errors: [
          `node ${node.metadata.name} reports unparseable allocatable resources; unknown headroom fails preflight.`,
        ],
      };
    }
    if (perNodeAllocatable === null || cpu < perNodeAllocatable.cpuMillicores) {
      perNodeAllocatable = { cpuMillicores: cpu, memoryMib: memory };
    }
  }
  // Autoscale-from-zero: with no live preview node the checked-in allocatable
  // estimate stands in; a live node's measured allocatable always wins.
  const nodeAllocatable = perNodeAllocatable ?? {
    cpuMillicores: Number(config.fallbackPreviewNodeAllocatable.cpuMillicores),
    memoryMib: Number(config.fallbackPreviewNodeAllocatable.memoryMib),
  };

  let committedCpu = 0;
  let committedMemory = 0;
  let committedPods = 0;
  for (const pod of podItems) {
    if (!previewNodeNames.has(pod?.spec?.nodeName)) continue;
    const phase = pod?.status?.phase;
    if (phase === "Succeeded" || phase === "Failed") continue;
    committedPods += 1;
    for (const container of pod?.spec?.containers ?? []) {
      committedCpu += parseCpuMillicores(container?.resources?.requests?.cpu) ?? 0;
      committedMemory += parseMemoryMib(container?.resources?.requests?.memory) ?? 0;
    }
  }

  const totalCapacity = {
    cpuMillicores: maxNodes * nodeAllocatable.cpuMillicores,
    memoryMib: maxNodes * nodeAllocatable.memoryMib,
  };
  const available = {
    cpuMillicores: totalCapacity.cpuMillicores - committedCpu,
    memoryMib: totalCapacity.memoryMib - committedMemory,
  };
  const required = {
    cpuMillicores: Math.ceil(
      config.headroomFactor * config.mergeQueueConcurrency * Number(config.perRunRequests.cpuMillicores),
    ),
    memoryMib: Math.ceil(
      config.headroomFactor * config.mergeQueueConcurrency * Number(config.perRunRequests.memoryMib),
    ),
  };

  const shortfalls = [];
  if (available.cpuMillicores < required.cpuMillicores) {
    shortfalls.push(`cpu: available ${available.cpuMillicores}m < required ${required.cpuMillicores}m`);
  }
  if (available.memoryMib < required.memoryMib) {
    shortfalls.push(`memory: available ${Math.round(available.memoryMib)}Mi < required ${required.memoryMib}Mi`);
  }

  return {
    passed: shortfalls.length === 0,
    errors: shortfalls.map((detail) => `insufficient preview-pool headroom (${detail}); refusing to provision.`),
    measurement: {
      poolName: config.previewNodePoolName,
      maxNodes,
      livePreviewNodes: previewNodes.length,
      perNodeAllocatable: nodeAllocatable,
      allocatableSource: perNodeAllocatable ? "live-node" : "config-fallback",
      committed: { cpuMillicores: committedCpu, memoryMib: Math.round(committedMemory), pods: committedPods },
      totalCapacity: { cpuMillicores: totalCapacity.cpuMillicores, memoryMib: Math.round(totalCapacity.memoryMib) },
      available: { cpuMillicores: available.cpuMillicores, memoryMib: Math.round(available.memoryMib) },
      required,
    },
  };
}

// ---------------------------------------------------------------------------
// Atomic gate namespace manifest. Labels + annotations are part of the same
// create request as the namespace so the label-scoped sweeper contract has no
// create-then-label window (the verify kind closed the same gap with a
// label-independent prefix backstop instead).
// ---------------------------------------------------------------------------

export function buildMergeGateNamespaceManifest(input) {
  const runId = String(input.runId ?? "").trim();
  const runAttempt = String(input.runAttempt ?? "").trim();
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(runAttempt)) {
    throw new Error("runId and runAttempt must be positive integers.");
  }
  const repository = String(input.repository ?? "").trim();
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("repository must be an owner/name GitHub repository slug.");
  }
  const candidateSha = String(input.candidateSha ?? "")
    .trim()
    .toLowerCase();
  const candidateTreeSha = String(input.candidateTreeSha ?? "")
    .trim()
    .toLowerCase();
  if (!isCommitSha(candidateSha) || !isCommitSha(candidateTreeSha)) {
    throw new Error("candidateSha and candidateTreeSha must be 40-character git SHAs.");
  }
  const imageDigest = String(input.imageDigest ?? "")
    .trim()
    .toLowerCase();
  if (!IMAGE_DIGEST_PATTERN.test(imageDigest)) {
    throw new Error("imageDigest must be an immutable sha256 image digest.");
  }
  const cleanupDeadlineHours = Number(input.cleanupDeadlineHours);
  if (!(cleanupDeadlineHours >= 0)) {
    throw new Error("cleanupDeadlineHours must be a non-negative number.");
  }
  const createdAt = new Date(input.now ?? new Date());
  if (!Number.isFinite(createdAt.getTime())) {
    throw new Error("now must be a parseable instant.");
  }
  const cleanupDeadline = new Date(createdAt.getTime() + cleanupDeadlineHours * 60 * 60 * 1000);

  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: `chase-sets-gate-${runId}-${runAttempt}`,
      labels: {
        "chasesets.com/purpose": "merge-gate-verification",
        "chasesets.com/run-id": runId,
        "chasesets.com/run-attempt": runAttempt,
      },
      annotations: {
        "chasesets.com/repository": repository,
        "chasesets.com/workflow-run": runId,
        "chasesets.com/workflow-run-attempt": runAttempt,
        "chasesets.com/candidate-sha": candidateSha,
        "chasesets.com/candidate-tree-sha": candidateTreeSha,
        "chasesets.com/image-digest": imageDigest,
        "chasesets.com/created-at": createdAt.toISOString(),
        "chasesets.com/cleanup-deadline": cleanupDeadline.toISOString(),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Phase marks + per-run instrumentation record.
// ---------------------------------------------------------------------------

export function computePhaseDurations(marks) {
  const ordered = [...(Array.isArray(marks) ? marks : [])]
    .filter((mark) => typeof mark?.phase === "string" && Number.isFinite(Date.parse(mark?.at ?? "")))
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const durations = {};
  for (let index = 1; index < ordered.length; index += 1) {
    durations[ordered[index].phase] = Date.parse(ordered[index].at) - Date.parse(ordered[index - 1].at);
  }
  return { ordered, durations };
}

export function buildMergeGateRunRecord(input) {
  const { ordered, durations } = computePhaseDurations(input.marks);
  const startedAt = Number.isFinite(Date.parse(input.jobStartedAt ?? "")) ? Date.parse(input.jobStartedAt) : null;
  const completedAt = ordered.length > 0 ? Date.parse(ordered[ordered.length - 1].at) : null;
  const preflightMs =
    Number.isFinite(Date.parse(input.preflightStartedAt ?? "")) &&
    Number.isFinite(Date.parse(input.preflightCompletedAt ?? ""))
      ? Date.parse(input.preflightCompletedAt) - Date.parse(input.preflightStartedAt)
      : null;
  const cleanupMs =
    typeof durations["webhooks-deleted"] === "number" || typeof durations["teardown-complete"] === "number"
      ? (durations["webhooks-deleted"] ?? 0) + (durations["teardown-complete"] ?? 0)
      : null;
  const overheadMs = preflightMs !== null && cleanupMs !== null ? preflightMs + cleanupMs : null;
  const totalMs = startedAt !== null && completedAt !== null ? Math.max(0, completedAt - startedAt) : null;

  let compute = null;
  if (input.pods && Array.isArray(input.pods.items)) {
    let cpu = 0;
    let memory = 0;
    for (const pod of input.pods.items) {
      for (const container of pod?.spec?.containers ?? []) {
        cpu += parseCpuMillicores(container?.resources?.requests?.cpu) ?? 0;
        memory += parseMemoryMib(container?.resources?.requests?.memory) ?? 0;
      }
    }
    compute = {
      podCount: input.pods.items.length,
      requestedCpuMillicores: cpu,
      requestedMemoryMib: Math.round(memory),
    };
  }

  let peak = null;
  if (typeof input.topOutput === "string" && input.topOutput.trim()) {
    let cpu = 0;
    let memory = 0;
    let parsedRows = 0;
    for (const line of input.topOutput.trim().split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 3) continue;
      const rowCpu = parseCpuMillicores(columns[columns.length - 2]);
      const rowMemory = parseMemoryMib(columns[columns.length - 1]);
      if (rowCpu === null || rowMemory === null) continue;
      parsedRows += 1;
      cpu += rowCpu;
      memory += rowMemory;
    }
    if (parsedRows > 0) {
      peak = { observedCpuMillicores: cpu, observedMemoryMib: Math.round(memory), sampledPods: parsedRows };
    }
  }

  const providerCalls = {};
  for (const entry of input.providerCalls ?? []) {
    const [name, count] = String(entry).split("=");
    if (name && /^\d+$/.test(count ?? "")) providerCalls[name] = Number(count);
  }

  const preflightMinutes = preflightMs !== null ? preflightMs / 60000 : 0;
  const actionsMinutes = totalMs !== null ? Math.max(1, Math.ceil(totalMs / 60000 + preflightMinutes)) : null;
  const actionsMinuteRateUsd = input.config?.costWager?.actionsMinuteRateUsd;
  const estimatedIncrementalCostUsd =
    actionsMinutes !== null && typeof actionsMinuteRateUsd === "number"
      ? Number((actionsMinutes * actionsMinuteRateUsd).toFixed(4))
      : null;

  return {
    schemaVersion: MERGE_GATE_RUN_RECORD_SCHEMA_VERSION,
    repository: input.repository ?? null,
    runId: input.runId ?? null,
    runAttempt: input.runAttempt ?? null,
    namespace: input.namespace ?? null,
    release: input.release ?? null,
    candidateSha: input.candidateSha ?? null,
    candidateTreeSha: input.candidateTreeSha ?? null,
    imageDigest: input.imageDigest ?? null,
    result: input.result ?? null,
    drill: input.drill && input.drill !== "none" ? input.drill : null,
    phases: durations,
    preflightMs,
    cleanupMs,
    overheadMs,
    overheadBudgetMs: MERGE_GATE_OVERHEAD_BUDGET_MS,
    totalMs,
    compute,
    peakUtilization: peak,
    providerCalls,
    actionsMinutes,
    estimatedIncrementalCostUsd,
    generatedAt: new Date(input.now ?? Date.now()).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 10-run proof aggregation.
// ---------------------------------------------------------------------------

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

export function aggregateMergeGateProof(records, options = {}) {
  const requiredRuns = options.requiredRuns ?? MERGE_GATE_PROOF_REQUIRED_RUNS;
  const overheadBudgetMs = options.overheadBudgetMs ?? MERGE_GATE_OVERHEAD_BUDGET_MS;
  const usable = (Array.isArray(records) ? records : []).filter(
    (record) => record?.schemaVersion === MERGE_GATE_RUN_RECORD_SCHEMA_VERSION,
  );
  const successful = usable.filter((record) => record.result === "pass" && !record.drill);

  const totals = successful
    .map((record) => record.totalMs)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const overheads = successful
    .map((record) => record.overheadMs)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const costs = successful
    .map((record) => record.estimatedIncrementalCostUsd)
    .filter((value) => Number.isFinite(value));

  const failures = [];
  if (successful.length < requiredRuns) {
    failures.push(`only ${successful.length} successful non-drill runs recorded; the proof requires ${requiredRuns}.`);
  }
  if (overheads.length < successful.length) {
    failures.push(
      "some successful runs are missing preflight/cleanup instrumentation; every run must record overhead.",
    );
  }
  const overheadP95 = percentile(overheads, 0.95);
  if (overheadP95 !== null && overheadP95 > overheadBudgetMs) {
    failures.push(`p95 preflight+cleanup overhead ${overheadP95}ms exceeds the ${overheadBudgetMs}ms budget.`);
  }

  return {
    schemaVersion: MERGE_GATE_PROOF_SCHEMA_VERSION,
    requiredRuns,
    overheadBudgetMs,
    recordCount: usable.length,
    successfulRunCount: successful.length,
    totalMs: { p50: percentile(totals, 0.5), p95: percentile(totals, 0.95), max: totals.at(-1) ?? null },
    overheadMs: { p50: percentile(overheads, 0.5), p95: overheadP95, max: overheads.at(-1) ?? null },
    estimatedIncrementalCostUsd: {
      perRunMean:
        costs.length > 0 ? Number((costs.reduce((sum, value) => sum + value, 0) / costs.length).toFixed(4)) : null,
      total: costs.length > 0 ? Number(costs.reduce((sum, value) => sum + value, 0).toFixed(4)) : null,
    },
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    generatedAt: new Date(options.now ?? Date.now()).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} at ${filePath} is unreadable or not JSON: ${error.message}`);
  }
}

function loadConfig(argv, { now } = {}) {
  const configPath = readOption(argv, "--config") ?? MERGE_GATE_DEFAULT_CONFIG_PATH;
  const config = readJsonFile(configPath, "merge-gate config");
  const errors = validateMergeGateConfig(config, now ? { now } : {});
  if (errors.length > 0) {
    throw new Error(`merge-gate config ${configPath} failed validation:\n- ${errors.join("\n- ")}`);
  }
  return config;
}

async function main(argv) {
  const [command] = argv;
  const nowOption = readOption(argv, "--now");
  const now = nowOption ? new Date(nowOption) : new Date();

  if (command === "credentials") {
    const required = (readOption(argv, "--require") ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    if (required.length === 0) {
      throw new Error("credentials requires --require <NAME,...> naming every environment-scoped secret.");
    }
    const missing = required.filter((name) => !process.env[name] || !process.env[name].trim());
    const summary = { command: "credentials", required, missing, stripeKeyMode: null };

    const stripeVar = readOption(argv, "--stripe-test-mode-var");
    if (stripeVar && !missing.includes(stripeVar)) {
      const value = process.env[stripeVar] ?? "";
      summary.stripeKeyMode = resolveMergeGateStripeKeyMode(value);
    }

    console.log(JSON.stringify(summary, null, 2));
    if (missing.length > 0) {
      console.error(
        `Refusing to touch any provider: missing merge-gate environment secrets ${missing.join(", ")}. ` +
          "Configure them on the merge-gate GitHub environment before dispatching the gate.",
      );
      process.exitCode = 1;
      return;
    }
    if (stripeVar && summary.stripeKeyMode !== "test") {
      console.error(
        `${stripeVar} is not a Stripe test-mode key; the merge-gate environment only accepts test-mode keys.`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (command === "preflight") {
    let config;
    try {
      config = loadConfig(argv, { now });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    const nodes = readJsonFile(readOption(argv, "--nodes") ?? "", "node listing");
    const pods = readJsonFile(readOption(argv, "--pods") ?? "", "pod listing");
    const nodePools = readJsonFile(readOption(argv, "--node-pools") ?? "", "node-pool listing");
    const capacity = evaluateMergeGateCapacity({ config, nodes, pods, nodePools });
    const record = {
      schemaVersion: MERGE_GATE_PREFLIGHT_SCHEMA_VERSION,
      passed: capacity.passed,
      errors: capacity.errors,
      capacity: capacity.measurement ?? null,
      costWager: {
        owner: config.costWager.owner,
        monthlyDollarCeilingUsd: config.costWager.monthlyDollarCeilingUsd,
        expiresAt: config.costWager.expiresAt,
      },
      checkedAt: now.toISOString(),
    };
    const outPath = readOption(argv, "--out");
    if (outPath) await writeJsonRecord(outPath, record);
    console.log(JSON.stringify(record, null, 2));
    if (!capacity.passed) {
      console.error(capacity.errors.join("\n"));
      process.exitCode = 1;
    }
    return;
  }

  if (command === "namespace-manifest") {
    const config = loadConfig(argv, { now });
    const manifest = buildMergeGateNamespaceManifest({
      runId: readOption(argv, "--run-id"),
      runAttempt: readOption(argv, "--run-attempt"),
      repository: readOption(argv, "--repository"),
      candidateSha: readOption(argv, "--candidate-sha"),
      candidateTreeSha: readOption(argv, "--candidate-tree-sha"),
      imageDigest: readOption(argv, "--image-digest"),
      cleanupDeadlineHours: readOption(argv, "--cleanup-deadline-hours") ?? config.cleanupDeadlineHours,
      now,
    });
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  if (command === "mark") {
    const filePath = readOption(argv, "--file");
    const phase = readOption(argv, "--phase");
    if (!filePath || !phase) throw new Error("mark requires --file and --phase.");
    mkdirSync(path.dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) appendFileSync(filePath, "");
    appendFileSync(filePath, `${JSON.stringify({ phase, at: now.toISOString() })}\n`);
    return;
  }

  if (command === "run-record") {
    const config = loadConfig(argv, { now });
    const phasesPath = readOption(argv, "--phases");
    const marks = [];
    if (phasesPath && existsSync(phasesPath)) {
      for (const line of readFileSync(phasesPath, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          marks.push(JSON.parse(line));
        } catch {
          // A torn write from a cancelled run must not lose the whole record.
        }
      }
    }
    const podsPath = readOption(argv, "--pods");
    const topPath = readOption(argv, "--top");
    const record = buildMergeGateRunRecord({
      config,
      marks,
      repository: readOption(argv, "--repository"),
      runId: readOption(argv, "--run-id"),
      runAttempt: readOption(argv, "--run-attempt"),
      namespace: readOption(argv, "--namespace"),
      release: readOption(argv, "--release"),
      candidateSha: readOption(argv, "--candidate-sha"),
      candidateTreeSha: readOption(argv, "--candidate-tree-sha"),
      imageDigest: readOption(argv, "--image-digest"),
      result: readOption(argv, "--result"),
      drill: readOption(argv, "--drill"),
      jobStartedAt: readOption(argv, "--job-started-at"),
      preflightStartedAt: readOption(argv, "--preflight-started-at"),
      preflightCompletedAt: readOption(argv, "--preflight-completed-at"),
      pods: podsPath && existsSync(podsPath) ? readJsonFile(podsPath, "namespace pod listing") : null,
      topOutput: topPath && existsSync(topPath) ? readFileSync(topPath, "utf8") : null,
      providerCalls: readRepeatedOptions(argv, "--provider-call"),
      now,
    });
    const outPath = readOption(argv, "--out");
    if (outPath) await writeJsonRecord(outPath, record);
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  if (command === "proof") {
    // Positional arguments are run-record paths; skip every --option and its
    // value so an --out target is never mistaken for a record.
    const recordPaths = [];
    for (let index = 1; index < argv.length; index += 1) {
      if (argv[index].startsWith("--")) {
        index += 1;
        continue;
      }
      recordPaths.push(argv[index]);
    }
    const outPath = readOption(argv, "--out");
    const records = recordPaths.map((recordPath) => readJsonFile(recordPath, "merge-gate run record"));
    const proof = aggregateMergeGateProof(records, { now });
    if (outPath) await writeJsonRecord(outPath, proof);
    console.log(JSON.stringify(proof, null, 2));
    if (proof.status !== "pass") process.exitCode = 1;
    return;
  }

  throw new Error(
    "usage: merge-gate-verification.mjs <credentials|preflight|namespace-manifest|mark|run-record|proof> [options]",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
