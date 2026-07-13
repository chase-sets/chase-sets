// Live, in-process hot-lag attribution for Platform Operations.
//
// Mirrors the classification heuristic in
// scripts/projection-hot-lag-evidence.mjs (the offline CLI that attributes
// captured worker-status/projection-status artifacts to a primary cause), so
// operators reading either surface see the same primaryCause vocabulary and
// reasoning. The offline script stays the tool of record for redacted CI/log
// artifacts (it also accepts wake-outcome and background-workload-control
// evidence gathered outside a single process). This module answers the same
// question live, from data already reachable inside one worker process, with
// no file I/O and no network calls.
export const PROJECTION_HOT_LAG_EVIDENCE_VERSION = "projection-hot-lag-evidence/v1";

const HOT_LANE_STATES = new Set(["queued", "failed"]);
const BACKGROUND_LOOP_NAMES = new Set(["jobs", "inventory-jobs", "dispatch", "scheduled"]);

export type ProjectionHotLagPrimaryCause =
  | "worker-absent-or-stale"
  | "database-pool-pressure"
  | "projection-repair-needed"
  | "projection-group-lease-contention"
  | "hot-lane-queueing"
  | "background-work-pressure"
  | "no-hot-lag-evidence";

export type ProjectionHotLagConfidence = "high" | "medium" | "low";
export type ProjectionHotLagStatus = "attributed" | "needs-more-evidence" | "not-observed";

export type ProjectionHotLagAttribution = Readonly<{
  primaryCause: ProjectionHotLagPrimaryCause;
  confidence: ProjectionHotLagConfidence;
  status: ProjectionHotLagStatus;
  reasons: readonly string[];
}>;

export type ProjectionHotLagEvidenceInput = Readonly<{
  checkedAt?: string;
  // Same shape as the JSON body of GET /internal/workers/status.
  workerStatus: Record<string, unknown>;
  // Optional structural projection status: an array (or nested object) that
  // may contain blockedStreamCount / poisonEventCount / state fields at any
  // depth, e.g. control-plane projection status snapshot rows or
  // ContextProjectionGroupStatus records. Walked recursively, so callers do
  // not need to reshape their data to match a specific schema.
  projectionStatus?: unknown;
  // Optional redacted wake-outcome counters (deferred / lease-busy),
  // typically only available from log/Grafana exports outside a single
  // process. Live callers may omit this; lease-contention can still be
  // detected from runner last_error text when present.
  wakeOutcomes?: readonly unknown[];
}>;

export type ProjectionHotLagEvidence = Readonly<{
  schemaVersion: typeof PROJECTION_HOT_LAG_EVIDENCE_VERSION;
  checkedAt: string;
  attribution: ProjectionHotLagAttribution;
  signals: Readonly<{
    databasePool: ReturnType<typeof summarizeDatabasePoolSignals>;
    hotLane: Readonly<{
      schedulerEnabled: boolean | null;
      hotLaneRunnerCount: number | null;
      hotLaneReservedRunnerSlots: number | null;
      hotLaneRunnerCountFromControls: number;
      totalQueuedCount: number | null;
      totalFailedCount: number | null;
      hotQueuedIntentCount: number;
      hotApiWaitQueuedIntentCount: number;
      hotIntentFailedCount: number;
      oldestHotQueuedAgeMs: number | null;
      wakesLoop: LoopSignal | null;
    }>;
    projectionGroupLeaseContention: ReturnType<typeof summarizeLeaseContentionSignals>;
    projectionRepair: ReturnType<typeof summarizeProjectionRepairSignals>;
    backgroundPressure: ReturnType<typeof summarizeBackgroundPressureSignals>;
    workerHeartbeats: ReturnType<typeof summarizeWorkerHeartbeatSignals>;
  }>;
  nextActions: readonly string[];
}>;

