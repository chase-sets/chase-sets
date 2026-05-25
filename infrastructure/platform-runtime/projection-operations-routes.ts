import { Hono } from "hono";
import {
  listProjectionBlockedStreamDetails,
  listProjectionGroupStatuses,
  rebuildAllContextProjectionGroups,
  rebuildContextProjectionGroup,
  refreshProjectionGroupStatuses,
  retryProjectionBlockedStream,
  summarizeProjectionReplayStatuses,
  type ContextProjectionGroupStatus,
} from "@chase-sets/bounded-context-runtime";
import { authenticationRequiredResponse, forbiddenResponse } from "@chase-sets/http/responses";
import type { ApiHostRuntime } from "./api";
import type { ResolvedActor } from "./auth";
import type { PlatformControlPlane, PlatformLease } from "./control-plane";

const PROJECTION_OPERATIONS_PERMISSION = "security.manage";
const OPERATION_LEASE_TTL_MS = 10 * 60 * 1_000;
const BLOCKED_PROJECTION_DETAILS_CONCURRENCY = 4;
const ACTIVE_WORKER_HEARTBEAT_MAX_AGE_MS = 60_000;
const EXPIRED_WORKER_HEARTBEAT_MAX_AGE_MS = 10 * 60_000;

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
    const projectionGroups =
      snapshots.length > 0 ? readProjectionGroupSnapshots(snapshots) : listProjectionGroupStatuses(runtime);
    const blockedProjections = await listBlockedProjectionDetails(runtime, projectionGroups);

    const workers = options.controlPlane ? await options.controlPlane.listWorkerHeartbeats() : [];

    return c.json({
      summary: summarizeProjectionReplayStatuses(projectionGroups),
      projectionGroups,
      blockedProjections,
      projectionStatusSource: snapshots.length > 0 ? "worker-snapshot" : "runtime-memory",
      workers: classifyWorkerHeartbeats(workers),
      runners: options.controlPlane ? await options.controlPlane.listRunnerStatuses() : [],
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
    const result = await withProjectionOperationLease(
      options.controlPlane,
      `projection-retry:${projectionKey}:${streamId}`,
      actorResponse,
      () => retryProjectionBlockedStream(runtime, projectionKey, streamId),
    );

    return c.json({ result });
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
    await withProjectionOperationLease(
      options.controlPlane,
      `projection-rebuild:${contextName}:${projectionName}`,
      actorResponse,
      () => rebuildContextProjectionGroup(runtime, contextName, projectionName),
    );

    return c.json({ result: { state: "rebuilt", contextName, projectionName } });
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
    await withProjectionOperationLease(
      options.controlPlane,
      `projection-rebuild:${contextName}:all`,
      actorResponse,
      () => rebuildAllContextProjectionGroups(runtime, contextName),
    );

    return c.json({ result: { state: "rebuilt", contextName } });
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

async function listBlockedProjectionDetails(
  runtime: ApiHostRuntime,
  projectionGroups: readonly ContextProjectionGroupStatus[],
) {
  const activeProjectionKeys = [
    ...new Set([
      ...projectionGroups.flatMap((group) =>
        group.subscriptions
          .filter((subscription) => subscription.blockedStreamCount > 0 || subscription.poisonEventCount > 0)
          .map((subscription) => subscription.checkpointKey),
      ),
    ]),
  ];

  const details = await mapWithConcurrency(
    activeProjectionKeys,
    BLOCKED_PROJECTION_DETAILS_CONCURRENCY,
    (projectionKey) =>
      listProjectionBlockedStreamDetails(runtime, projectionKey, {
        poisonEventLimit: 10,
      }),
  );

  return details.filter((detail) => detail.blockedStreams.length > 0 || detail.poisonEvents.length > 0);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex] as T);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));

  return results;
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

function readProjectionGroupSnapshots(
  snapshots: readonly Record<string, unknown>[],
): readonly ContextProjectionGroupStatus[] {
  return snapshots.flatMap((snapshot) => {
    const status = readJsonRecord(snapshot.status);
    if (!status) {
      return [];
    }

    return [
      {
        ...status,
        snapshot: {
          projectionKey: String(snapshot.projection_key ?? ""),
          runnerName: String(snapshot.runner_name ?? ""),
          ownerId: String(snapshot.owner_id ?? ""),
          updatedAt: formatTimestamp(snapshot.updated_at),
        },
      } as unknown as ContextProjectionGroupStatus,
    ];
  });
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

async function withProjectionOperationLease<T>(
  controlPlane: PlatformControlPlane | undefined,
  leaseName: string,
  actor: ResolvedActor,
  operation: () => Promise<T>,
): Promise<T> {
  let lease: PlatformLease | null = null;
  if (controlPlane) {
    lease = await controlPlane.acquireLease({
      leaseName,
      ownerId: `projection-ops:${actor.userId}`,
      ttlMs: OPERATION_LEASE_TTL_MS,
      metadata: {
        operation: leaseName,
        accountId: actor.accountId,
      },
    });

    if (!lease) {
      throw new Error(`Projection operation '${leaseName}' is already running.`);
    }
  }

  try {
    return await operation();
  } finally {
    if (controlPlane && lease) {
      await controlPlane.releaseLease(lease);
    }
  }
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
