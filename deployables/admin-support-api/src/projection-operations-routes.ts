import { Hono } from "hono";
import {
  listProjectionBlockedStreamDetails,
  rebuildAllContextProjectionGroups,
  rebuildContextProjectionGroup,
  refreshProjectionGroupStatuses,
  retryProjectionBlockedStream,
  summarizeProjectionReplayStatuses,
  type ContextProjectionGroupStatus,
} from "@chase-sets/bounded-context-runtime";
import type { ApiHostRuntime } from "@chase-sets/platform-runtime/api";
import type { PlatformControlPlane, PlatformLease } from "@chase-sets/platform-runtime/control-plane";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { authenticationRequiredResponse, forbiddenResponse } from "@chase-sets/http/responses";
import type { TenantContextEnv } from "./middleware/auth-context";

const PROJECTION_OPERATIONS_PERMISSION = "security.manage";
const OPERATION_LEASE_TTL_MS = 10 * 60 * 1_000;

export type ProjectionOperationsRouteOptions = Readonly<{
  controlPlane?: PlatformControlPlane;
}>;

export function createProjectionOperationsRoutes(
  runtime: ApiHostRuntime,
  options: ProjectionOperationsRouteOptions = {},
) {
  const app = new Hono<TenantContextEnv>();

  app.get("/", async (c) => {
    const actorResponse = requireProjectionOperationsActor(c.get("actor"));
    if (actorResponse instanceof Response) {
      return actorResponse;
    }

    const projectionGroups = await refreshProjectionGroupStatuses(runtime);
    const blockedProjections = await listBlockedProjectionDetails(runtime, projectionGroups);

    return c.json({
      summary: summarizeProjectionReplayStatuses(projectionGroups),
      projectionGroups,
      blockedProjections,
      workers: options.controlPlane ? await options.controlPlane.listWorkerHeartbeats() : [],
      runners: options.controlPlane ? await options.controlPlane.listRunnerStatuses() : [],
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
      ...runtime.mountedContexts.flatMap((context) =>
        context.projectors.flatMap((projector) => (projector.projectorName ? [projector.projectorName] : [])),
      ),
    ]),
  ];

  const details = await Promise.all(
    activeProjectionKeys.map((projectionKey) =>
      listProjectionBlockedStreamDetails(runtime, projectionKey, {
        poisonEventLimit: 10,
      }),
    ),
  );

  return details.filter((detail) => detail.blockedStreams.length > 0 || detail.poisonEvents.length > 0);
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
