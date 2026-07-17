export type ProjectionState = "idle" | "behind" | "running" | "caught-up" | "degraded" | "error";

export type ProjectionGroupStatus = Readonly<{
  projectionName: string;
  projectionRevision: number;
  storedProjectionRevision: number | null;
  revisionStale: boolean;
  targetContextName: string;
  sourceContextNames: readonly string[];
  ownedTables: readonly string[];
  requiredDuringBootstrap: boolean;
  initialized: boolean;
  caughtUp: boolean;
  state: ProjectionState;
  lastError: string | null;
  outstandingEventCount: string;
  sourceLagEventCount?: string;
  applicableLagEstimate?: string | null;
  blockedStreamCount: number;
  poisonEventCount: number;
  updatedAt: string;
  subscriptions: readonly ProjectionSubscriptionStatus[];
  projectionStatusSource?: string;
  snapshot?: Record<string, unknown>;
}>;

export type ProjectionSubscriptionStatus = Readonly<{
  checkpointKey: string;
  subscriptionName: string;
  projectionName: string;
  sourceContextName: string;
  targetContextName: string;
  subscriptionVersion: number;
  lastGlobalPosition: string;
  sourceHeadGlobalPosition: string;
  outstandingEventCount: string;
  sourceLagEventCount?: string;
  applicableLagEstimate?: string | null;
  state: ProjectionState;
  lastError: string | null;
  blockedStreamCount: number;
  poisonEventCount: number;
}>;

export type BlockedProjectionDetails = Readonly<{
  projectionKey: string;
  blockedStreams: readonly BlockedStream[];
  poisonEvents: readonly PoisonEvent[];
}>;

export type ProjectionOperation = Readonly<{
  operationId: string;
  operationKind: string;
  state: string;
  contextName: string;
  projectionName: string | null;
  projectionKey: string | null;
  streamId: string | null;
  requestedByUserId: string | null;
  claimOwnerId: string | null;
  requestedAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  error: Record<string, unknown> | null;
}>;

export type BlockedStream = Readonly<{
  projectionKey: string;
  streamId: string;
  firstBlockedGlobalPosition: string;
  firstBlockedStreamVersion: number;
  lastSeenGlobalPosition: string;
  deferredEventCount: number;
  state: string;
}>;

export type PoisonEvent = Readonly<{
  eventId: string;
  eventType: string;
  streamId: string;
  streamVersion: number;
  globalPosition: string;
  errorMessage: string;
  retryCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  state: string;
}>;

export type ProjectionOperationsSnapshot = Readonly<{
  summary: Readonly<{
    status: "ok" | "degraded";
    totalGroups: number;
    caughtUpGroups: number;
    behindGroups: number;
    staleGroups: number;
    runningGroups: number;
    errorGroups: number;
    outstandingEventCount: string;
  }>;
  projectionGroups: readonly ProjectionGroupStatus[];
  blockedProjections: readonly BlockedProjectionDetails[];
  workers: readonly Record<string, unknown>[];
  workerHeartbeatHistory: WorkerHeartbeatHistory;
  runners: readonly Record<string, unknown>[];
  operations: readonly ProjectionOperation[];
  operationSummary: ProjectionOperationSummary | null;
  projectionStatusSource: string;
}>;

export type WorkerHeartbeatHistory = Readonly<{
  activeOrStaleCount: number;
  expiredTotalCount: number;
  expiredWithinDiagnosticWindowCount: number;
  expiredReturnedCount: number;
  expiredTruncated: boolean;
  expiredDiagnosticLimit: number;
  diagnosticWindowMs: number;
}>;

export type ProjectionOperationsFilters = Readonly<{
  state: string;
  contextName: string;
  projectionName: string;
  search: string;
  selected: string;
}>;

