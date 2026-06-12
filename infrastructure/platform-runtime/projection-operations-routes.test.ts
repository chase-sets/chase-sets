import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createProjectionOperationsRoutes } from "./projection-operations-routes";
import type { ResolvedActor } from "./auth";
import type { ApiHostRuntime } from "./api";
import type { PlatformControlPlane } from "./control-plane";

const platformActor = {
  sessionId: "sess_1",
  tenantId: "tenant_1",
  userId: "user_1",
  accountId: "account_1",
  membershipId: "member_1",
  roleKey: "platform-admin",
  permissions: ["security.manage"],
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
