import { describe, expect, it, vi } from "vitest";
import type { HealthProjectionReplaySummary } from "@chase-sets/platform-runtime/health";
import { buildPlatformApiApp } from "../src/app";

describe("platform api app", () => {
  it("mounts the health route", async () => {
    const app = buildPlatformApiApp(
      {
        mountedContexts: [],
        mountedModules: [],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [],
        projectionGroups: [],
        subscriptionRunners: [],
      },
      {
        getProjectionReplay: vi.fn(async () => ({
          status: "ok",
          totalGroups: 0,
          requiredGroups: 0,
          initializedGroups: 0,
          caughtUpGroups: 0,
          behindGroups: 0,
          runningGroups: 0,
          errorGroups: 0,
          contexts: [],
        } satisfies HealthProjectionReplaySummary)),
      },
    );

    const response = await app.request("/health");

    expect(response.status).toBe(200);
  });
});
