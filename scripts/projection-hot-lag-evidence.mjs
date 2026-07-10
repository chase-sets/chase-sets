#!/usr/bin/env node
// Support-safe projection hot-lag attribution evidence.
//
// Reads redacted endpoint/log exports only. It does not contact databases,
// DigitalOcean, staging, production, or secret-backed services.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const PROJECTION_HOT_LAG_EVIDENCE_VERSION = "projection-hot-lag-evidence/v1";

const DEFAULT_OUT_PATH = "artifacts/projection-hot-lag-evidence.json";
const HOT_LANE_STATES = new Set(["queued", "failed"]);
const BACKGROUND_LOOP_NAMES = new Set(["jobs", "inventory-jobs", "dispatch", "scheduled"]);
const BACKGROUND_WORKLOAD_CONTROL_REQUIREMENTS = Object.freeze([
  {
    key: "representative-commerce-refresh",
    aliases: ["representative commerce refresh", "representative-refresh", "representativeCommerceRefresh"],
  },
  {
    key: "projection-replay-rebuild-backfill",
    aliases: ["projection replay/rebuild/backfill", "projection-repair", "projectionReplayRebuildBackfill"],
  },
  {
    key: "provider-import-promotion-bulk-authoring",
    aliases: ["provider import/promotion and bulk authoring", "provider-bulk", "providerImportPromotionBulkAuthoring"],
  },
  {
    key: "scheduled-dispatch-provider-delivery",
    aliases: ["scheduled/dispatch/provider-delivery loops", "dispatch", "scheduledDispatchProviderDelivery"],
  },
]);
const BACKGROUND_WORKLOAD_CONTROL_FIELDS = Object.freeze(["normalControl", "pauseThrottleEvidence", "hotPathProof"]);

export function parseProjectionHotLagEvidenceArgs(argv, env = process.env) {
  return {
    workerStatusPath: readOption(argv, "--worker-status") ?? env.PROJECTION_HOT_LAG_WORKER_STATUS ?? null,
    projectionStatusPath: readOption(argv, "--projection-status") ?? env.PROJECTION_HOT_LAG_PROJECTION_STATUS ?? null,
    wakeOutcomesPath: readOption(argv, "--wake-outcomes") ?? env.PROJECTION_HOT_LAG_WAKE_OUTCOMES ?? null,
    backgroundControlsPath:
      readOption(argv, "--background-controls") ?? env.PROJECTION_HOT_LAG_BACKGROUND_CONTROLS ?? null,
    outPath: readOption(argv, "--out") ?? env.PROJECTION_HOT_LAG_OUT ?? DEFAULT_OUT_PATH,
    format: readOption(argv, "--format") ?? env.PROJECTION_HOT_LAG_FORMAT ?? "json",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    failOnUnattributed:
      argv.includes("--fail-on-unattributed") || env.PROJECTION_HOT_LAG_FAIL_ON_UNATTRIBUTED === "true",
  };
}

