import { describe, expect, it } from "vitest";
import { createHealthRoutes } from "./health";

describe("health routes", () => {
  it("reports liveness without dependency checks", async () => {
    const app = createHealthRoutes();
    const response = await app.request("/live");

    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(response.status).toBe(200);
  });

  it("reports readiness with dependency and projection status", async () => {
    const app = createHealthRoutes({
      readinessChecks: [
        {
          name: "identity.database",
          check: async () => undefined,
        },
      ],
      getProjectionReplay: async () => ({
        status: "ok",
        totalGroups: 1,
        requiredGroups: 1,
        initializedGroups: 1,
        caughtUpGroups: 1,
        behindGroups: 0,
        runningGroups: 0,
        errorGroups: 0,
        contexts: [],
      }),
    });
    const response = await app.request("/ready");

    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      checks: [{ name: "identity.database", status: "ok" }],
      projectionReplay: { status: "ok" },
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
});
