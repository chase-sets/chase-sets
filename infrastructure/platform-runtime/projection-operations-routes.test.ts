import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createProjectionOperationsRoutes } from "./projection-operations-routes";
import type { ResolvedActor } from "./auth";
import type { ApiHostRuntime } from "./api";
import type { PlatformControlPlane, ProjectionOperationKind, ProjectionOperationRecord } from "./control-plane";

const platformActor = {
  sessionId: "sess_1",
  tenantId: "tenant_1",
  userId: "user_1",
  accountId: "account_1",
  membershipId: "member_1",
  roleKey: "platform-admin",
  permissions: ["projection-operations.view", "projection-operations.operate", "projection-operations.rebuild"],
} satisfies ResolvedActor;

function createRouteApp(
  actor: ResolvedActor | null,
  runtime: ApiHostRuntime = createRuntime(),
  options: Parameters<typeof createProjectionOperationsRoutes>[1] = {},
) {
  const app = new Hono<{ Variables: { actor: ResolvedActor | null } }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", createProjectionOperationsRoutes(runtime, options));
  return app;
}

function createRuntime(projectionGroups: ApiHostRuntime["projectionGroups"] = []): ApiHostRuntime {
  return {
    mountedContexts: [],
    mountedModules: [],
    services: {},
    projectionGroups,
    subscriptionRunners: [],
  };
}

function createControlPlane(overrides: Partial<PlatformControlPlane> = {}): PlatformControlPlane {
  return {
    listProjectionStatusSnapshots: vi.fn(async () => []),
    listWorkerHeartbeats: vi.fn(async () => []),
    listRunnerStatuses: vi.fn(async () => []),
    listProjectionOperations: vi.fn(async () => []),
    summarizeProjectionOperations: vi.fn(async () => ({
      queuedCount: "0",
      runningCount: "0",
      failedCount: "0",
      cancelRequestedCount: "0",
      oldestQueuedAt: null,
      oldestRunningAt: null,
      averageDurationMs: null,
    })),
    ...overrides,
  } as unknown as PlatformControlPlane;
}

function projectionOperation(
  operationId: string,
  operationKind: ProjectionOperationKind = "retry-blocked-stream",
): ProjectionOperationRecord {
  return {
    operationId,
    operationKind,
    state: "queued",
    contextName: "catalog",
    projectionName: operationKind === "retry-blocked-stream" ? null : "catalog-item-projection",
    projectionKey: operationKind === "retry-blocked-stream" ? "catalog.projection" : null,
    streamId: operationKind === "retry-blocked-stream" ? "stream_1" : null,
    requestedByUserId: platformActor.userId,
    requestedByAccountId: platformActor.accountId,
    claimOwnerId: null,
    claimFencingToken: null,
    claimedUntil: null,
    attemptCount: 0,
    nextEligibleAt: "2026-06-29T00:00:00.000Z",
    progress: {},
    result: null,
    error: null,
    requestedAt: "2026-06-29T00:00:00.000Z",
    startedAt: null,
    updatedAt: "2026-06-29T00:00:00.000Z",
    completedAt: null,
  };
}