export function buildProjectionHotLagEvidence(input) {
  const checkedAtMs = Date.parse(input.checkedAt);
  const workerStatus = asRecord(input.workerStatus);
  const projectionStatus = asRecord(input.projectionStatus);
  const wakeOutcomes = asArray(input.wakeOutcomes);

  const databasePool = summarizeDatabasePoolSignals(workerStatus.databasePoolPressure);
  const loops = summarizeLoopSignals(workerStatus.loops);
  const workerHeartbeats = summarizeWorkerHeartbeatSignals([workerStatus, projectionStatus]);
  const wakeIntents = summarizeWakeIntentSignals(workerStatus, checkedAtMs);
  const projectionRepair = summarizeProjectionRepairSignals([workerStatus, projectionStatus]);
  const leaseContention = summarizeLeaseContentionSignals({
    workerStatus,
    wakeOutcomes,
    hotIntentFailedCount: wakeIntents.hotIntentFailedCount,
  });
  const backgroundPressure = summarizeBackgroundPressureSignals(loops, workerStatus.capacity);
  const backgroundControls = summarizeBackgroundWorkloadControlPosture(input.backgroundControls);

  const attribution = chooseAttribution({
    databasePool,
    loops,
    workerHeartbeats,
    wakeIntents,
    projectionRepair,
    leaseContention,
    backgroundPressure,
  });

  return {
    schemaVersion: PROJECTION_HOT_LAG_EVIDENCE_VERSION,
    issueNumbers: [2515],
    checkedAt: input.checkedAt,
    sources: {
      workerStatus: input.workerStatusSource ?? "provided",
      projectionStatus: input.projectionStatusSource ?? null,
      wakeOutcomes: input.wakeOutcomesSource ?? null,
      backgroundControls: input.backgroundControlsSource ?? null,
    },
    attribution,
    signals: {
      databasePool,
      hotLane: {
        schedulerEnabled: readBoolean(asRecord(workerStatus.projectionWakeControls).schedulerEnabled),
        hotLaneRunnerCount: readNumber(asRecord(asRecord(workerStatus.projectionWakeControls).laneRunnerCounts).hot),
        hotLaneReservedRunnerSlots: readNumber(
          asRecord(workerStatus.projectionWakeControls).hotLaneReservedRunnerSlots,
        ),
        ...wakeIntents,
        wakesLoop: loops.byName.wakes ?? null,
      },
      projectionGroupLeaseContention: leaseContention,
      projectionRepair,
      backgroundPressure,
      backgroundControls,
      workerHeartbeats,
    },
    nextActions: buildNextActions(attribution.primaryCause),
    redaction: {
      secrets: "not-read",
      databaseUrls: "not-read",
      liveEnvironmentAccess: "not-used",
      wakePayloads: "not-read",
    },
  };
}

export function renderProjectionHotLagMarkdown(evidence) {
  const attribution = evidence.attribution;
  const signals = evidence.signals;
  return [
    "# Projection Hot-Lag Evidence",
    "",
    `Schema: \`${evidence.schemaVersion}\``,
    `Checked at: ${evidence.checkedAt}`,
    "Issue: #2515",
    "",
    "## Attribution",
    "",
    `- Primary cause: **${attribution.primaryCause}**`,
    `- Confidence: ${attribution.confidence}`,
    `- Status: ${attribution.status}`,
    ...attribution.reasons.map((reason) => `- ${reason}`),
    "",
    "## Key Signals",
    "",
    `- DB waiting clients: ${formatNullable(signals.databasePool.waitingClients)}, saturated pools: ${formatNullable(
      signals.databasePool.saturatedPoolCount,
    )}`,
    `- Hot queued intents: ${signals.hotLane.hotQueuedIntentCount}, hot failed/retry intents: ${signals.hotLane.hotIntentFailedCount}`,
    `- Wakes loop active/reserved: ${formatLoop(signals.hotLane.wakesLoop)}`,
    `- Lease contention events: ${signals.projectionGroupLeaseContention.contentionEventCount}`,
    `- Background saturated groups: ${signals.backgroundPressure.saturatedGroups.join(", ") || "none"}`,
    `- Background control posture: ${signals.backgroundControls.status}`,
    `- Projection repair signals: blocked=${signals.projectionRepair.blockedStreamSignalCount}, poison=${signals.projectionRepair.poisonEventSignalCount}, degraded=${signals.projectionRepair.degradedRunnerSignalCount}`,
    "",
  ].join("\n");
}