export type ProjectionRepairQueueItem = Readonly<{
  kind: "operation" | "projection-group" | "poison-event" | "blocked-stream" | "worker";
  targetId: string;
  label: string;
  detail: string;
  state: string;
  tone: "danger" | "warning" | "accent";
  contextName?: string;
  projectionName?: string;
  projectionKey?: string;
  streamId?: string;
}>;

export type ProjectionOperationSummary = Readonly<{
  queuedCount: string;
  runningCount: string;
  failedCount: string;
  cancelRequestedCount: string;
  oldestQueuedAt: string | null;
  oldestRunningAt: string | null;
  averageDurationMs: string | null;
}>;

export type ProjectionSubscriptionRow = ProjectionSubscriptionStatus &
  Readonly<{
    projectionGroupName: string;
    operatorState: ProjectionState;
  }>;

export type AttentionItem = Readonly<{
  id: string;
  label: string;
  detail: string;
  tone: "danger" | "warning" | "accent";
  count?: number | string;
  targetTab: "operations" | "groups" | "subscriptions" | "blocked" | "workers" | "wake" | "diagnostics";
}>;

export function normalizeProjectionOperationsSnapshot(value: unknown): ProjectionOperationsSnapshot {
  const snapshot = isRecord(value) ? value : {};
  const summary = isRecord(snapshot.summary) ? snapshot.summary : {};
  const workerHeartbeatHistory = isRecord(snapshot.workerHeartbeatHistory) ? snapshot.workerHeartbeatHistory : {};

  return {
    summary: {
      status: summary.status === "degraded" ? "degraded" : "ok",
      totalGroups: readNumber(summary.totalGroups),
      caughtUpGroups: readNumber(summary.caughtUpGroups),
      behindGroups: readNumber(summary.behindGroups),
      staleGroups: readNumber(summary.staleGroups),
      runningGroups: readNumber(summary.runningGroups),
      errorGroups: readNumber(summary.errorGroups),
      outstandingEventCount: readString(summary.outstandingEventCount),
    },
    projectionGroups: readArray(snapshot.projectionGroups).map(normalizeProjectionGroupStatus),
    blockedProjections: readArray(snapshot.blockedProjections).map(normalizeBlockedProjectionDetails),
    workers: readArray(snapshot.workers).filter(isRecord),
    workerHeartbeatHistory: {
      activeOrStaleCount: readNumber(workerHeartbeatHistory.activeOrStaleCount),
      expiredTotalCount: readNumber(workerHeartbeatHistory.expiredTotalCount),
      expiredWithinDiagnosticWindowCount: readNumber(workerHeartbeatHistory.expiredWithinDiagnosticWindowCount),
      expiredReturnedCount: readNumber(workerHeartbeatHistory.expiredReturnedCount),
      expiredTruncated: workerHeartbeatHistory.expiredTruncated === true,
      expiredDiagnosticLimit: readNumber(workerHeartbeatHistory.expiredDiagnosticLimit),
      diagnosticWindowMs: readNumber(workerHeartbeatHistory.diagnosticWindowMs),
    },
    runners: readArray(snapshot.runners).filter(isRecord),
    operations: readArray(snapshot.operations).map(normalizeProjectionOperation),
    operationSummary: normalizeProjectionOperationSummary(snapshot.operationSummary),
    projectionStatusSource: readString(snapshot.projectionStatusSource || "runtime-memory"),
  };
}

export function resolveProjectionOperatorState(
  subscriptionState: ProjectionState,
  runnerState: string | undefined,
): ProjectionState {
  if (subscriptionState === "behind" && runnerState === "running") {
    return "running";
  }

  return subscriptionState;
}

export function buildProjectionSubscriptionRows(
  data: ProjectionOperationsSnapshot,
): readonly ProjectionSubscriptionRow[] {
  const runnerStateByProjectionGroup = new Map(
    data.runners.map((runner) => [String(runner.runner_name ?? ""), String(runner.state ?? "")]),
  );

  return data.projectionGroups.flatMap((group) =>
    group.subscriptions.map((subscription) => ({
      ...subscription,
      projectionGroupName: group.projectionName,
      operatorState: resolveProjectionOperatorState(
        subscription.state,
        runnerStateByProjectionGroup.get(`${group.targetContextName}.${group.projectionName}`),
      ),
    })),
  );
}

