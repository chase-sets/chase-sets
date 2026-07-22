import { Hono } from "hono";
import {
  listProjectionBlockedStreamDetails,
  listProjectionGroupStatuses,
  refreshProjectionGroupStatuses,
  summarizeProjectionReplayStatuses,
  type ContextProjectionGroupStatus,
} from "@chase-sets/bounded-context-runtime";
import { authenticationRequiredResponse, forbiddenResponse } from "@chase-sets/http/responses";
import type { ApiHostRuntime } from "./api";
import type { ResolvedActor } from "./auth";
import {
  ACTIVE_WORKER_HEARTBEAT_MAX_AGE_MS,
  EXPIRED_WORKER_HEARTBEAT_MAX_AGE_MS,
  type PlatformControlPlane,
  type ProjectionOperationKind,
  type WorkerHeartbeatHistorySnapshot,
} from "./control-plane";
import { createDurableJobEventStream } from "./durable-job-events";
import { listProjectionPushMigrationEntries, summarizeProjectionPushMigration } from "./projection-push-migration";
import { PROJECTION_WAKE_RELAY_ACTIVE_LEASE_NAME } from "./projection-wake-relay";
import {
  isEventStoreWakeNotificationEmissionEnabled,
  listSourceContextWakeRegistryEntries,
  summarizeSourceContextWakeRegistry,
} from "./source-context-wake-registry";
import { listWorkSignalOriginDispositions } from "./work-signal-composite";
import type { PostgresWorkSignalStore } from "./work-signal-store";

const PROJECTION_OPERATIONS_VIEW_PERMISSION = "projection-operations.view";
const PROJECTION_OPERATIONS_OPERATE_PERMISSION = "projection-operations.operate";
const PROJECTION_OPERATIONS_REBUILD_PERMISSION = "projection-operations.rebuild";
const PROJECTION_STATUS_SNAPSHOT_FRESH_MAX_AGE_MS = 2 * 60_000;
// Authenticated setup polls once per second. Share the database fan-out within
// that interval so concurrent callers observe the same live status snapshot.
const PROJECTION_STATUS_REFRESH_CACHE_TTL_MS = 1_000;

type ProjectionOperationsRouteEnv = {
  Variables: {
    actor: ResolvedActor | null;
  };
};

export type ProjectionWakeStatusWorkSignalStore = Pick<
  PostgresWorkSignalStore,
  "summarizeProjectionWakeIntents" | "summarizeProjectionWakeIntentBreakdown" | "summarizeCheckpointSignals"
>;

export type ProjectionOperationsRouteOptions = Readonly<{
  controlPlane?: PlatformControlPlane;
  workSignalStore?: ProjectionWakeStatusWorkSignalStore;
}>;