function chooseAttribution(input) {
  const reasons = [];
  const activeWorkersKnown = input.workerHeartbeats.activeWorkerCount !== null;
  const noActiveWorkers = activeWorkersKnown && input.workerHeartbeats.activeWorkerCount === 0;

  if (noActiveWorkers) {
    reasons.push("No active worker heartbeat was present in the captured status.");
    return attribution("worker-absent-or-stale", "high", "attributed", reasons);
  }

  if (input.databasePool.hasPressure) {
    reasons.push("Database pool counters show waiting clients or saturated pools.");
    if (input.backgroundPressure.saturatedGroups.length > 0) {
      reasons.push(`Background runner groups were saturated: ${input.backgroundPressure.saturatedGroups.join(", ")}.`);
    }
    return attribution("database-pool-pressure", "high", "attributed", reasons);
  }

  if (input.projectionRepair.hasRepairSignals) {
    reasons.push("Projection status includes blocked streams, poison events, or degraded runners.");
    return attribution("projection-repair-needed", "high", "attributed", reasons);
  }

  if (input.leaseContention.hasContention) {
    reasons.push("Wake outcomes or runner errors show projection-group lease contention.");
    return attribution("projection-group-lease-contention", "medium", "attributed", reasons);
  }

  if (input.wakeIntents.hotQueuedIntentCount > 0) {
    const wakesLoop = input.loops.byName.wakes;
    if (wakesLoop?.reservedRunnerSlots === 0 || input.wakeIntents.hotLaneRunnerCount === 0) {
      reasons.push("Hot wake intents are queued while hot-lane capacity is disabled or unreserved.");
      return attribution("hot-lane-queueing", "high", "attributed", reasons);
    }

    if (
      wakesLoop &&
      wakesLoop.reservedRunnerSlots !== null &&
      wakesLoop.activeReservedSlotCount !== null &&
      wakesLoop.activeReservedSlotCount >= wakesLoop.reservedRunnerSlots
    ) {
      reasons.push("Hot wake intents are queued while the reserved hot slot is occupied.");
      return attribution("hot-lane-queueing", "medium", "attributed", reasons);
    }

    if (input.backgroundPressure.saturatedGroups.length > 0) {
      reasons.push(
        `Hot wake intents are queued while background groups are saturated: ${input.backgroundPressure.saturatedGroups.join(", ")}.`,
      );
      return attribution("background-work-pressure", "low", "attributed", reasons);
    }

    if (input.databasePool.counterAvailability.status !== "available") {
      reasons.push(
        `Database pool pressure counters were ${input.databasePool.counterAvailability.status}: ${input.databasePool.counterAvailability.unavailableReason ?? "counter availability unknown"}.`,
      );
    }
    reasons.push(
      "Hot wake intents are queued, but the captured endpoint did not include enough pressure or contention detail.",
    );
    return attribution("hot-lane-queueing", "low", "attributed", reasons);
  }

  if (input.backgroundPressure.saturatedGroups.length > 0) {
    reasons.push(
      `Background groups are saturated (${input.backgroundPressure.saturatedGroups.join(", ")}), but no hot queue was captured.`,
    );
    return attribution("background-work-pressure", "low", "needs-more-evidence", reasons);
  }

  reasons.push("No queued hot intents, DB pressure, projection repair, or lease-contention signal was present.");
  return attribution("no-hot-lag-evidence", "medium", "not-observed", reasons);
}

function attribution(primaryCause, confidence, status, reasons) {
  return {
    primaryCause,
    confidence,
    status,
    reasons,
  };
}

function summarizeDatabasePoolSignals(value) {
  const pool = asRecord(value);
  const counterAvailability = summarizeDatabasePoolCounterAvailability(pool);
  const waitingClients = readNumber(pool.waitingClients);
  const waitingPoolCount = readNumber(pool.waitingPoolCount);
  const saturatedPoolCount = readNumber(pool.saturatedPoolCount);
  return {
    databasePoolMax: readNumber(pool.databasePoolMax),
    poolCount: readNumber(pool.poolCount),
    totalClients: readNumber(pool.totalClients),
    activeClients: readNumber(pool.activeClients),
    idleClients: readNumber(pool.idleClients),
    waitingClients,
    waitingPoolCount,
    saturatedPoolCount,
    counterAvailability,
    hasPressure:
      positive(waitingClients) ||
      positive(waitingPoolCount) ||
      positive(saturatedPoolCount) ||
      asArray(pool.pools).some(
        (entry) => readBoolean(asRecord(entry).waiting) || readBoolean(asRecord(entry).saturated),
      ),
  };
}

