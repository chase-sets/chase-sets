import type { AttentionItem } from "./contracts";

export type WakeIntentSummary = Readonly<{
  queuedCount: number;
  claimedCount: number;
  failedCount: number;
  expiredCount: number;
  staleClaimCount: number;
  oldestQueuedAt: string | null;
  oldestQueuedAgeMs: number | null;
  oldestClaimedAt: string | null;
}>;

export type WakeIntentBreakdownRow = Readonly<{
  priorityLane: string;
  origin: string;
  state: string;
  intentCount: number;
  oldestCreatedAt: string | null;
  oldestAgeMs: number | null;
  maxAttemptCount: number;
}>;

export type WakeCheckpointSignals = Readonly<{
  readinessCount: number;
  expiredReadinessCount: number;
  latestReadyRecordedAt: string | null;
  latestReadyAgeMs: number | null;
  pendingWaiterCount: number;
  expiredPendingWaiterCount: number;
  satisfiedWaiterCount: number;
  oldestPendingWaiterAt: string | null;
  oldestPendingWaiterAgeMs: number | null;
  pendingWaiterOrigins: readonly Readonly<{ origin: string; waiterCount: number }>[];
}>;

export type WakeStoreStatus = Readonly<{
  available: boolean;
  intentSummary: WakeIntentSummary;
  intentBreakdown: readonly WakeIntentBreakdownRow[];
  checkpointSignals: WakeCheckpointSignals;
}>;

export type WakeRelayLease = Readonly<{
  ownerId: string;
  fencingToken: string;
  acquiredAt: string | null;
  renewedAt: string | null;
  expiresAt: string | null;
  state: string;
}>;

export type WakeRelayCursor = Readonly<{
  sourceContextName: string;
  lastFanOutPosition: string;
  lastRequiredCursor: string | null;
  ownerId: string;
  fencingToken: string;
  updatedAt: string;
  updatedAgeMs: number | null;
  interestIndexVersion: string | null;
  lastAdvanceReason: string | null;
  lastStreamCategory: string | null;
}>;

export type WakeRelayStatus = Readonly<{
  available: boolean;
  activeLeaseName: string;
  lease: WakeRelayLease | null;
  cursors: readonly WakeRelayCursor[];
}>;

export type WakeSchedulerWorker = Readonly<{
  workerId: string;
  workerKind: string;
  workerState: string;
  heartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  wakeRunnerCount: number | null;
  wakeMaxConcurrentRunners: number | null;
}>;

export type WakeSchedulerStatus = Readonly<{
  available: boolean;
  wakeCapableWorkerCount: number;
  activeWakeCapableWorkerCount: number;
  workers: readonly WakeSchedulerWorker[];
}>;

export type WakeRolloutSource = Readonly<{
  sourceContextName: string;
  rolloutState: string;
  phase: string;
  rolloutWave: string;
  priorityLane: string;
  eventStoreWakeNotificationsEnabled: boolean;
  relayFanOutEnabled: boolean;
  affectedProjectionNames: readonly string[];
  disabledReason: string | null;
  optOutReason: string | null;
}>;

export type WakeRolloutStatus = Readonly<{
  eventStoreWakeEmissionEnabledOnHost: boolean;
  summary: Readonly<{
    entryCount: number;
    activeEntryCount: number;
    enabledEventStoreWakeContextCount: number;
    enabledRelayFanOutContextCount: number;
  }>;
  sources: readonly WakeRolloutSource[];
}>;

export type WakeStatusSnapshot = Readonly<{
  generatedAt: string;
  wakeStore: WakeStoreStatus;
  relay: WakeRelayStatus;
  schedulers: WakeSchedulerStatus;
  rollout: WakeRolloutStatus;
}>;

export function normalizeWakeStatusSnapshot(value: unknown): WakeStatusSnapshot {
  const snapshot = isRecord(value) ? value : {};

  return {
    generatedAt: readString(snapshot.generatedAt),
    wakeStore: normalizeWakeStoreStatus(snapshot.wakeStore),
    relay: normalizeWakeRelayStatus(snapshot.relay),
    schedulers: normalizeWakeSchedulerStatus(snapshot.schedulers),
    rollout: normalizeWakeRolloutStatus(snapshot.rollout),
  };
}