export function buildBlockedRows(data: ProjectionOperationsSnapshot): readonly BlockedStream[] {
  return data.blockedProjections.flatMap((projection) =>
    projection.blockedStreams.map((stream) => ({ ...stream, projectionKey: projection.projectionKey })),
  );
}

export function buildProjectionRepairQueue(data: ProjectionOperationsSnapshot): readonly ProjectionRepairQueueItem[] {
  const items: ProjectionRepairQueueItem[] = [];

  for (const operation of data.operations) {
    if (operation.state !== "failed" && operation.state !== "cancel_requested") {
      continue;
    }
    items.push({
      kind: "operation",
      targetId: operation.operationId,
      label: operation.operationKind,
      detail: operationTarget(operation),
      state: operation.state,
      tone: operation.state === "failed" ? "danger" : "warning",
      contextName: operation.contextName,
      projectionName: operation.projectionName ?? undefined,
      projectionKey: operation.projectionKey ?? undefined,
      streamId: operation.streamId ?? undefined,
    });
  }

  for (const group of data.projectionGroups) {
    if (group.state !== "degraded" && group.state !== "error" && !group.revisionStale) {
      continue;
    }
    items.push({
      kind: "projection-group",
      targetId: `${group.targetContextName}:${group.projectionName}`,
      label: group.projectionName,
      detail: `${group.targetContextName} projection group`,
      state: group.revisionStale ? "stale" : group.state,
      tone: group.state === "error" ? "danger" : "warning",
      contextName: group.targetContextName,
      projectionName: group.projectionName,
    });
  }

  for (const projection of data.blockedProjections) {
    const { contextName, projectionName } = splitProjectionKey(projection.projectionKey);
    for (const event of projection.poisonEvents) {
      items.push({
        kind: "poison-event",
        targetId: `poison-event:${event.eventId}`,
        label: event.eventType,
        detail: event.errorMessage,
        state: event.state,
        tone: "danger",
        contextName,
        projectionName,
        projectionKey: projection.projectionKey,
        streamId: event.streamId,
      });
    }

    for (const stream of projection.blockedStreams) {
      items.push({
        kind: "blocked-stream",
        targetId: `${projection.projectionKey}:${stream.streamId}`,
        label: stream.streamId,
        detail: projection.projectionKey,
        state: stream.state,
        tone: "warning",
        contextName,
        projectionName,
        projectionKey: projection.projectionKey,
        streamId: stream.streamId,
      });
    }
  }

  for (const worker of data.workers) {
    const state = String(worker.worker_state ?? "");
    if (state !== "stale" && state !== "expired") {
      continue;
    }
    items.push({
      kind: "worker",
      targetId: String(worker.worker_id ?? ""),
      label: String(worker.worker_id ?? "Worker"),
      detail: String(worker.worker_kind ?? "Projection worker"),
      state,
      tone: "warning",
    });
  }

  return items.sort((left, right) => {
    const kindComparison = repairKindOrder(left.kind) - repairKindOrder(right.kind);
    if (kindComparison !== 0) {
      return kindComparison;
    }
    return stateSeverity(left.state) - stateSeverity(right.state) || left.label.localeCompare(right.label);
  });
}

function splitProjectionKey(projectionKey: string) {
  const separator = projectionKey.indexOf(".");
  return separator < 0
    ? { contextName: projectionKey, projectionName: projectionKey }
    : { contextName: projectionKey.slice(0, separator), projectionName: projectionKey.slice(separator + 1) };
}