function summarizeLoopSignals(value) {
  const loops = asArray(value)
    .map((entry) => {
      const loop = asRecord(entry);
      const name = readString(loop.name);
      if (!name) {
        return null;
      }
      const activeRunnerCount = readNumber(loop.activeRunnerCount);
      const maxConcurrentRunners = readNumber(loop.maxConcurrentRunners);
      return {
        name,
        activeRunnerCount,
        maxConcurrentRunners,
        activeReservedSlotCount: readNumber(loop.activeReservedSlotCount),
        reservedRunnerSlots: readNumber(loop.reservedRunnerSlots),
        leaseMissCount: readNumber(loop.leaseMissCount),
        saturated:
          activeRunnerCount !== null && maxConcurrentRunners !== null && maxConcurrentRunners > 0
            ? activeRunnerCount >= maxConcurrentRunners
            : false,
      };
    })
    .filter(Boolean);

  return {
    loops,
    byName: Object.fromEntries(loops.map((loop) => [loop.name, loop])),
  };
}

function summarizeWorkerHeartbeatSignals(sources) {
  const workers = sources.flatMap((source) => asArray(asRecord(source).workers));
  const states = workers.map(
    (worker) => readString(asRecord(worker).workerState) ?? readString(asRecord(worker).worker_state),
  );
  const knownStates = states.filter(Boolean);
  const summaries = sources.map((source) => asRecord(asRecord(source).workerHeartbeatSummary));
  const summarizedWorkerCount = sumKnownNumbers(summaries.map((summary) => readNumber(summary.workerCount)));
  const summarizedActiveWorkerCount = sumKnownNumbers(
    summaries.map((summary) => readNumber(summary.activeWorkerCount)),
  );
  const summarizedStaleWorkerCount = sumKnownNumbers(
    summaries.map((summary) => readNumber(summary.staleOrExpiredWorkerCount)),
  );
  if (workers.length === 0 && summarizedWorkerCount !== null) {
    return {
      workerCount: summarizedWorkerCount,
      activeWorkerCount: summarizedActiveWorkerCount,
      staleOrExpiredWorkerCount: summarizedStaleWorkerCount,
    };
  }
  return {
    workerCount: workers.length,
    activeWorkerCount: knownStates.length === 0 ? null : knownStates.filter((state) => state === "active").length,
    staleOrExpiredWorkerCount:
      knownStates.length === 0 ? null : knownStates.filter((state) => state === "stale" || state === "expired").length,
  };
}

function summarizeWakeIntentSignals(workerStatus, checkedAtMs) {
  const controls = asRecord(workerStatus.projectionWakeControls);
  const laneCounts = asRecord(controls.laneRunnerCounts);
  const hotLaneRunnerCount = readNumber(laneCounts.hot) ?? 0;
  const breakdown = asArray(workerStatus.projectionWakeIntentBreakdown);
  const summary = asRecord(workerStatus.projectionWakeIntents);

  const hotEntries = breakdown.filter((entry) => {
    const record = asRecord(entry);
    return readString(record.priorityLane) === "hot" && HOT_LANE_STATES.has(readString(record.state) ?? "");
  });
  const hotQueuedIntentCount = sumEntries(
    hotEntries.filter((entry) => readString(asRecord(entry).state) === "queued"),
    "intentCount",
  );
  const hotIntentFailedCount = sumEntries(
    hotEntries.filter((entry) => readString(asRecord(entry).state) === "failed"),
    "intentCount",
  );
  const hotApiWaitQueuedIntentCount = sumEntries(
    hotEntries.filter(
      (entry) => readString(asRecord(entry).origin) === "api-wait" && readString(asRecord(entry).state) === "queued",
    ),
    "intentCount",
  );

  return {
    hotLaneRunnerCount,
    totalQueuedCount: readNumber(summary.queuedCount),
    totalFailedCount: readNumber(summary.failedCount),
    hotQueuedIntentCount,
    hotApiWaitQueuedIntentCount,
    hotIntentFailedCount,
    oldestHotQueuedAgeMs: computeOldestAgeMs(
      hotEntries.filter((entry) => readString(asRecord(entry).state) === "queued"),
      checkedAtMs,
    ),
  };
}