function createIdentityConsentProjectionRuntime(): ApiHostRuntime {
  const pool = {
    query: vi.fn(async <Row>(sql: string) => {
      if (sql.includes("FROM event_projection_blocked_streams")) {
        return {
          rows: [
            {
              projection_key: "identity-consent-projection:identity:v1",
              stream_id: "identity.legacy-fact-1",
              first_blocked_global_position: "1",
              first_blocked_stream_version: "1",
              last_seen_global_position: "1",
              deferred_event_count: "0",
              state: "blocked",
            } as Row,
          ],
          rowCount: 1,
        };
      }

      if (sql.includes("FROM event_projection_poison_events")) {
        return {
          rows: [
            {
              projection_key: "identity-consent-projection:identity:v1",
              event_id: "evt_identity_legacy_1",
              projection_name: "identity-consent-projection",
              projection_kind: "subscription",
              target_context_name: "identity",
              source_context_name: "identity",
              projection_revision: "0",
              subscription_version: "0",
              stream_id: "identity.legacy-fact-1",
              stream_version: "1",
              event_type: "identity.legacy-fact-recorded",
              global_position: "1",
              failure_kind: "poison",
              error_message: null,
              error_stack: null,
              state: "blocked",
              retry_count: "0",
              first_seen_at: "2026-07-06T00:00:00.000Z",
              last_seen_at: "2026-07-06T00:00:00.000Z",
              resolved_at: null,
            } as Row,
          ],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected projection operation SQL: ${sql}`);
    }),
  };

  return {
    mountedContexts: [
      {
        contextName: "identity",
        pool,
      },
    ],
    mountedModules: [],
    services: {},
    projectionGroups: [],
    subscriptionRunners: [
      {
        checkpointKey: "identity-consent-projection:identity:v1",
        targetContextName: "identity",
        projectionName: "identity-consent-projection",
      },
    ],
  } as unknown as ApiHostRuntime;
}

describe("projection operations routes", () => {
  it("requires an authenticated actor", async () => {
    const app = createRouteApp(null);

    const response = await app.request("/");

    expect(response.status).toBe(401);
  });

  it("requires platform operations permission", async () => {
    const app = createRouteApp({
      ...platformActor,
      permissions: ["catalog.view"],
    });

    const response = await app.request("/");

    expect(response.status).toBe(403);
  });

  it("allows projection operations view actors to inspect the console", async () => {
    const app = createRouteApp({
      ...platformActor,
      permissions: ["projection-operations.view"],
    });

    const response = await app.request("/");

    expect(response.status).toBe(200);
  });

  it("requires operate permission for refresh, retry, and cancel actions", async () => {
    const controlPlane = createControlPlane({
      enqueueProjectionOperation: vi.fn(async () => projectionOperation("op_retry")),
      cancelProjectionOperation: vi.fn(async () => true),
    });
    const viewOnlyApp = createRouteApp(
      { ...platformActor, permissions: ["projection-operations.view"] },
      createRuntime(),
      {
        controlPlane,
      },
    );
    const operatorApp = createRouteApp(
      { ...platformActor, permissions: ["projection-operations.view", "projection-operations.operate"] },
      createRuntime(),
      { controlPlane },
    );

    expect((await viewOnlyApp.request("/refresh", { method: "POST" })).status).toBe(403);
    expect(
      (await viewOnlyApp.request("/catalog.projection/blocked-streams/stream_1/retry", { method: "POST" })).status,
    ).toBe(403);
    expect((await viewOnlyApp.request("/operations/op_1/cancel", { method: "POST" })).status).toBe(403);

    expect((await operatorApp.request("/refresh", { method: "POST" })).status).toBe(200);
    expect(
      (await operatorApp.request("/catalog.projection/blocked-streams/stream_1/retry", { method: "POST" })).status,
    ).toBe(202);
    expect((await operatorApp.request("/operations/op_1/cancel", { method: "POST" })).status).toBe(200);
  });

  it("preserves dotted projection names when enqueueing blocked-stream retries", async () => {
    const enqueueProjectionOperation = vi.fn(async () => projectionOperation("op_retry"));
    const app = createRouteApp(platformActor, createRuntime(), {
      controlPlane: createControlPlane({ enqueueProjectionOperation }),
    });

    const response = await app.request("/checkout.checkout.session-projection/blocked-streams/stream_1/retry", {
      method: "POST",
    });

    expect(response.status).toBe(202);
    expect(enqueueProjectionOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKind: "retry-blocked-stream",
        contextName: "checkout",
        projectionKey: "checkout.checkout.session-projection",
        streamId: "stream_1",
      }),
    );
  });

  it("serves identity blocked-stream details when legacy poison metadata is incomplete", async () => {
    const app = createRouteApp(platformActor, createIdentityConsentProjectionRuntime());

    const response = await app.request("/identity.identity-consent-projection/blocked-streams");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      projectionKey: "identity.identity-consent-projection",
      blockedStreams: [
        {
          projectionKey: "identity-consent-projection:identity:v1",
          streamId: "identity.legacy-fact-1",
          firstBlockedGlobalPosition: "1",
          firstBlockedStreamVersion: 1,
          state: "blocked",
        },
      ],
      poisonEvents: [
        {
          projectionKey: "identity-consent-projection:identity:v1",
          projectionName: "identity-consent-projection",
          projectionRevision: null,
          subscriptionVersion: null,
          errorMessage: "Projection failed without a recorded error message.",
        },
      ],
    });
  });

  it("requires rebuild permission and records actor attribution for destructive rebuilds", async () => {
    const enqueueProjectionOperation = vi.fn(async () => projectionOperation("op_rebuild", "rebuild-projection-group"));
    const controlPlane = createControlPlane({ enqueueProjectionOperation });
    const operatorApp = createRouteApp(
      { ...platformActor, permissions: ["projection-operations.view", "projection-operations.operate"] },
      createRuntime(),
      { controlPlane },
    );
    const rebuildApp = createRouteApp(
      {
        ...platformActor,
        permissions: ["projection-operations.view", "projection-operations.operate", "projection-operations.rebuild"],
      },
      createRuntime(),
      { controlPlane },
    );

    const operatorResponse = await operatorApp.request("/groups/catalog/catalog-item-projection/rebuild", {
      method: "POST",
      body: JSON.stringify({ confirm: "rebuild" }),
      headers: { "Content-Type": "application/json" },
    });
    const rebuildResponse = await rebuildApp.request("/groups/catalog/catalog-item-projection/rebuild", {
      method: "POST",
      body: JSON.stringify({ confirm: "rebuild" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(operatorResponse.status).toBe(403);
    expect(rebuildResponse.status).toBe(202);
    expect(enqueueProjectionOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKind: "rebuild-projection-group",
        requestedByUserId: platformActor.userId,
        requestedByAccountId: platformActor.accountId,
      }),
    );
  });

  it("summarizes runtime-memory projection status", async () => {
    const app = createRouteApp(platformActor);

    const response = await app.request("/");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: {
        status: "ok",
        totalGroups: 0,
      },
      projectionGroups: [],
      blockedProjections: [],
      projectionStatusSource: "runtime-memory",
      workers: [],
      runners: [],
    });
  });

  it("serves worker snapshots without live refreshing runtime projection groups", async () => {
    const refreshStatus = vi.fn(async () => {
      throw new Error("Projection operations should not live refresh by default.");
    });
    const runtime = createRuntime([
      {
        targetContextName: "inventory",
        projectionName: "inventory-catalog-item-projection",
        refreshStatus,
        getStatus: () => ({
          targetContextName: "inventory",
          projectionName: "inventory-catalog-item-projection",
          projectionRevision: 1,
          storedProjectionRevision: 1,
          revisionStale: false,
          sourceContextNames: ["catalog"],
          ownedTables: ["inventory_catalog_items"],
          requiredDuringBootstrap: true,
          initialized: false,
          caughtUp: false,
          state: "behind",
          lastError: null,
          outstandingEventCount: "10",
          blockedStreamCount: 0,
          poisonEventCount: 0,
          updatedAt: "2026-05-25T00:00:00.000Z",
          subscriptions: [],
        }),
      },
    ] as unknown as ApiHostRuntime["projectionGroups"]);
    const controlPlane = createControlPlane({
      listProjectionStatusSnapshots: vi.fn(async () => [
        {
          projection_key: "inventory.inventory-catalog-item-projection",
          target_context_name: "inventory",
          projection_name: "inventory-catalog-item-projection",
          runner_name: "inventory.inventory-catalog-item-projection",
          owner_id: "worker-a",
          status: {
            targetContextName: "inventory",
            projectionName: "inventory-catalog-item-projection",
            projectionRevision: 1,
            storedProjectionRevision: 1,
            revisionStale: false,
            sourceContextNames: ["catalog"],
            ownedTables: ["inventory_catalog_items"],
            requiredDuringBootstrap: true,
            initialized: true,
            caughtUp: false,
            state: "running",
            lastError: null,
            outstandingEventCount: "42",
            blockedStreamCount: 0,
            poisonEventCount: 0,
            updatedAt: "2026-05-25T00:00:00.000Z",
            subscriptions: [],
          },
          updated_at: new Date().toISOString(),
        },
      ]),
    });
    const app = createRouteApp(platformActor, runtime, { controlPlane });

    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(refreshStatus).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      projectionStatusSource: "worker-snapshot",
      projectionGroups: [
        {
          targetContextName: "inventory",
          projectionName: "inventory-catalog-item-projection",
          state: "running",
          outstandingEventCount: "42",
          snapshot: {
            runnerName: "inventory.inventory-catalog-item-projection",
            ownerId: "worker-a",
          },
        },
      ],
    });
  });
});
