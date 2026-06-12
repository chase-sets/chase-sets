import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { ApiHostRuntime } from "@chase-sets/platform-runtime/api";
import { buildAdminSupportApiApp } from "../src/app";

function createEmptyRuntime(): ApiHostRuntime {
  return {
    mountedContexts: [],
    mountedModules: [],
    services: {},
    projectionGroups: [],
    subscriptionRunners: [],
  };
}

function createAuthRuntime(): ApiHostRuntime {
  const authRouter = new Hono();
  authRouter.get("/social/providers", (c) => c.json({ providers: [] }));
  authRouter.get("/private", (c) => c.json({ ok: true }));
  const authServices = {
    identity: {
      bootstrapTenantId: "tnt_identity_bootstrap",
    },
  };
  const authModule = {
    contextName: "auth",
    apiMounts: [
      {
        mountPath: "/api/auth",
        kind: "primary",
        requiresAuth: false,
      },
    ],
    buildApis: () => [authRouter],
  };

  return {
    mountedContexts: [
      {
        contextName: "auth",
        mountRole: "active",
        module: authModule,
        services: authServices,
        pool: {},
        projectionHandlerSets: [],
      },
    ],
    mountedModules: [{ module: authModule, services: authServices }],
    services: {
      auth: authServices,
      identity: {},
    },
    projectionGroups: [],
    subscriptionRunners: [],
  } as unknown as ApiHostRuntime;
}

function createCatalogRuntime(): ApiHostRuntime {
  const catalogRouter = new Hono();
  catalogRouter.get("/source-observations/provider-profiles", (c) => c.json({ items: [] }));
  catalogRouter.post("/source-observations/provider-profiles", (c) => c.json({ created: true }, 201));
  const catalogModule = {
    contextName: "catalog",
    apiMounts: [
      {
        mountPath: "/api/catalog",
        kind: "primary",
        requiresAuth: true,
      },
    ],
    buildApis: () => [catalogRouter],
    projectionHandlerSets: () => [],
  };

  return {
    mountedContexts: [
      {
        contextName: "catalog",
        mountRole: "active",
        module: catalogModule,
        services: {},
        pool: {},
        projectionHandlerSets: [],
      },
    ],
    mountedModules: [{ module: catalogModule, services: {} }],
    services: {
      auth: {},
      catalog: {},
      identity: {},
    },
    projectionGroups: [],
    subscriptionRunners: [],
  } as unknown as ApiHostRuntime;
}