function operationTarget(operation: ProjectionOperation) {
  return [operation.contextName, operation.projectionName, operation.projectionKey, operation.streamId]
    .filter(Boolean)
    .join(" / ");
}

function repairKindOrder(kind: ProjectionRepairQueueItem["kind"]) {
  return ["operation", "projection-group", "poison-event", "blocked-stream", "worker"].indexOf(kind);
}

export function activeWorkerCount(data: ProjectionOperationsSnapshot) {
  return data.workers.filter((worker) => worker.worker_state === "active").length;
}

export function staleWorkerCount(data: ProjectionOperationsSnapshot) {
  const staleCount = data.workers.filter((worker) => worker.worker_state === "stale").length;
  const returnedExpiredCount = data.workers.filter((worker) => worker.worker_state === "expired").length;
  return staleCount + Math.max(data.workerHeartbeatHistory.expiredTotalCount, returnedExpiredCount);
}

export function buildAttentionItems(data: ProjectionOperationsSnapshot): readonly AttentionItem[] {
  const blockedRows = buildBlockedRows(data);
  const failedOperations = data.operations.filter((operation) => operation.state === "failed");
  const cancelRequestedOperations = data.operations.filter((operation) => operation.state === "cancel_requested");
  const degradedGroups = data.projectionGroups.filter((group) => group.state === "degraded" || group.state === "error");
  const staleGroups = data.projectionGroups.filter((group) => group.revisionStale);
  const staleWorkers = staleWorkerCount(data);
  const poisonCount = data.projectionGroups.reduce((sum, group) => sum + group.poisonEventCount, 0);
  const items: AttentionItem[] = [];

  if (failedOperations.length > 0) {
    items.push({
      id: "failed-operations",
      label: "Failed operations",
      detail: "Projection work reached a terminal failure and needs inspection.",
      tone: "danger",
      count: failedOperations.length,
      targetTab: "operations",
    });
  }

  if (cancelRequestedOperations.length > 0 || Number(data.operationSummary?.cancelRequestedCount ?? "0") > 0) {
    items.push({
      id: "cancel-requested",
      label: "Cancel requested",
      detail: "A worker has been asked to stop and should mark the operation cancelled at a safe boundary.",
      tone: "warning",
      count: data.operationSummary?.cancelRequestedCount ?? cancelRequestedOperations.length,
      targetTab: "operations",
    });
  }

  if (degradedGroups.length > 0) {
    items.push({
      id: "degraded-groups",
      label: "Degraded projection groups",
      detail: "One or more projection groups report degraded or error state.",
      tone: "danger",
      count: degradedGroups.length,
      targetTab: "groups",
    });
  }

  if (blockedRows.length > 0) {
    items.push({
      id: "blocked-streams",
      label: "Blocked streams",
      detail: "A stream is waiting for retry or rebuild before that projection can continue it.",
      tone: "warning",
      count: blockedRows.length,
      targetTab: "blocked",
    });
  }

  if (poisonCount > 0) {
    items.push({
      id: "poison-events",
      label: "Poison events",
      detail: "Failed event applications are recorded for operator diagnosis.",
      tone: "warning",
      count: poisonCount,
      targetTab: "blocked",
    });
  }

  if (staleWorkers > 0) {
    items.push({
      id: "stale-workers",
      label: "Stale workers",
      detail: "Worker heartbeats are stale or expired.",
      tone: "warning",
      count: staleWorkers,
      targetTab: "workers",
    });
  }

  if (staleGroups.length > 0) {
    items.push({
      id: "stale-revisions",
      label: "Stale revisions",
      detail: "Stored projection revision does not match the current declaration.",
      tone: "warning",
      count: staleGroups.length,
      targetTab: "groups",
    });
  }

  if (data.projectionStatusSource === "runtime-memory" || data.projectionStatusSource === "mixed") {
    items.push({
      id: "snapshot-source",
      label: "Snapshot source",
      detail: `Projection status is from ${data.projectionStatusSource}. Confirm freshness during incidents.`,
      tone: "accent",
      targetTab: "diagnostics",
    });
  }

  return items;
}