export function createProjectionOperationsRoutes(
  runtime: ApiHostRuntime,
  options: ProjectionOperationsRouteOptions = {},
) {
  const app = new Hono<ProjectionOperationsRouteEnv>();
  const refreshProjectionStatuses = createProjectionStatusRefresher(runtime);

  app.get("/", async (c) => {
    const actorResponse = requireProjectionOperationsActor(c.get("actor"), PROJECTION_OPERATIONS_VIEW_PERMISSION);
    if (actorResponse instanceof Response) {
      return actorResponse;
    }

    const snapshots = options.controlPlane ? await options.controlPlane.listProjectionStatusSnapshots() : [];
    const snapshotOverlay = overlayProjectionGroupSnapshots(listProjectionGroupStatuses(runtime), snapshots);
    const projectionGroups = snapshotOverlay.projectionGroups;

    const workerHeartbeatHistory = options.controlPlane
      ? await options.controlPlane.readWorkerHeartbeatHistory()
      : emptyWorkerHeartbeatHistorySnapshot();
    const classifiedWorkers = classifyWorkerHeartbeats(
      workerHeartbeatHistory.workers,
      Date.parse(workerHeartbeatHistory.snapshotAt),
    );

    return c.json({
      summary: summarizeProjectionReplayStatuses(projectionGroups),
      projectionGroups,
      blockedProjections: summarizeBlockedProjectionKeys(projectionGroups),
      projectionStatusSource: snapshotOverlay.source,
      workers: classifiedWorkers,
      workerHeartbeatHistory: workerHeartbeatHistory.summary,
      runners: options.controlPlane ? await options.controlPlane.listRunnerStatuses() : [],
      operations: options.controlPlane ? await options.controlPlane.listProjectionOperations({ limit: 25 }) : [],
      operationSummary: options.controlPlane ? await options.controlPlane.summarizeProjectionOperations() : null,
    });
  });

  app.post("/refresh", async (c) => {
    const actorResponse = requireProjectionOperationsActor(c.get("actor"), PROJECTION_OPERATIONS_OPERATE_PERMISSION);
    if (actorResponse instanceof Response) {
      return actorResponse;
    }

    const projectionGroups = await refreshProjectionStatuses();

    return c.json({
      summary: summarizeProjectionReplayStatuses(projectionGroups),
      projectionGroups,
      projectionStatusSource: "live-refresh",
    });
  });

  app.post("/refresh-checkpoint", async (c) => {
    const actorResponse = requireProjectionOperationsActor(c.get("actor"), PROJECTION_OPERATIONS_OPERATE_PERMISSION);
    if (actorResponse instanceof Response) {
      return actorResponse;
    }

    const body = await readJsonBody(c.req.raw);
    const targetContextName = readBoundedName(body.targetContextName);
    const projectionName = readBoundedName(body.projectionName);
    const sourceContextName = readBoundedName(body.sourceContextName);
    if (!targetContextName || !projectionName || !sourceContextName) {
      return c.json({ error: { code: "invalid_projection_checkpoint_request" } }, 400);
    }

    const projectionGroups = await refreshProjectionStatuses();
    const group = projectionGroups.find(
      (candidate) => candidate.targetContextName === targetContextName && candidate.projectionName === projectionName,
    );
    const positions =
      group?.subscriptions
        .filter((subscription) => subscription.sourceContextName === sourceContextName)
        .map((subscription) => subscription.lastGlobalPosition) ?? [];
    if (positions.length === 0) {
      return c.json({ error: { code: "projection_checkpoint_not_found" } }, 404);
    }

    const lastGlobalPosition = positions.reduce((maximum, position) =>
      BigInt(position) > BigInt(maximum) ? position : maximum,
    );
    return c.json({ lastGlobalPosition });
  });

  // Read-only push-wake pipeline status for the operator console. Structural
  // fields only (ADR 0010 privacy boundary): counts, lanes, origins,
  // states, positions, owners, and timestamps — never wake-intent metadata,
  // error bodies, or stream identifiers.
  app.get("/wake-status", async (c) => {
    const actorResponse = requireProjectionOperationsActor(c.get("actor"), PROJECTION_OPERATIONS_VIEW_PERMISSION);
    if (actorResponse instanceof Response) {
      return actorResponse;
    }

    const [wakeStore, relay, schedulers] = await Promise.all([
      readWakeStoreStatus(options.workSignalStore),
      readWakeRelayStatus(options.controlPlane),
      readWakeSchedulerStatus(options.controlPlane),
    ]);

    return c.json({
      generatedAt: new Date().toISOString(),
      wakeStore,
      relay,
      schedulers,
      rollout: readWakeRolloutStatus(),
      // Push-first migration inventory: disposition by projection
      // group derived from the wake registry. Structural metadata only:
      // names, owners, states, counts.
      migration: readWakeMigrationStatus(),
      // Static composite-origin disposition inventory: which
      // wake families ride the work-signal composite versus documented
      // exceptions. Structural metadata only.
      origins: listWorkSignalOriginDispositions(),
    });
  });

  app.get("/:projectionKey/blocked-streams", async (c) => {
    const actorResponse = requireProjectionOperationsActor(c.get("actor"), PROJECTION_OPERATIONS_VIEW_PERMISSION);
    if (actorResponse instanceof Response) {
      return actorResponse;
    }

    return c.json(
      await listProjectionBlockedStreamDetails(runtime, c.req.param("projectionKey"), {
        poisonEventLimit: readLimit(c.req.query("limit")),
      }),
    );
  });

  app.post("/:projectionKey/blocked-streams/:streamId/retry", async (c) => {
    const actorResponse = requireProjectionOperationsActor(c.get("actor"), PROJECTION_OPERATIONS_OPERATE_PERMISSION);
    if (actorResponse instanceof Response) {
      return actorResponse;
    }

    const projectionKey = c.req.param("projectionKey");
    const streamId = c.req.param("streamId");
    const operation = await enqueueProjectionOperation(options.controlPlane, actorResponse, {
      operationKind: "retry-blocked-stream",
      contextName: readProjectionKeyContextName(projectionKey),
      projectionKey,
      streamId,
      progress: {
        message: "Retry queued.",
      },
    });

    return c.json({ operation }, 202);
  });

  app.post("/groups/:contextName/:projectionName/rebuild", async (c) => {
    const actorResponse = requireProjectionOperationsActor(c.get("actor"), PROJECTION_OPERATIONS_REBUILD_PERMISSION);
    if (actorResponse instanceof Response) {
      return actorResponse;
    }

    const body = await readJsonBody(c.req.raw);
    if (body.confirm !== "rebuild") {
      return c.json(
        {
          error: {
            code: "confirmation_required",
            message: "Projection group rebuild requires confirm = 'rebuild'.",
          },
        },
        400,
      );
    }

    const contextName = c.req.param("contextName");
    const projectionName = c.req.param("projectionName");
    const operation = await enqueueProjectionOperation(options.controlPlane, actorResponse, {
      operationKind: "rebuild-projection-group",
      contextName,
      projectionName,
      progress: {
        message: "Projection group rebuild queued.",
      },
    });

    return c.json({ operation }, 202);
  });

  app.post("/groups/:contextName/rebuild", async (c) => {
    const actorResponse = requireProjectionOperationsActor(c.get("actor"), PROJECTION_OPERATIONS_REBUILD_PERMISSION);
    if (actorResponse instanceof Response) {
      return actorResponse;
    }

    const body = await readJsonBody(c.req.raw);
    if (body.confirm !== "rebuild-all") {
      return c.json(
        {
          error: {
            code: "confirmation_required",
            message: "Context projection rebuild requires confirm = 'rebuild-all'.",
          },
        },
        400,
      );
    }

    const contextName = c.req.param("contextName");
    const operation = await enqueueProjectionOperation(options.controlPlane, actorResponse, {
      operationKind: "rebuild-context",
      contextName,
      progress: {
        message: "Context rebuild queued.",
      },
    });

    return c.json({ operation }, 202);
  });

  app.get("/operations", async (c) => {
    const actorResponse = requireProjectionOperationsActor(c.get("actor"), PROJECTION_OPERATIONS_VIEW_PERMISSION);
    if (actorResponse instanceof Response) {
      return actorResponse;
    }

    if (!options.controlPlane) {
      return c.json({ operations: [] });
    }

    return c.json({
      operations: await options.controlPlane.listProjectionOperations({
        limit: readLimit(c.req.query("limit")),
        contextName: c.req.query("contextName"),
        projectionName: c.req.query("projectionName"),
        state: readProjectionOperationState(c.req.query("state")),
        requestedByUserId: c.req.query("requestedByUserId"),
      }),
      operationSummary: await options.controlPlane.summarizeProjectionOperations({
        contextName: c.req.query("contextName"),
        projectionName: c.req.query("projectionName"),
        state: readProjectionOperationState(c.req.query("state")),
        requestedByUserId: c.req.query("requestedByUserId"),
      }),
    });
  });

  app.get("/operations/:operationId", async (c) => {
    const actorResponse = requireProjectionOperationsActor(c.get("actor"), PROJECTION_OPERATIONS_VIEW_PERMISSION);
    if (actorResponse instanceof Response) {
      return actorResponse;
    }

    if (!options.controlPlane) {
      return c.json({ error: { code: "control_plane_unavailable" } }, 503);
    }

    const operation = await options.controlPlane.getProjectionOperation(c.req.param("operationId"));
    if (!operation) {
      return c.json({ error: { code: "operation_not_found" } }, 404);
    }

    return c.json({ operation });
  });

  app.get("/operations/:operationId/events", async (c) => {
    const actorResponse = requireProjectionOperationsActor(c.get("actor"), PROJECTION_OPERATIONS_VIEW_PERMISSION);
    if (actorResponse instanceof Response) {
      return actorResponse;
    }

    if (!options.controlPlane) {
      return c.json({ error: { code: "control_plane_unavailable" } }, 503);
    }

    const operationId = c.req.param("operationId");
    const operation = await options.controlPlane.getProjectionOperation(operationId);
    if (!operation) {
      return c.json({ error: { code: "operation_not_found" } }, 404);
    }

    return createDurableJobEventStream({
      request: c.req.raw,
      signal: c.req.raw.signal,
      streamLimitKey: `account:${actorResponse.accountId}:user:${actorResponse.userId}`,
      loadEvents: async (afterSequence) =>
        (await options.controlPlane!.listProjectionOperationEvents(operationId, afterSequence)).map((event) => ({
          sequence: event.sequence,
          eventName: event.eventName,
          data: event.operation,
        })),
      loadCurrentSnapshot: async () => options.controlPlane!.getProjectionOperation(operationId),
      waitForEvents: (_afterSequence, signal) =>
        options.controlPlane!.waitForProjectionOperationEvents({ operationId, signal }),
      isTerminal: (event) =>
        event.data.state === "succeeded" || event.data.state === "failed" || event.data.state === "cancelled",
      isTerminalSnapshot: (snapshot) =>
        snapshot.state === "succeeded" || snapshot.state === "failed" || snapshot.state === "cancelled",
    });
  });

  app.post("/operations/:operationId/cancel", async (c) => {
    const actorResponse = requireProjectionOperationsActor(c.get("actor"), PROJECTION_OPERATIONS_OPERATE_PERMISSION);
    if (actorResponse instanceof Response) {
      return actorResponse;
    }

    if (!options.controlPlane) {
      return c.json({ error: { code: "control_plane_unavailable" } }, 503);
    }

    const cancelled = await options.controlPlane.cancelProjectionOperation({
      operationId: c.req.param("operationId"),
      requestedByUserId: actorResponse.userId,
    });

    return c.json({ result: { cancelled } }, cancelled ? 200 : 409);
  });

  return app;
}