function summarizeProjectionRepairSignals(sources) {
  const repair = {
    blockedStreamSignalCount: 0,
    poisonEventSignalCount: 0,
    degradedRunnerSignalCount: 0,
  };

  visitJson(sources, (record) => {
    if (positive(readNumber(record.blockedStreamCount)) || positive(readNumber(record.blocked_stream_count))) {
      repair.blockedStreamSignalCount += 1;
    }
    if (positive(readNumber(record.poisonEventCount)) || positive(readNumber(record.poison_event_count))) {
      repair.poisonEventSignalCount += 1;
    }
    if (readString(record.state) === "degraded") {
      repair.degradedRunnerSignalCount += 1;
    }
  });

  return {
    ...repair,
    hasRepairSignals:
      repair.blockedStreamSignalCount > 0 || repair.poisonEventSignalCount > 0 || repair.degradedRunnerSignalCount > 0,
  };
}

function summarizeLeaseContentionSignals(input) {
  let contentionEventCount = 0;

  for (const outcome of input.wakeOutcomes) {
    const record = asRecord(outcome);
    const name = readString(record.outcome) ?? readString(record.reason);
    if (name === "deferred" || name === "projection-group-lease-busy") {
      contentionEventCount += readNumber(record.count) ?? 1;
    }
  }

  for (const runner of asArray(input.workerStatus.runners)) {
    const lastError = readString(asRecord(runner).last_error) ?? readString(asRecord(runner).lastError);
    if (lastError?.includes("projection-group-lease-busy")) {
      contentionEventCount += 1;
    }
  }

  return {
    contentionEventCount,
    hotIntentFailedCount: input.hotIntentFailedCount,
    hasContention: contentionEventCount > 0,
  };
}

function summarizeBackgroundPressureSignals(loops, capacity) {
  const saturatedGroups = Object.values(loops.byName)
    .filter((loop) => BACKGROUND_LOOP_NAMES.has(loop.name) && loop.saturated)
    .map((loop) => loop.name);
  return {
    saturatedGroups,
    saturatedGroupCount: saturatedGroups.length,
    configuredRunnerConcurrency: readNumber(asRecord(capacity).configuredRunnerConcurrency),
    databasePoolMax: readNumber(asRecord(capacity).databasePoolMax),
    overPoolCapacity: readBoolean(asRecord(capacity).overPoolCapacity) === true,
  };
}

function summarizeBackgroundWorkloadControlPosture(value) {
  if (value === null || value === undefined) {
    return {
      status: "not-provided",
      workloadCount: 0,
      coveredWorkloads: [],
      missingWorkloads: BACKGROUND_WORKLOAD_CONTROL_REQUIREMENTS.map((requirement) => requirement.key),
      incompleteWorkloads: [],
    };
  }

  const workloads = extractBackgroundWorkloadControlRows(value);
  const byKey = new Map();
  for (const workload of workloads) {
    const key = resolveBackgroundWorkloadKey(workload);
    if (key) {
      byKey.set(key, workload);
    }
  }

  const missingWorkloads = [];
  const incompleteWorkloads = [];
  const coveredWorkloads = [];
  for (const requirement of BACKGROUND_WORKLOAD_CONTROL_REQUIREMENTS) {
    const workload = byKey.get(requirement.key);
    if (!workload) {
      missingWorkloads.push(requirement.key);
      continue;
    }

    const missingFields = BACKGROUND_WORKLOAD_CONTROL_FIELDS.filter((field) => !hasNonEmptyValue(workload[field]));
    if (missingFields.length > 0) {
      incompleteWorkloads.push({
        workload: requirement.key,
        missingFields,
      });
    } else {
      coveredWorkloads.push(requirement.key);
    }
  }

  return {
    status: missingWorkloads.length === 0 && incompleteWorkloads.length === 0 ? "pass" : "incomplete",
    workloadCount: workloads.length,
    coveredWorkloads,
    missingWorkloads,
    incompleteWorkloads,
  };
}