export function compareSubscriptionRows(left: ProjectionSubscriptionRow, right: ProjectionSubscriptionRow) {
  const backlogComparison =
    BigInt(right.sourceLagEventCount ?? right.outstandingEventCount) -
    BigInt(left.sourceLagEventCount ?? left.outstandingEventCount);
  if (backlogComparison !== 0n) {
    return backlogComparison > 0n ? 1 : -1;
  }

  if (left.projectionGroupName !== right.projectionGroupName) {
    return left.projectionGroupName.localeCompare(right.projectionGroupName);
  }

  return left.sourceContextName.localeCompare(right.sourceContextName);
}

export function stateSeverity(state: string) {
  switch (state) {
    case "failed":
    case "error":
      return 0;
    case "degraded":
    case "blocked":
    case "cancel_requested":
      return 1;
    case "behind":
    case "stale":
    case "expired":
    case "queued":
      return 2;
    case "running":
      return 3;
    case "caught-up":
    case "succeeded":
    case "active":
    case "ok":
      return 4;
    default:
      return 5;
  }
}

function normalizeProjectionOperationSummary(value: unknown): ProjectionOperationSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    queuedCount: readString(value.queuedCount),
    runningCount: readString(value.runningCount),
    failedCount: readString(value.failedCount),
    cancelRequestedCount: readString(value.cancelRequestedCount),
    oldestQueuedAt: value.oldestQueuedAt == null ? null : readString(value.oldestQueuedAt),
    oldestRunningAt: value.oldestRunningAt == null ? null : readString(value.oldestRunningAt),
    averageDurationMs: value.averageDurationMs == null ? null : readString(value.averageDurationMs),
  };
}

function normalizeProjectionGroupStatus(value: unknown): ProjectionGroupStatus {
  const group = isRecord(value) ? value : {};

  return {
    projectionName: readString(group.projectionName),
    projectionRevision: readNumber(group.projectionRevision),
    storedProjectionRevision:
      group.storedProjectionRevision === null ? null : readNumber(group.storedProjectionRevision),
    revisionStale: group.revisionStale === true,
    targetContextName: readString(group.targetContextName),
    sourceContextNames: readArray(group.sourceContextNames).map(readString),
    ownedTables: readArray(group.ownedTables).map(readString),
    requiredDuringBootstrap: group.requiredDuringBootstrap === true,
    initialized: group.initialized === true,
    caughtUp: group.caughtUp === true,
    state: readProjectionState(group.state),
    lastError: group.lastError == null ? null : readString(group.lastError),
    outstandingEventCount: readString(group.outstandingEventCount),
    sourceLagEventCount: group.sourceLagEventCount === undefined ? undefined : readString(group.sourceLagEventCount),
    applicableLagEstimate:
      group.applicableLagEstimate === undefined || group.applicableLagEstimate === null
        ? null
        : readString(group.applicableLagEstimate),
    blockedStreamCount: readNumber(group.blockedStreamCount),
    poisonEventCount: readNumber(group.poisonEventCount),
    updatedAt: readString(group.updatedAt),
    subscriptions: readArray(group.subscriptions).map(normalizeProjectionSubscriptionStatus),
    projectionStatusSource: group.projectionStatusSource == null ? undefined : readString(group.projectionStatusSource),
    snapshot: isRecord(group.snapshot) ? group.snapshot : undefined,
  };
}