function createProjectionStatusRefresher(runtime: ApiHostRuntime) {
  let cached:
    | Readonly<{
        projectionGroups: readonly ContextProjectionGroupStatus[];
        refreshedAtMs: number;
      }>
    | undefined;
  let inFlight: Promise<readonly ContextProjectionGroupStatus[]> | undefined;

  return async (): Promise<readonly ContextProjectionGroupStatus[]> => {
    if (cached && Date.now() - cached.refreshedAtMs < PROJECTION_STATUS_REFRESH_CACHE_TTL_MS) {
      return cached.projectionGroups;
    }

    if (inFlight) {
      return inFlight;
    }

    const refresh = refreshProjectionGroupStatuses(runtime)
      .then((projectionGroups) => {
        cached = {
          projectionGroups,
          refreshedAtMs: Date.now(),
        };
        return projectionGroups;
      })
      .finally(() => {
        if (inFlight === refresh) {
          inFlight = undefined;
        }
      });
    inFlight = refresh;
    return refresh;
  };
}

async function readWakeStoreStatus(workSignalStore: ProjectionWakeStatusWorkSignalStore | undefined) {
  if (!workSignalStore) {
    return { available: false } as const;
  }

  const now = Date.now();
  const [intentSummary, intentBreakdown, checkpointSignals] = await Promise.all([
    workSignalStore.summarizeProjectionWakeIntents(),
    workSignalStore.summarizeProjectionWakeIntentBreakdown(),
    workSignalStore.summarizeCheckpointSignals(),
  ]);

  return {
    available: true,
    intentSummary: {
      queuedCount: intentSummary.queuedCount,
      claimedCount: intentSummary.claimedCount,
      failedCount: intentSummary.failedCount,
      expiredCount: intentSummary.expiredCount,
      staleClaimCount: intentSummary.staleClaimCount,
      oldestQueuedAt: toIsoTimestamp(intentSummary.oldestQueuedAt),
      oldestQueuedAgeMs: toAgeMs(intentSummary.oldestQueuedAt, now),
      oldestClaimedAt: toIsoTimestamp(intentSummary.oldestClaimedAt),
    },
    intentBreakdown: intentBreakdown.map((entry) => ({
      priorityLane: entry.priorityLane,
      origin: entry.origin,
      state: entry.state,
      sourceContextName: entry.sourceContextName,
      targetContextName: entry.targetContextName,
      projectionName: entry.projectionName,
      checkpointKey: entry.checkpointKey,
      intentCount: entry.intentCount,
      oldestCreatedAt: toIsoTimestamp(entry.oldestCreatedAt),
      oldestAgeMs: toAgeMs(entry.oldestCreatedAt, now),
      maxAttemptCount: entry.maxAttemptCount,
    })),
    checkpointSignals: {
      readinessCount: checkpointSignals.readinessCount,
      expiredReadinessCount: checkpointSignals.expiredReadinessCount,
      latestReadyRecordedAt: toIsoTimestamp(checkpointSignals.latestReadyRecordedAt),
      latestReadyAgeMs: toAgeMs(checkpointSignals.latestReadyRecordedAt, now),
      pendingWaiterCount: checkpointSignals.pendingWaiterCount,
      expiredPendingWaiterCount: checkpointSignals.expiredPendingWaiterCount,
      satisfiedWaiterCount: checkpointSignals.satisfiedWaiterCount,
      oldestPendingWaiterAt: toIsoTimestamp(checkpointSignals.oldestPendingWaiterAt),
      oldestPendingWaiterAgeMs: toAgeMs(checkpointSignals.oldestPendingWaiterAt, now),
      pendingWaiterOrigins: checkpointSignals.pendingWaiterOrigins,
    },
  } as const;
}

