import { describe, expect, it, vi } from "vitest";
import { createHealthRoutes } from "./health";

describe("health routes", () => {
  it("reports liveness without dependency checks", async () => {
    const app = createHealthRoutes();
    const response = await app.request("/live");

    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(response.status).toBe(200);
  });

  it("reports readiness with dependency status", async () => {
    const app = createHealthRoutes({
      readinessChecks: [
        {
          name: "identity.database",
          check: async () => undefined,
        },
      ],
    });
    const response = await app.request("/ready");

    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      checks: [{ name: "identity.database", status: "ok" }],
    });
    expect(response.status).toBe(200);
  });

  it("reports projection replay status outside readiness", async () => {
    const app = createHealthRoutes({
      getProjectionReplay: async () => ({
        status: "ok",
        totalGroups: 1,
        requiredGroups: 1,
        initializedGroups: 1,
        caughtUpGroups: 1,
        behindGroups: 0,
        staleGroups: 0,
        runningGroups: 0,
        errorGroups: 0,
        contexts: [],
      }),
    });
    const response = await app.request("/");

    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      projectionReplay: { status: "ok" },
    });
    expect(response.status).toBe(200);
  });

  it("keeps projection replay failures out of readiness", async () => {
    const app = createHealthRoutes({
      readinessChecks: [
        {
          name: "control.database",
          check: async () => undefined,
        },
      ],
      getProjectionReplay: async () => {
        throw new Error("projection replay unavailable");
      },
    });
    const response = await app.request("/ready");

    await expect(response.json()).resolves.toEqual({
      status: "ok",
      checks: [{ name: "control.database", status: "ok" }],
    });
    expect(response.status).toBe(200);
  });

  it("reports projection replay failures as degraded health", async () => {
    const app = createHealthRoutes({
      getProjectionReplay: async () => {
        throw new Error("projection replay unavailable");
      },
    });
    const response = await app.request("/");

    await expect(response.json()).resolves.toEqual({
      status: "degraded",
      projectionReplayError: {
        status: "degraded",
        message: "projection replay unavailable",
      },
    });
    expect(response.status).toBe(200);
  });

  it("returns 503 when readiness dependencies fail", async () => {
    const app = createHealthRoutes({
      readinessChecks: [
        {
          name: "identity.database",
          check: async () => {
            throw new Error("database unavailable");
          },
        },
      ],
    });
    const response = await app.request("/ready");

    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      checks: [
        {
          name: "identity.database",
          status: "degraded",
          message: "database unavailable",
        },
      ],
    });
    expect(response.status).toBe(503);
  });

  it("shares one dependency evaluation across concurrent readiness probes (#4768)", async () => {
    let checkInvocations = 0;
    let releaseCheck: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    const app = createHealthRoutes({
      readinessChecks: [
        {
          name: "control.database",
          check: async () => {
            checkInvocations += 1;
            await gate;
          },
        },
      ],
    });

    const first = app.request("/ready");
    // Let the first probe reach the shared in-flight evaluation before the second.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = app.request("/ready");
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseCheck();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    // Both probes collapse onto one DB round-trip instead of each acquiring a
    // pooled connection — the core of taking readiness off the pool hot path.
    expect(checkInvocations).toBe(1);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
  });

  it("reuses a cached ok result within the TTL without re-running checks (#4768)", async () => {
    let checkInvocations = 0;
    const app = createHealthRoutes({
      readinessChecks: [
        {
          name: "control.database",
          check: async () => {
            checkInvocations += 1;
          },
        },
      ],
    });

    const first = await app.request("/ready");
    const second = await app.request("/ready");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Second probe lands well within the 1s TTL, so it reuses the cached result.
    expect(checkInvocations).toBe(1);
  });

  it("still returns 503 once a dependency fails after the cached ok expires (#4768)", async () => {
    vi.useFakeTimers();
    try {
      let dbReachable = true;
      const app = createHealthRoutes({
        readinessChecks: [
          {
            name: "control.database",
            check: async () => {
              if (!dbReachable) {
                throw new Error("database unavailable");
              }
            },
          },
        ],
      });

      const healthy = await app.request("/ready");
      expect(healthy.status).toBe(200);

      // Database becomes unreachable; the cached ok must not mask it past the
      // TTL. Advancing one probe period (>1s TTL) expires the cache, and the
      // very next probe re-evaluates and ejects the pod — proving readiness is
      // not toothless (a genuinely down DB goes NotReady within ~30s given the
      // pinned 10s period / 3-failure chart config).
      dbReachable = false;
      vi.advanceTimersByTime(10_000);

      const afterTtl = await app.request("/ready");
      expect(afterTtl.status).toBe(503);
      await expect(afterTtl.json()).resolves.toMatchObject({
        status: "degraded",
        checks: [{ name: "control.database", status: "degraded", message: "database unavailable" }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails readiness immediately when draining even while the check cache is warm (#4768)", async () => {
    let draining = false;
    const app = createHealthRoutes({
      isDraining: () => draining,
      readinessChecks: [
        {
          name: "control.database",
          check: async () => undefined,
        },
      ],
    });

    // Warm the dependency cache with a healthy probe.
    const ready = await app.request("/ready");
    expect(ready.status).toBe(200);

    // Draining is evaluated fresh (never cached), so the next probe fails even
    // though the DB check result is still served from cache.
    draining = true;
    const drainingResponse = await app.request("/ready");
    expect(drainingResponse.status).toBe(503);
    await expect(drainingResponse.json()).resolves.toMatchObject({
      status: "degraded",
      checks: [
        { name: "process.draining", status: "degraded", message: "Process is draining for shutdown." },
        { name: "control.database", status: "ok" },
      ],
    });
  });

  it("returns 503 when the process is draining for shutdown", async () => {
    const app = createHealthRoutes({
      isDraining: () => true,
      readinessChecks: [
        {
          name: "control.database",
          check: async () => undefined,
        },
      ],
    });
    const response = await app.request("/ready");

    await expect(response.json()).resolves.toEqual({
      status: "degraded",
      checks: [
        {
          name: "process.draining",
          status: "degraded",
          message: "Process is draining for shutdown.",
        },
        { name: "control.database", status: "ok" },
      ],
    });
    expect(response.status).toBe(503);
  });
});