export function attributeProjectionHotLag(input: ProjectionHotLagEvidenceInput): ProjectionHotLagEvidence {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const checkedAtMs = Date.parse(checkedAt);
  const workerStatus = asRecord(input.workerStatus);
  const wakeOutcomes = asArray(input.wakeOutcomes);

  const databasePool = summarizeDatabasePoolSignals(workerStatus.databasePoolPressure);
  const loops = summarizeLoopSignals(workerStatus.loops);
  const workerHeartbeats = summarizeWorkerHeartbeatSignals([workerStatus]);
  const wakeIntents = summarizeWakeIntentSignals(workerStatus, checkedAtMs);
  const projectionRepair = summarizeProjectionRepairSignals([workerStatus, input.projectionStatus]);
  const leaseContention = summarizeLeaseContentionSignals({
    workerStatus,
    wakeOutcomes,
    hotIntentFailedCount: wakeIntents.hotIntentFailedCount,
  });
  const backgroundPressure = summarizeBackgroundPressureSignals(loops, workerStatus.capacity);

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
    checkedAt,
    attribution,
    signals: {
      databasePool,
      hotLane: {
        schedulerEnabled: readBoolean(asRecord(workerStatus.projectionWakeControls).schedulerEnabled),
        hotLaneRunnerCount: readNumber(asRecord(asRecord(workerStatus.projectionWakeControls).laneRunnerCounts).hot),
        hotLaneReservedRunnerSlots: readNumber(
          asRecord(workerStatus.projectionWakeControls).hotLaneReservedRunnerSlots,
        ),
        hotLaneRunnerCountFromControls: wakeIntents.hotLaneRunnerCount,
        totalQueuedCount: wakeIntents.totalQueuedCount,
        totalFailedCount: wakeIntents.totalFailedCount,
        hotQueuedIntentCount: wakeIntents.hotQueuedIntentCount,
        hotApiWaitQueuedIntentCount: wakeIntents.hotApiWaitQueuedIntentCount,
        hotIntentFailedCount: wakeIntents.hotIntentFailedCount,
        oldestHotQueuedAgeMs: wakeIntents.oldestHotQueuedAgeMs,
        wakesLoop: loops.byName.wakes ?? null,
      },
      projectionGroupLeaseContention: leaseContention,
      projectionRepair,
      backgroundPressure,
      workerHeartbeats,
    },
    nextActions: buildNextActions(attribution.primaryCause),
  };
}

function chooseAttribution(input: {
  databasePool: ReturnType<typeof summarizeDatabasePoolSignals>;
  loops: ReturnType<typeof summarizeLoopSignals>;
  workerHeartbeats: ReturnType<typeof summarizeWorkerHeartbeatSignals>;
  wakeIntents: ReturnType<typeof summarizeWakeIntentSignals>;
  projectionRepair: ReturnType<typeof summarizeProjectionRepairSignals>;
  leaseContention: ReturnType<typeof summarizeLeaseContentionSignals>;
  backgroundPressure: ReturnType<typeof summarizeBackgroundPressureSignals>;
}): ProjectionHotLagAttribution {
  const reasons: string[] = [];
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
      "Hot wake intents are queued, but the live status did not include enough pressure or contention detail.",
    );
    return attribution("hot-lane-queueing", "low", "attributed", reasons);
  }

  if (input.backgroundPressure.saturatedGroups.length > 0) {
    reasons.push(
      `Background groups are saturated (${input.backgroundPressure.saturatedGroups.join(", ")}), but no hot queue was observed.`,
    );
    return attribution("background-work-pressure", "low", "needs-more-evidence", reasons);
  }

  reasons.push("No queued hot intents, DB pressure, projection repair, or lease-contention signal was present.");
  return attribution("no-hot-lag-evidence", "medium", "not-observed", reasons);
}

function attribution(
  primaryCause: ProjectionHotLagPrimaryCause,
  confidence: ProjectionHotLagConfidence,
  status: ProjectionHotLagStatus,
  reasons: readonly string[],
): ProjectionHotLagAttribution {
  return { primaryCause, confidence, status, reasons };
}

function summarizeDatabasePoolSignals(value: unknown) {
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
        (entry) => readBoolean(asRecord(entry).waiting) === true || readBoolean(asRecord(entry).saturated) === true,
      ),
  };
}

type LoopSignal = Readonly<{
  name: string;
  activeRunnerCount: number | null;
  maxConcurrentRunners: number | null;
  activeReservedSlotCount: number | null;
  reservedRunnerSlots: number | null;
  leaseMissCount: number | null;
  saturated: boolean;
}>;