async function readWakeRelayStatus(controlPlane: PlatformControlPlane | undefined) {
  if (!controlPlane) {
    return { available: false } as const;
  }

  const now = Date.now();
  const [leases, cursors] = await Promise.all([
    controlPlane.listLeases(),
    controlPlane.listProjectionWakeRelayCursors(),
  ]);
  const leaseRow = leases.find((lease) => String(lease.lease_name ?? "") === PROJECTION_WAKE_RELAY_ACTIVE_LEASE_NAME);
  const leaseExpiresAt = leaseRow ? parseTimestamp(leaseRow.expires_at) : null;

  return {
    available: true,
    activeLeaseName: PROJECTION_WAKE_RELAY_ACTIVE_LEASE_NAME,
    lease: leaseRow
      ? {
          ownerId: String(leaseRow.owner_id ?? ""),
          fencingToken: String(leaseRow.fencing_token ?? ""),
          acquiredAt: formatTimestamp(leaseRow.acquired_at),
          renewedAt: formatTimestamp(leaseRow.renewed_at),
          expiresAt: leaseExpiresAt ? leaseExpiresAt.toISOString() : null,
          state: leaseExpiresAt && leaseExpiresAt.getTime() > now ? "active" : "expired",
        }
      : null,
    cursors: cursors.map((cursor) => ({
      sourceContextName: cursor.sourceContextName,
      lastFanOutPosition: cursor.lastFanOutPosition.toString(),
      lastRequiredCursor: cursor.lastRequiredCursor,
      ownerId: cursor.ownerId,
      fencingToken: cursor.fencingToken,
      updatedAt: cursor.updatedAt,
      updatedAgeMs: toAgeMs(parseTimestamp(cursor.updatedAt), now),
      // Structural cursor metadata only: never forward arbitrary keys.
      interestIndexVersion: readStructuralMetadataString(cursor.metadata, "projectionInterestIndexVersion"),
      lastAdvanceReason: readStructuralMetadataString(cursor.metadata, "reason"),
      lastStreamCategory: readStructuralMetadataString(cursor.metadata, "streamCategory"),
    })),
  } as const;
}