export function buildWakeAttentionItems(snapshot: WakeStatusSnapshot | null): readonly AttentionItem[] {
  if (!snapshot) {
    return [];
  }

  const items: AttentionItem[] = [];
  const summary = snapshot.wakeStore.intentSummary;

  if (snapshot.wakeStore.available && summary.failedCount > 0) {
    items.push({
      id: "wake-failed-intents",
      label: "Failed wake intents",
      detail: "Wake intents are retrying after run failures; the scheduler backs off until TTL expiry.",
      tone: "warning",
      count: summary.failedCount,
      targetTab: "wake",
    });
  }

  if (snapshot.wakeStore.available && summary.staleClaimCount > 0) {
    items.push({
      id: "wake-stale-claims",
      label: "Stale wake claims",
      detail: "Claimed wake intents outlived their claim TTL; the owning runner likely stopped mid-run.",
      tone: "warning",
      count: summary.staleClaimCount,
      targetTab: "wake",
    });
  }

  if (snapshot.wakeStore.available && summary.expiredCount > 0) {
    items.push({
      id: "wake-expired-intents",
      label: "Expired wake intents",
      detail: "Wake intents aged out unconsumed. Polling still drains projections; check scheduler and lanes.",
      tone: "accent",
      count: summary.expiredCount,
      targetTab: "wake",
    });
  }

  if (snapshot.wakeStore.available && snapshot.wakeStore.checkpointSignals.expiredPendingWaiterCount > 0) {
    items.push({
      id: "wake-expired-waiters",
      label: "Expired checkpoint waiters",
      detail: "Readiness waiters timed out before their checkpoint advanced; those reads fell back to bounded polls.",
      tone: "accent",
      count: snapshot.wakeStore.checkpointSignals.expiredPendingWaiterCount,
      targetTab: "wake",
    });
  }

  if (snapshot.relay.available && snapshot.relay.lease && snapshot.relay.lease.state === "expired") {
    items.push({
      id: "wake-relay-lease-expired",
      label: "Relay lease expired",
      detail:
        "No live relay owner holds the active lease; standby workers should take over within their retry interval.",
      tone: "warning",
      targetTab: "wake",
    });
  }

  if (
    snapshot.relay.available &&
    !snapshot.relay.lease &&
    snapshot.rollout.summary.enabledRelayFanOutContextCount > 0
  ) {
    items.push({
      id: "wake-relay-lease-missing",
      label: "No active relay lease",
      detail:
        "Registry sources enable relay fan-out but no relay lease exists. Expected where the relay is disabled by environment switch; otherwise check worker logs.",
      tone: "accent",
      targetTab: "wake",
    });
  }

  return items;
}

function normalizeWakeStoreStatus(value: unknown): WakeStoreStatus {
  const status = isRecord(value) ? value : {};
  const intentSummary = isRecord(status.intentSummary) ? status.intentSummary : {};
  const checkpointSignals = isRecord(status.checkpointSignals) ? status.checkpointSignals : {};

  return {
    available: status.available === true,
    intentSummary: {
      queuedCount: readNumber(intentSummary.queuedCount),
      claimedCount: readNumber(intentSummary.claimedCount),
      failedCount: readNumber(intentSummary.failedCount),
      expiredCount: readNumber(intentSummary.expiredCount),
      staleClaimCount: readNumber(intentSummary.staleClaimCount),
      oldestQueuedAt: readNullableString(intentSummary.oldestQueuedAt),
      oldestQueuedAgeMs: readNullableNumber(intentSummary.oldestQueuedAgeMs),
      oldestClaimedAt: readNullableString(intentSummary.oldestClaimedAt),
    },
    intentBreakdown: readArray(status.intentBreakdown).map((entry) => {
      const row = isRecord(entry) ? entry : {};
      return {
        priorityLane: readString(row.priorityLane),
        origin: readString(row.origin),
        state: readString(row.state),
        intentCount: readNumber(row.intentCount),
        oldestCreatedAt: readNullableString(row.oldestCreatedAt),
        oldestAgeMs: readNullableNumber(row.oldestAgeMs),
        maxAttemptCount: readNumber(row.maxAttemptCount),
      };
    }),
    checkpointSignals: {
      readinessCount: readNumber(checkpointSignals.readinessCount),
      expiredReadinessCount: readNumber(checkpointSignals.expiredReadinessCount),
      latestReadyRecordedAt: readNullableString(checkpointSignals.latestReadyRecordedAt),
      latestReadyAgeMs: readNullableNumber(checkpointSignals.latestReadyAgeMs),
      pendingWaiterCount: readNumber(checkpointSignals.pendingWaiterCount),
      expiredPendingWaiterCount: readNumber(checkpointSignals.expiredPendingWaiterCount),
      satisfiedWaiterCount: readNumber(checkpointSignals.satisfiedWaiterCount),
      oldestPendingWaiterAt: readNullableString(checkpointSignals.oldestPendingWaiterAt),
      oldestPendingWaiterAgeMs: readNullableNumber(checkpointSignals.oldestPendingWaiterAgeMs),
      pendingWaiterOrigins: readArray(checkpointSignals.pendingWaiterOrigins).map((entry) => {
        const row = isRecord(entry) ? entry : {};
        return { origin: readString(row.origin), waiterCount: readNumber(row.waiterCount) };
      }),
    },
  };
}