function extractBackgroundWorkloadControlRows(value) {
  const record = asRecord(value);
  if (Array.isArray(value)) {
    return value.map(asRecord).filter((row) => Object.keys(row).length > 0);
  }
  for (const key of ["workloads", "backgroundWorkloads", "controls", "rows"]) {
    const rows = asArray(record[key])
      .map(asRecord)
      .filter((row) => Object.keys(row).length > 0);
    if (rows.length > 0) {
      return rows;
    }
  }
  return Object.entries(record)
    .filter(([, entry]) => isRecord(entry))
    .map(([key, entry]) => ({
      workload: key,
      ...entry,
    }));
}

function resolveBackgroundWorkloadKey(workload) {
  const values = [
    readString(workload.workload),
    readString(workload.key),
    readString(workload.id),
    readString(workload.name),
  ]
    .filter(Boolean)
    .map(normalizeBackgroundWorkloadName);

  for (const requirement of BACKGROUND_WORKLOAD_CONTROL_REQUIREMENTS) {
    const expected = [requirement.key, ...requirement.aliases].map(normalizeBackgroundWorkloadName);
    if (values.some((value) => expected.includes(value))) {
      return requirement.key;
    }
  }
  return null;
}

function normalizeBackgroundWorkloadName(value) {
  return value
    .trim()
    .replaceAll(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function hasNonEmptyValue(value) {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return value !== null && value !== undefined;
}

function buildNextActions(primaryCause) {
  const actions = {
    "worker-absent-or-stale": [
      "Restore or restart platform-worker before tuning route freshness or projection code.",
      "Re-run this evidence command after a fresh worker heartbeat is visible.",
    ],
    "database-pool-pressure": [
      "Reduce projection/job/dispatch concurrency or increase the database pool only with tier headroom evidence.",
      "Keep hot-lane reservations enabled; the current symptom is pool pressure, not missing hot scheduling.",
    ],
    "projection-repair-needed": [
      "Use Projection Operations to retry blocked streams or rebuild the affected projection group.",
      "Do not tune background worker concurrency until blocked/poison projection health is cleared.",
    ],
    "projection-group-lease-contention": [
      "Check whether replay/backfill/representative refresh is holding the same projection-group lease.",
      "Pause or throttle the background owner, then confirm hot wake retries drain.",
    ],
    "hot-lane-queueing": [
      "Confirm WORKER_WAKE_HOT_LANE_RUNNER_COUNT and hotLaneReservedRunnerSlots are nonzero.",
      "If the reserved slot is occupied continuously, raise wake capacity only within the worker DB pool budget.",
    ],
    "background-work-pressure": [
      "Throttle background job lanes first; if DB pressure appears, treat the incident as pool pressure.",
      "Capture another worker status snapshot while the hot queue is present.",
    ],
    "no-hot-lag-evidence": [
      "Capture worker status during the lag window or add wake outcome counters from Grafana/logs.",
      "Use route freshness audit evidence to confirm the customer-visible timeout still exists.",
    ],
  };
  return actions[primaryCause] ?? actions["no-hot-lag-evidence"];
}

function sumEntries(entries, propertyName) {
  return entries.reduce((total, entry) => total + (readNumber(asRecord(entry)[propertyName]) ?? 0), 0);
}

function computeOldestAgeMs(entries, checkedAtMs) {
  const directAges = entries.map((entry) => readNumber(asRecord(entry).oldestAgeMs)).filter((age) => age !== null);
  if (directAges.length > 0) {
    return Math.max(...directAges);
  }
  if (!Number.isFinite(checkedAtMs)) {
    return null;
  }
  const timestamps = entries
    .map((entry) => Date.parse(readString(asRecord(entry).oldestCreatedAt) ?? ""))
    .filter(Number.isFinite);
  if (timestamps.length === 0) {
    return null;
  }
  return Math.max(0, checkedAtMs - Math.min(...timestamps));
}

function summarizeDatabasePoolCounterAvailability(pool) {
  const explicit = asRecord(pool.counterAvailability);
  const explicitStatus = readString(explicit.status);
  const unavailableCounters = asArray(explicit.unavailableCounters).map(readString).filter(Boolean);
  if (explicitStatus) {
    return {
      status: explicitStatus,
      unavailableCounters,
      unavailableReason: readString(explicit.unavailableReason),
    };
  }

  const counters = {
    totalClients: readNumber(pool.totalClients),
    activeClients: readNumber(pool.activeClients),
    idleClients: readNumber(pool.idleClients),
    waitingClients: readNumber(pool.waitingClients),
    waitingPoolCount: readNumber(pool.waitingPoolCount),
    saturatedPoolCount: readNumber(pool.saturatedPoolCount),
  };
  const inferredUnavailableCounters = Object.entries(counters)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  return {
    status:
      inferredUnavailableCounters.length === 0
        ? "available"
        : inferredUnavailableCounters.length === Object.keys(counters).length
          ? "unavailable"
          : "partial",
    unavailableCounters: inferredUnavailableCounters,
    unavailableReason:
      inferredUnavailableCounters.length === 0 ? null : "database-pool-counters-missing-from-worker-status",
  };
}

function sumKnownNumbers(values) {
  const known = values.filter((value) => value !== null);
  if (known.length === 0) {
    return null;
  }
  return known.reduce((total, value) => total + value, 0);
}

function loadJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function asRecord(value) {
  return isRecord(value) ? value : {};
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value) {
  return typeof value === "string" ? value : null;
}

function readBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function positive(value) {
  return value !== null && value > 0;
}

function visitJson(value, onRecord, seen = new Set(), depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (!Array.isArray(value)) {
    onRecord(value);
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    visitJson(child, onRecord, seen, depth + 1);
  }
}

function formatNullable(value) {
  return value === null ? "unknown" : String(value);
}

function formatLoop(loop) {
  if (!loop) {
    return "missing";
  }
  return `${formatNullable(loop.activeRunnerCount)}/${formatNullable(loop.maxConcurrentRunners)} active, ${formatNullable(
    loop.activeReservedSlotCount,
  )}/${formatNullable(loop.reservedRunnerSlots)} reserved`;
}

async function main(argv) {
  const options = parseProjectionHotLagEvidenceArgs(argv);
  if (!["json", "markdown"].includes(options.format)) {
    console.error("--format must be 'json' or 'markdown'.");
    return 2;
  }
  if (!options.workerStatusPath) {
    console.error("--worker-status is required. Capture GET /internal/workers/status to a JSON file first.");
    return 2;
  }

  try {
    const evidence = buildProjectionHotLagEvidence({
      checkedAt: options.checkedAt,
      workerStatus: loadJsonFile(options.workerStatusPath),
      projectionStatus: options.projectionStatusPath ? loadJsonFile(options.projectionStatusPath) : null,
      wakeOutcomes: options.wakeOutcomesPath ? loadJsonFile(options.wakeOutcomesPath) : null,
      backgroundControls: options.backgroundControlsPath ? loadJsonFile(options.backgroundControlsPath) : null,
      workerStatusSource: options.workerStatusPath,
      projectionStatusSource: options.projectionStatusPath,
      wakeOutcomesSource: options.wakeOutcomesPath,
      backgroundControlsSource: options.backgroundControlsPath,
    });

    if (options.format === "markdown") {
      console.log(renderProjectionHotLagMarkdown(evidence));
    } else {
      await writeJsonRecord(options.outPath, evidence);
      console.log(`Wrote projection hot-lag evidence to ${options.outPath}`);
    }

    return options.failOnUnattributed && evidence.attribution.status !== "attributed" ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