async function readWakeSchedulerStatus(controlPlane: PlatformControlPlane | undefined) {
  if (!controlPlane) {
    return { available: false } as const;
  }

  const workerHeartbeatHistory = await controlPlane.readWorkerHeartbeatHistory();
  const workers = classifyWorkerHeartbeats(
    workerHeartbeatHistory.workers,
    Date.parse(workerHeartbeatHistory.snapshotAt),
  );
  const wakeWorkers = workers.flatMap((worker) => {
    const metadata = readJsonRecord(worker.metadata);
    const runnerGroups = metadata ? readJsonRecord(metadata.runnerGroups) : null;
    const wakesGroup = runnerGroups ? readJsonRecord(runnerGroups.wakes) : null;
    if (!wakesGroup) {
      return [];
    }

    return [
      {
        workerId: String(worker.worker_id ?? ""),
        workerKind: String(worker.worker_kind ?? ""),
        workerState: String(worker.worker_state ?? "unknown"),
        heartbeatAt: formatTimestamp(worker.heartbeat_at),
        heartbeatAgeMs: typeof worker.heartbeat_age_ms === "number" ? worker.heartbeat_age_ms : null,
        wakeRunnerCount: readFiniteNumber(wakesGroup.runnerCount),
        wakeMaxConcurrentRunners: readFiniteNumber(wakesGroup.maxConcurrentRunners),
      },
    ];
  });

  return {
    available: true,
    wakeCapableWorkerCount: wakeWorkers.length,
    activeWakeCapableWorkerCount: wakeWorkers.filter((worker) => worker.workerState === "active").length,
    workers: wakeWorkers,
  } as const;
}