function normalizeWakeRelayStatus(value: unknown): WakeRelayStatus {
  const status = isRecord(value) ? value : {};
  const lease = isRecord(status.lease) ? status.lease : null;

  return {
    available: status.available === true,
    activeLeaseName: readString(status.activeLeaseName),
    lease: lease
      ? {
          ownerId: readString(lease.ownerId),
          fencingToken: readString(lease.fencingToken),
          acquiredAt: readNullableString(lease.acquiredAt),
          renewedAt: readNullableString(lease.renewedAt),
          expiresAt: readNullableString(lease.expiresAt),
          state: readString(lease.state),
        }
      : null,
    cursors: readArray(status.cursors).map((entry) => {
      const cursor = isRecord(entry) ? entry : {};
      return {
        sourceContextName: readString(cursor.sourceContextName),
        lastFanOutPosition: readString(cursor.lastFanOutPosition),
        lastRequiredCursor: readNullableString(cursor.lastRequiredCursor),
        ownerId: readString(cursor.ownerId),
        fencingToken: readString(cursor.fencingToken),
        updatedAt: readString(cursor.updatedAt),
        updatedAgeMs: readNullableNumber(cursor.updatedAgeMs),
        interestIndexVersion: readNullableString(cursor.interestIndexVersion),
        lastAdvanceReason: readNullableString(cursor.lastAdvanceReason),
        lastStreamCategory: readNullableString(cursor.lastStreamCategory),
      };
    }),
  };
}

function normalizeWakeSchedulerStatus(value: unknown): WakeSchedulerStatus {
  const status = isRecord(value) ? value : {};

  return {
    available: status.available === true,
    wakeCapableWorkerCount: readNumber(status.wakeCapableWorkerCount),
    activeWakeCapableWorkerCount: readNumber(status.activeWakeCapableWorkerCount),
    workers: readArray(status.workers).map((entry) => {
      const worker = isRecord(entry) ? entry : {};
      return {
        workerId: readString(worker.workerId),
        workerKind: readString(worker.workerKind),
        workerState: readString(worker.workerState),
        heartbeatAt: readNullableString(worker.heartbeatAt),
        heartbeatAgeMs: readNullableNumber(worker.heartbeatAgeMs),
        wakeRunnerCount: readNullableNumber(worker.wakeRunnerCount),
        wakeMaxConcurrentRunners: readNullableNumber(worker.wakeMaxConcurrentRunners),
      };
    }),
  };
}

function normalizeWakeRolloutStatus(value: unknown): WakeRolloutStatus {
  const status = isRecord(value) ? value : {};
  const summary = isRecord(status.summary) ? status.summary : {};

  return {
    eventStoreWakeEmissionEnabledOnHost: status.eventStoreWakeEmissionEnabledOnHost === true,
    summary: {
      entryCount: readNumber(summary.entryCount),
      activeEntryCount: readNumber(summary.activeEntryCount),
      enabledEventStoreWakeContextCount: readNumber(summary.enabledEventStoreWakeContextCount),
      enabledRelayFanOutContextCount: readNumber(summary.enabledRelayFanOutContextCount),
    },
    sources: readArray(status.sources).map((entry) => {
      const source = isRecord(entry) ? entry : {};
      return {
        sourceContextName: readString(source.sourceContextName),
        rolloutState: readString(source.rolloutState),
        phase: readString(source.phase),
        rolloutWave: readString(source.rolloutWave),
        priorityLane: readString(source.priorityLane),
        eventStoreWakeNotificationsEnabled: source.eventStoreWakeNotificationsEnabled === true,
        relayFanOutEnabled: source.relayFanOutEnabled === true,
        affectedProjectionNames: readArray(source.affectedProjectionNames).map(readString),
        disabledReason: readNullableString(source.disabledReason),
        optOutReason: readNullableString(source.optOutReason),
      };
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readNullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : String(value ?? "");
}

function readNullableString(value: unknown) {
  return value === null || value === undefined ? null : readString(value);
}