function normalizeProjectionSubscriptionStatus(value: unknown): ProjectionSubscriptionStatus {
  const subscription = isRecord(value) ? value : {};

  return {
    checkpointKey: readString(subscription.checkpointKey),
    subscriptionName: readString(subscription.subscriptionName),
    projectionName: readString(subscription.projectionName),
    sourceContextName: readString(subscription.sourceContextName),
    targetContextName: readString(subscription.targetContextName),
    subscriptionVersion: readNumber(subscription.subscriptionVersion),
    lastGlobalPosition: readString(subscription.lastGlobalPosition),
    sourceHeadGlobalPosition: readString(subscription.sourceHeadGlobalPosition),
    outstandingEventCount: readString(subscription.outstandingEventCount),
    sourceLagEventCount:
      subscription.sourceLagEventCount === undefined ? undefined : readString(subscription.sourceLagEventCount),
    applicableLagEstimate:
      subscription.applicableLagEstimate === undefined || subscription.applicableLagEstimate === null
        ? null
        : readString(subscription.applicableLagEstimate),
    state: readProjectionState(subscription.state),
    lastError: subscription.lastError == null ? null : readString(subscription.lastError),
    blockedStreamCount: readNumber(subscription.blockedStreamCount),
    poisonEventCount: readNumber(subscription.poisonEventCount),
  };
}

function normalizeBlockedProjectionDetails(value: unknown): BlockedProjectionDetails {
  const projection = isRecord(value) ? value : {};

  return {
    projectionKey: readString(projection.projectionKey),
    blockedStreams: readArray(projection.blockedStreams).map(normalizeBlockedStream),
    poisonEvents: readArray(projection.poisonEvents).map(normalizePoisonEvent),
  };
}

function normalizeBlockedStream(value: unknown): BlockedStream {
  const stream = isRecord(value) ? value : {};

  return {
    projectionKey: readString(stream.projectionKey),
    streamId: readString(stream.streamId),
    firstBlockedGlobalPosition: readString(stream.firstBlockedGlobalPosition),
    firstBlockedStreamVersion: readNumber(stream.firstBlockedStreamVersion),
    lastSeenGlobalPosition: readString(stream.lastSeenGlobalPosition),
    deferredEventCount: readNumber(stream.deferredEventCount),
    state: readString(stream.state),
  };
}

function normalizePoisonEvent(value: unknown): PoisonEvent {
  const event = isRecord(value) ? value : {};

  return {
    eventId: readString(event.eventId),
    eventType: readString(event.eventType),
    streamId: readString(event.streamId),
    streamVersion: readNumber(event.streamVersion),
    globalPosition: readString(event.globalPosition),
    errorMessage: readString(event.errorMessage),
    retryCount: readNumber(event.retryCount),
    firstSeenAt: readString(event.firstSeenAt),
    lastSeenAt: readString(event.lastSeenAt),
    state: readString(event.state),
  };
}

function normalizeProjectionOperation(value: unknown): ProjectionOperation {
  const operation = isRecord(value) ? value : {};

  return {
    operationId: readString(operation.operationId),
    operationKind: readString(operation.operationKind),
    state: readString(operation.state),
    contextName: readString(operation.contextName),
    projectionName: operation.projectionName == null ? null : readString(operation.projectionName),
    projectionKey: operation.projectionKey == null ? null : readString(operation.projectionKey),
    streamId: operation.streamId == null ? null : readString(operation.streamId),
    requestedByUserId: operation.requestedByUserId == null ? null : readString(operation.requestedByUserId),
    claimOwnerId: operation.claimOwnerId == null ? null : readString(operation.claimOwnerId),
    requestedAt: readString(operation.requestedAt),
    startedAt: operation.startedAt == null ? null : readString(operation.startedAt),
    updatedAt: readString(operation.updatedAt),
    completedAt: operation.completedAt == null ? null : readString(operation.completedAt),
    error: isRecord(operation.error) ? operation.error : null,
  };
}

function readProjectionState(value: unknown): ProjectionState {
  return value === "behind" || value === "running" || value === "caught-up" || value === "degraded" || value === "error"
    ? value
    : "idle";
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

function readString(value: unknown) {
  return typeof value === "string" ? value : String(value ?? "0");
}