function summarizeLoopSignals(value: unknown) {
  const loops: LoopSignal[] = asArray(value)
    .map((entry): LoopSignal | null => {
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
    .filter((loop): loop is LoopSignal => loop !== null);

  return {
    loops,
    byName: Object.fromEntries(loops.map((loop) => [loop.name, loop])) as Record<string, LoopSignal>,
  };
}

function summarizeWorkerHeartbeatSignals(sources: readonly unknown[]) {
  const workers = sources.flatMap((source) => asArray(asRecord(source).workers));
  const states = workers.map(
    (worker) => readString(asRecord(worker).workerState) ?? readString(asRecord(worker).worker_state),
  );
  const knownStates = states.filter((state): state is string => state !== null);
  return {
    workerCount: workers.length,
    activeWorkerCount: knownStates.length === 0 ? null : knownStates.filter((state) => state === "active").length,
    staleOrExpiredWorkerCount:
      knownStates.length === 0 ? null : knownStates.filter((state) => state === "stale" || state === "expired").length,
  };
}

function summarizeWakeIntentSignals(workerStatus: Record<string, unknown>, checkedAtMs: number) {
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

function summarizeProjectionRepairSignals(sources: readonly unknown[]) {
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

function summarizeLeaseContentionSignals(input: {
  workerStatus: Record<string, unknown>;
  wakeOutcomes: readonly unknown[];
  hotIntentFailedCount: number;
}) {
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

function summarizeBackgroundPressureSignals(loops: ReturnType<typeof summarizeLoopSignals>, capacity: unknown) {
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

function buildNextActions(primaryCause: ProjectionHotLagPrimaryCause): readonly string[] {
  const actions: Record<ProjectionHotLagPrimaryCause, readonly string[]> = {
    "worker-absent-or-stale": [
      "Restore or restart platform-worker before tuning route freshness or projection code.",
      "Re-check this endpoint after a fresh worker heartbeat is visible.",
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
      "Re-check this endpoint while the hot queue is present for a more decisive attribution.",
    ],
    "no-hot-lag-evidence": [
      "Check this endpoint during the lag window; the incident may already be resolved.",
      "Use route freshness audit evidence to confirm the customer-visible timeout still exists.",
    ],
  };
  return actions[primaryCause];
}

function sumEntries(entries: readonly unknown[], propertyName: string): number {
  return entries.reduce((total: number, entry) => total + (readNumber(asRecord(entry)[propertyName]) ?? 0), 0);
}

function computeOldestAgeMs(entries: readonly unknown[], checkedAtMs: number): number | null {
  const directAges = entries
    .map((entry) => readNumber(asRecord(entry).oldestAgeMs))
    .filter((age): age is number => age !== null);
  if (directAges.length > 0) {
    return Math.max(...directAges);
  }
  if (!Number.isFinite(checkedAtMs)) {
    return null;
  }
  const timestamps = entries
    .map((entry) => Date.parse(readString(asRecord(entry).oldestCreatedAt) ?? ""))
    .filter((timestamp) => Number.isFinite(timestamp));
  if (timestamps.length === 0) {
    return null;
  }
  return Math.max(0, checkedAtMs - Math.min(...timestamps));
}

function summarizeDatabasePoolCounterAvailability(pool: Record<string, unknown>) {
  const explicit = asRecord(pool.counterAvailability);
  const explicitStatus = readString(explicit.status);
  const unavailableCounters = asArray(explicit.unavailableCounters)
    .map(readString)
    .filter((counter): counter is string => counter !== null);
  if (explicitStatus) {
    return {
      status: explicitStatus,
      unavailableCounters,
      unavailableReason: readString(explicit.unavailableReason),
    };
  }

  const counters: Record<string, number | null> = {
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

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function positive(value: number | null): boolean {
  return value !== null && value > 0;
}

function visitJson(
  value: unknown,
  onRecord: (record: Record<string, unknown>) => void,
  seen: Set<unknown> = new Set(),
  depth = 0,
): void {
  if (depth > 8 || value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (!Array.isArray(value)) {
    onRecord(value as Record<string, unknown>);
  }
  for (const child of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    visitJson(child, onRecord, seen, depth + 1);
  }
}