function readWakeRolloutStatus() {
  const summary = summarizeSourceContextWakeRegistry();

  return {
    eventStoreWakeEmissionEnabledOnHost: isEventStoreWakeNotificationEmissionEnabled(),
    summary,
    sources: listSourceContextWakeRegistryEntries({ includeInactive: true }).map((entry) => ({
      sourceContextName: entry.sourceContextName,
      rolloutState: entry.rolloutState,
      phase: entry.phase,
      rolloutWave: entry.rolloutWave,
      priorityLane: entry.priorityLane,
      eventStoreWakeNotificationsEnabled: entry.enablement.eventStoreWakeNotifications,
      relayFanOutEnabled: entry.enablement.relayFanOut,
      affectedProjectionNames: entry.affectedProjectionNames,
      disabledReason: entry.disabledReason ?? null,
      optOutReason: entry.optOutReason ?? null,
    })),
  } as const;
}

function readWakeMigrationStatus() {
  return {
    summary: summarizeProjectionPushMigration(),
    projections: listProjectionPushMigrationEntries().map((entry) => ({
      projectionKey: entry.projectionKey,
      targetContextName: entry.targetContextName,
      projectionName: entry.projectionName,
      owner: entry.owner,
      status: entry.status,
      sourceContextCount: entry.sourceContextCount,
      enabledSourceContextCount: entry.enabledSourceContextCount,
      sourceContextNames: entry.sourceContexts.map((source) => source.sourceContextName),
      consumesDurableWakeIntents: entry.consumesDurableWakeIntents,
      optOutReason: entry.optOut?.reason ?? null,
      optOutReviewBy: entry.optOut?.reviewBy ?? null,
    })),
  } as const;
}

function readStructuralMetadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toIsoTimestamp(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toAgeMs(value: Date | null, now: number): number | null {
  return value ? Math.max(0, now - value.getTime()) : null;
}

function requireProjectionOperationsActor(actor: ResolvedActor | null, permission: string): ResolvedActor | Response {
  if (!actor) {
    return Response.json(authenticationRequiredResponse(), { status: 401 });
  }

  if (!actor.permissions.includes(permission)) {
    return Response.json(forbiddenResponse(), { status: 403 });
  }

  return actor;
}

function summarizeBlockedProjectionKeys(
  projectionGroups: readonly ContextProjectionGroupStatus[],
): readonly Readonly<{ projectionKey: string; blockedStreamCount: number; poisonEventCount: number }>[] {
  const activeProjectionKeys = [
    ...projectionGroups.flatMap((group) =>
      group.subscriptions
        .filter((subscription) => subscription.blockedStreamCount > 0 || subscription.poisonEventCount > 0)
        .map((subscription) => ({
          projectionKey: subscription.checkpointKey,
          blockedStreamCount: subscription.blockedStreamCount,
          poisonEventCount: subscription.poisonEventCount,
        })),
    ),
  ];

  return activeProjectionKeys;
}

function classifyWorkerHeartbeats(
  workers: readonly Record<string, unknown>[],
  now: number,
): readonly Record<string, unknown>[] {
  return workers.map((worker) => {
    const heartbeatAt = parseTimestamp(worker.heartbeat_at);
    const heartbeatAgeMs = heartbeatAt ? Math.max(0, now - heartbeatAt.getTime()) : null;
    const workerState =
      heartbeatAgeMs === null
        ? "unknown"
        : heartbeatAgeMs <= ACTIVE_WORKER_HEARTBEAT_MAX_AGE_MS
          ? "active"
          : heartbeatAgeMs <= EXPIRED_WORKER_HEARTBEAT_MAX_AGE_MS
            ? "stale"
            : "expired";

    return {
      ...worker,
      worker_state: workerState,
      heartbeat_age_ms: heartbeatAgeMs,
    };
  });
}

function emptyWorkerHeartbeatHistorySnapshot(): WorkerHeartbeatHistorySnapshot {
  return {
    snapshotAt: new Date(0).toISOString(),
    workers: [],
    summary: {
      activeOrStaleCount: 0,
      expiredTotalCount: 0,
      expiredWithinDiagnosticWindowCount: 0,
      expiredReturnedCount: 0,
      expiredTruncated: false,
      expiredDiagnosticLimit: 0,
      diagnosticWindowMs: 0,
    },
  };
}

function overlayProjectionGroupSnapshots(
  runtimeProjectionGroups: readonly ContextProjectionGroupStatus[],
  snapshots: readonly Record<string, unknown>[],
): Readonly<{
  projectionGroups: readonly ContextProjectionGroupStatus[];
  source: "runtime-memory" | "worker-snapshot" | "mixed";
}> {
  if (snapshots.length === 0) {
    return {
      projectionGroups: runtimeProjectionGroups.map((group) => withProjectionStatusSource(group, "runtime-memory")),
      source: "runtime-memory",
    };
  }

  const snapshotsByProjectionKey = new Map(
    readProjectionGroupSnapshots(snapshots).map((snapshot) => [
      `${snapshot.targetContextName}.${snapshot.projectionName}`,
      snapshot,
    ]),
  );
  let freshSnapshotCount = 0;
  const projectionGroups = runtimeProjectionGroups.map((runtimeGroup) => {
    const projectionKey = `${runtimeGroup.targetContextName}.${runtimeGroup.projectionName}`;
    const snapshot = snapshotsByProjectionKey.get(projectionKey);

    if (snapshot && readSnapshotFreshness(snapshot) === "fresh-snapshot") {
      freshSnapshotCount += 1;
      return snapshot;
    }

    return withProjectionStatusSource(
      runtimeGroup,
      snapshot ? "stale-snapshot" : "runtime-memory",
      snapshot ? readProjectionStatusSnapshotMetadata(snapshot) : undefined,
    );
  });

  return {
    projectionGroups,
    source:
      freshSnapshotCount === 0
        ? "runtime-memory"
        : freshSnapshotCount === projectionGroups.length
          ? "worker-snapshot"
          : "mixed",
  };
}

function readProjectionGroupSnapshots(
  snapshots: readonly Record<string, unknown>[],
): readonly ContextProjectionGroupStatus[] {
  return snapshots.flatMap((snapshot) => {
    const status = readJsonRecord(snapshot.status);
    if (!status) {
      return [];
    }

    const snapshotUpdatedAt = formatTimestamp(snapshot.updated_at);
    const snapshotAgeMs = snapshotUpdatedAt ? Math.max(0, Date.now() - new Date(snapshotUpdatedAt).getTime()) : null;
    const freshness =
      snapshotAgeMs !== null && snapshotAgeMs <= PROJECTION_STATUS_SNAPSHOT_FRESH_MAX_AGE_MS
        ? "fresh-snapshot"
        : "stale-snapshot";

    return [
      {
        ...status,
        snapshot: {
          projectionKey: String(snapshot.projection_key ?? ""),
          runnerName: String(snapshot.runner_name ?? ""),
          ownerId: String(snapshot.owner_id ?? ""),
          fencingToken:
            snapshot.fencing_token === null || snapshot.fencing_token === undefined
              ? null
              : String(snapshot.fencing_token),
          updatedAt: snapshotUpdatedAt,
          ageMs: snapshotAgeMs,
          freshness,
        },
        projectionStatusSource: freshness,
      } as unknown as ContextProjectionGroupStatus,
    ];
  });
}

function readSnapshotFreshness(snapshot: ContextProjectionGroupStatus): string {
  return String((snapshot as unknown as { projectionStatusSource?: string }).projectionStatusSource ?? "");
}

function readProjectionStatusSnapshotMetadata(
  snapshot: ContextProjectionGroupStatus,
): Record<string, unknown> | undefined {
  return (snapshot as unknown as { snapshot?: Record<string, unknown> }).snapshot;
}

function withProjectionStatusSource(
  group: ContextProjectionGroupStatus,
  projectionStatusSource: "fresh-snapshot" | "stale-snapshot" | "runtime-memory",
  snapshot?: Record<string, unknown>,
): ContextProjectionGroupStatus {
  return {
    ...group,
    projectionStatusSource,
    ...(snapshot
      ? {
          snapshot: {
            ...snapshot,
            freshness: projectionStatusSource,
          },
        }
      : {}),
  } as unknown as ContextProjectionGroupStatus;
}

function readJsonRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return null;
}

