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
import type { PlatformControlPlane, ProjectionOperationKind } from "./control-plane";
import { createDurableJobEventStream } from "./durable-job-events";

const PROJECTION_OPERATIONS_PERMISSION = "security.manage";
const ACTIVE_WORKER_HEARTBEAT_MAX_AGE_MS = 60_000;
const EXPIRED_WORKER_HEARTBEAT_MAX_AGE_MS = 10 * 60_000;
const PROJECTION_STATUS_SNAPSHOT_FRESH_MAX_AGE_MS = 2 * 60_000;

type ProjectionOperationsRouteEnv = {
  Variables: {
    actor: ResolvedActor | null;
  };
};

export type ProjectionOperationsRouteOptions = Readonly<{
  controlPlane?: PlatformControlPlane;
}>;

export function createProjectionOperationsRoutes(
  runtime: ApiHostRuntime,
  options: ProjectionOperationsRouteOptions = {},
) {
  const app = new Hono<ProjectionOperationsRouteEnv>();

  app.get("/", async (c) => {
    const actorResponse = requireProjectionOperationsActor(c.get("actor"));
    if (actorResponse instanceof Response) {
      return actorResponse;
    }

    const snapshots = options.controlPlane ? await options.controlPlane.listProjectionStatusSnapshots() : [];
    const snapshotOverlay = overlayProjectionGroupSnapshots(listProjectionGroupStatuses(runtime), snapshots);
    const projectionGroups = snapshotOverlay.projectionGroups;

    const workers = options.controlPlane ? await options.controlPlane.listWorkerHeartbeats() : [];

    return c.json({
      summary: summarizeProjectionReplayStatuses(projectionGroups),
      projectionGroups,
      blockedProjections: summarizeBlockedProjectionKeys(projectionGroups),
      projectionStatusSource: snapshotOverlay.source,
      workers: classifyWorkerHeartbeats(workers),
      runners: options.controlPlane ? await options.controlPlane.listRunnerStatuses() : [],
      operations: options.controlPlane ? await options.controlPlane.listProjectionOperations({ limit: 25 }) : [],
      operationSummary: options.controlPlane ? await options.controlPlane.summarizeProjectionOperations() : null,
    });
  });

  app.post("/refresh", async (c) => {
    const actorResponse = requireProjectionOperationsActor(c.get("actor"));
    if (actorResponse instanceof Response) {
      return actorResponse;
    }

    const projectionGroups = await refreshProjectionGroupStatuses(runtime);

    return c.json({
      summary: summarizeProjectionReplayStatuses(projectionGroups),
      projectionGroups,
      projectionStatusSource: "live-refresh",
    });
  });

  app.get("/:projectionKey/blocked-streams", async (c) => {
    const actorResponse = requireProjectionOperationsActor(c.get("actor"));
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
    const actorResponse = requireProjectionOperationsActor(c.get("actor"));
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
    const actorResponse = requireProjectionOperationsActor(c.get("actor"));
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
    const actorResponse = requireProjectionOperationsActor(c.get("actor"));
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
    const actorResponse = requireProjectionOperationsActor(c.get("actor"));
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
    const actorResponse = requireProjectionOperationsActor(c.get("actor"));
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
    const actorResponse = requireProjectionOperationsActor(c.get("actor"));
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
    const actorResponse = requireProjectionOperationsActor(c.get("actor"));
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

function requireProjectionOperationsActor(actor: ResolvedActor | null): ResolvedActor | Response {
  if (!actor) {
    return Response.json(authenticationRequiredResponse(), { status: 401 });
  }

  if (!actor.permissions.includes(PROJECTION_OPERATIONS_PERMISSION)) {
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

function classifyWorkerHeartbeats(workers: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  const now = Date.now();

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