describe("admin-support API app", () => {
  it("serves readiness under the same-origin API prefix", async () => {
    const app = buildAdminSupportApiApp(createEmptyRuntime(), {
      readinessChecks: [
        {
          name: "test",
          check: async () => undefined,
        },
      ],
    });

    const response = await app.request("/api/health/ready");

    expect(response.status).toBe(200);
  });

  it("blocks admin self-registration unless explicitly enabled", async () => {
    const app = buildAdminSupportApiApp(createEmptyRuntime(), {
      adminRegistrationEnabled: false,
    });

    const response = await app.request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "registration_disabled" },
    });
  });

  it("allows anonymous social login discovery through the production admin API", async () => {
    const app = buildAdminSupportApiApp(createAuthRuntime());

    const response = await app.request("/api/auth/social/providers");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ providers: [] });
  });

  it("still requires authentication for other Auth API reads", async () => {
    const app = buildAdminSupportApiApp(createAuthRuntime());

    const response = await app.request("/api/auth/private");

    expect(response.status).toBe(401);
  });

  it("requires platform operations permission for projection operations", async () => {
    const app = buildAdminSupportApiApp(createEmptyRuntime(), {
      resolveActor: async () => ({
        sessionId: "ses_test",
        tenantId: "tnt_test",
        userId: "usr_test",
        accountId: "acc_test",
        membershipId: "mem_test",
        roleKey: "catalog-admin",
        permissions: ["catalog.view"],
      }),
    });

    const response = await app.request("/api/platform/projections");

    expect(response.status).toBe(403);
  });

  it("returns projection operations status for platform operators", async () => {
    const app = buildAdminSupportApiApp(createEmptyRuntime(), {
      resolveActor: async () => ({
        sessionId: "ses_test",
        tenantId: "tnt_test",
        userId: "usr_test",
        accountId: "acc_test",
        membershipId: "mem_test",
        roleKey: "platform-admin",
        permissions: ["security.manage"],
      }),
    });

    const response = await app.request("/api/platform/projections");

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

  it("requires platform operations permission for the push-wake status endpoint", async () => {
    const app = buildAdminSupportApiApp(createEmptyRuntime(), {
      resolveActor: async () => ({
        sessionId: "ses_test",
        tenantId: "tnt_test",
        userId: "usr_test",
        accountId: "acc_test",
        membershipId: "mem_test",
        roleKey: "catalog-admin",
        permissions: ["catalog.view"],
      }),
    });

    const response = await app.request("/api/platform/projections/wake-status");

    expect(response.status).toBe(403);
  });

  it("returns structural push-wake pipeline status for platform operators", async () => {
    const app = buildAdminSupportApiApp(createEmptyRuntime(), {
      resolveActor: async () => ({
        sessionId: "ses_test",
        tenantId: "tnt_test",
        userId: "usr_test",
        accountId: "acc_test",
        membershipId: "mem_test",
        roleKey: "platform-admin",
        permissions: ["security.manage"],
      }),
      controlPlane: {
        listLeases: async () => [
          {
            lease_name: "projection-wake-relay:active",
            owner_id: "platform-worker-1",
            fencing_token: "12",
            acquired_at: "2026-06-10T11:50:00.000Z",
            renewed_at: "2026-06-10T11:59:00.000Z",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            metadata: { sensitive: "never-forwarded" },
          },
        ],
        listProjectionWakeRelayCursors: async () => [
          {
            sourceContextName: "checkout",
            lastFanOutPosition: 102n,
            lastRequiredCursor: "checkout:102",
            ownerId: "platform-worker-1",
            fencingToken: "12",
            metadata: {
              reason: "notify",
              streamCategory: "checkout-session",
              projectionInterestIndexVersion: "v3",
              arbitraryKey: "never-forwarded",
            },
            updatedAt: "2026-06-10T11:59:30.000Z",
          },
        ],
        listWorkerHeartbeats: async () => [
          {
            worker_id: "platform-worker-1",
            worker_kind: "platform-worker",
            heartbeat_at: new Date().toISOString(),
            metadata: {
              runnerGroups: {
                wakes: { runnerCount: 3, maxConcurrentRunners: 3 },
                projections: { runnerCount: 8, maxConcurrentRunners: 4 },
              },
            },
          },
          {
            worker_id: "admin-support-worker-1",
            worker_kind: "admin-support-worker",
            heartbeat_at: new Date().toISOString(),
            metadata: { runnerGroups: { projections: { runnerCount: 2, maxConcurrentRunners: 2 } } },
          },
        ],
      } as unknown as NonNullable<Parameters<typeof buildAdminSupportApiApp>[1]>["controlPlane"],
      workSignalStore: {
        summarizeProjectionWakeIntents: async () => ({
          queuedCount: 2,
          claimedCount: 1,
          failedCount: 0,
          expiredCount: 0,
          staleClaimCount: 0,
          oldestQueuedAt: new Date("2026-06-10T11:58:00.000Z"),
          oldestClaimedAt: null,
        }),
        summarizeProjectionWakeIntentBreakdown: async () => [
          {
            priorityLane: "hot",
            origin: "api-wait",
            state: "queued",
            intentCount: 2,
            oldestCreatedAt: new Date("2026-06-10T11:58:00.000Z"),
            maxAttemptCount: 0,
          },
        ],
        summarizeCheckpointSignals: async () => ({
          readinessCount: 4,
          expiredReadinessCount: 0,
          latestReadyRecordedAt: new Date("2026-06-10T11:59:45.000Z"),
          pendingWaiterCount: 1,
          expiredPendingWaiterCount: 0,
          satisfiedWaiterCount: 9,
          oldestPendingWaiterAt: new Date("2026-06-10T11:59:00.000Z"),
          pendingWaiterOrigins: [{ origin: "api-wait", waiterCount: 1 }],
        }),
      },
    });

    const response = await app.request("/api/platform/projections/wake-status");

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, never>;
    expect(body).toMatchObject({
      wakeStore: {
        available: true,
        intentSummary: {
          queuedCount: 2,
          claimedCount: 1,
          oldestQueuedAt: "2026-06-10T11:58:00.000Z",
        },
        intentBreakdown: [{ priorityLane: "hot", origin: "api-wait", state: "queued", intentCount: 2 }],
        checkpointSignals: {
          readinessCount: 4,
          pendingWaiterCount: 1,
          pendingWaiterOrigins: [{ origin: "api-wait", waiterCount: 1 }],
        },
      },
      relay: {
        available: true,
        activeLeaseName: "projection-wake-relay:active",
        lease: {
          ownerId: "platform-worker-1",
          fencingToken: "12",
          state: "active",
        },
        cursors: [
          {
            sourceContextName: "checkout",
            lastFanOutPosition: "102",
            interestIndexVersion: "v3",
            lastAdvanceReason: "notify",
            lastStreamCategory: "checkout-session",
          },
        ],
      },
      schedulers: {
        available: true,
        wakeCapableWorkerCount: 1,
        activeWakeCapableWorkerCount: 1,
        workers: [{ workerId: "platform-worker-1", workerState: "active", wakeRunnerCount: 3 }],
      },
      rollout: {
        summary: { entryCount: expect.any(Number) },
      },
      // Push-first migration inventory (#1224): disposition by projection
      // group, derived from the wake registry. Structural fields only.
      migration: {
        summary: {
          projectionCount: expect.any(Number),
          optOutCount: 0,
          routeDependencyCount: expect.any(Number),
        },
        projections: expect.arrayContaining([
          expect.objectContaining({
            projectionKey: "checkout:checkout.session-projection",
            owner: "Checkout",
            status: "push-enabled",
            consumesDurableWakeIntents: true,
          }),
        ]),
      },
      // Composite-origin dispositions (#1248/#1238): structural inventory of
      // which wake families ride the work-signal composite versus documented
      // exceptions.
      origins: expect.arrayContaining([
        expect.objectContaining({
          origin: "projection-operation-events",
          kind: "projection-operation.event",
          disposition: "composite",
        }),
        expect.objectContaining({
          origin: "durable-job-events",
          kind: "durable-job.event",
          channel: "durable_job_events",
          disposition: "composite",
        }),
        expect.objectContaining({
          origin: "realtime-outbox-wake",
          kind: "realtime.outbox-wake",
          channel: "realtime_projection_patch",
          disposition: "composite",
        }),
        expect.objectContaining({
          origin: "event-store-commit",
          disposition: "approved-exception",
        }),
        expect.objectContaining({
          origin: "notification-outbox",
          disposition: "scheduled-exception",
        }),
      ]),
    });
    // Privacy posture: structural fields only — lease/cursor metadata is never
    // forwarded wholesale.
    expect(JSON.stringify(body)).not.toContain("never-forwarded");
    expect(JSON.stringify(body)).not.toContain("arbitraryKey");
  });

  it("reports unavailable push-wake sections when control plane and wake store are not wired", async () => {
    const app = buildAdminSupportApiApp(createEmptyRuntime(), {
      resolveActor: async () => ({
        sessionId: "ses_test",
        tenantId: "tnt_test",
        userId: "usr_test",
        accountId: "acc_test",
        membershipId: "mem_test",
        roleKey: "platform-admin",
        permissions: ["security.manage"],
      }),
    });

    const response = await app.request("/api/platform/projections/wake-status");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      wakeStore: { available: false },
      relay: { available: false },
      schedulers: { available: false },
      rollout: {
        summary: { entryCount: expect.any(Number) },
        sources: expect.any(Array),
      },
      migration: {
        summary: { projectionCount: expect.any(Number) },
        projections: expect.any(Array),
      },
      origins: expect.any(Array),
    });
  });

  it("requires catalog manage permission for Catalog API mutations", async () => {
    const app = buildAdminSupportApiApp(createCatalogRuntime(), {
      resolveActor: async () => ({
        sessionId: "ses_test",
        tenantId: "tnt_test",
        userId: "usr_test",
        accountId: "acc_test",
        membershipId: "mem_test",
        roleKey: "catalog-viewer",
        permissions: ["catalog.view"],
      }),
    });

    const readResponse = await app.request("/api/catalog/source-observations/provider-profiles");
    expect(readResponse.status).toBe(200);

    const writeResponse = await app.request("/api/catalog/source-observations/provider-profiles", {
      method: "POST",
      body: JSON.stringify({ version: {} }),
      headers: { "Content-Type": "application/json" },
    });
    expect(writeResponse.status).toBe(403);
    await expect(writeResponse.json()).resolves.toMatchObject({
      error: { code: "authorization_forbidden" },
    });
  });

  it("rejects unauthenticated Catalog API requests before mounted Catalog routes run", async () => {
    const app = buildAdminSupportApiApp(createCatalogRuntime(), {
      resolveActor: async () => null,
    });

    const response = await app.request("/api/catalog/source-observations/provider-profiles");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "authentication_required" },
    });
  });
});