function parseTimestamp(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatTimestamp(value: unknown): string | null {
  const parsed = parseTimestamp(value);
  return parsed ? parsed.toISOString() : null;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return {};
  }

  const body = await request.json();
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function readBoundedName(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}

function readLimit(value: string | undefined): number {
  const parsed = Number(value ?? 50);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : 50;
}

function readProjectionOperationState(value: string | undefined) {
  return value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancel_requested" ||
    value === "cancelled"
    ? value
    : undefined;
}

async function enqueueProjectionOperation(
  controlPlane: PlatformControlPlane | undefined,
  actor: ResolvedActor,
  input: Readonly<{
    operationKind: ProjectionOperationKind;
    contextName: string;
    projectionName?: string | null;
    projectionKey?: string | null;
    streamId?: string | null;
    progress?: Record<string, unknown>;
  }>,
) {
  if (!controlPlane) {
    throw new Error("Projection operation control plane is unavailable.");
  }

  return controlPlane.enqueueProjectionOperation({
    ...input,
    requestedByUserId: actor.userId,
    requestedByAccountId: actor.accountId,
  });
}

function readProjectionKeyContextName(projectionKey: string): string {
  return projectionKey.includes(".") ? projectionKey.slice(0, projectionKey.indexOf(".")) : "unknown";
}
