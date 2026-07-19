import { describe, expect, it } from "vitest";
import {
  applyDevTargetEnvOverrides,
  browserE2eDirectCiCommands,
  browserE2ePlatformAdminEnv,
  browserE2ePlatformWorkerCiCommand,
  browserE2ePlatformWorkerEnv,
  browserE2eProductionBuilds,
  browserE2eProductionCommands,
  browserE2eProductionTarget,
  browserE2eRateLimitEnv,
  browserE2eReadConsistencyEnv,
  isBrowserE2eTarget,
  resolveBrowserE2eSystemTarget,
} from "./dev-system-config.mjs";

describe("dev system target env overrides", () => {
  it("configures only the browser e2e platform api with test-safe runtime overrides", () => {
    const processes = [
      { name: "platform-api", env: { PORT: "6182" } },
      {
        name: "platform-worker",
        env: {
          PORT: "6183",
          DATABASE_URL_IDENTITY: "postgres://identity",
        },
      },
      { name: "marketplace", env: { PORT: "6173" } },
    ];

    expect(applyDevTargetEnvOverrides("marketplace-full", processes, { ci: true })).toBe(processes);

    const browserE2eProcesses = applyDevTargetEnvOverrides("browser-e2e", processes, { ci: true });
    expect(browserE2eProcesses).not.toBe(processes);
    expect(browserE2eProcesses[0]).toMatchObject({
      name: "platform-api",
      env: {
        PORT: "6182",
        ...browserE2eRateLimitEnv,
        ...browserE2ePlatformAdminEnv,
        ...browserE2eReadConsistencyEnv,
      },
    });
    expect(browserE2eProcesses[1]).toEqual({
      name: "platform-worker",
      env: {
        PORT: "6183",
        DATABASE_URL_IDENTITY: "postgres://identity",
        ...browserE2ePlatformWorkerEnv,
      },
      ...browserE2ePlatformWorkerCiCommand,
    });
    expect(browserE2eProcesses[2]).toBe(processes[2]);
    expect(processes[0].env).toEqual({ PORT: "6182" });
  });

  it("starts the CI worker through its declared non-watch script", () => {
    expect(browserE2ePlatformWorkerCiCommand).toMatchObject({
      args: ["--filter", "@chase-sets/app-platform-worker", "run", "dev:ci"],
    });
  });

  it("keeps the watch-based worker loop for local browser development", () => {
    const worker = { name: "platform-worker", env: { PORT: "6183" } };

    expect(applyDevTargetEnvOverrides("browser-e2e", [worker], { ci: false })[0]).toEqual({
      ...worker,
      env: { ...worker.env, ...browserE2ePlatformWorkerEnv },
    });
  });

  it("resolves an explicit production system without changing the development default", () => {
    expect(resolveBrowserE2eSystemTarget({})).toBe("browser-e2e");
    expect(resolveBrowserE2eSystemTarget({ CHASE_SETS_BROWSER_E2E_SYSTEM: "development" })).toBe("browser-e2e");
    expect(resolveBrowserE2eSystemTarget({ CHASE_SETS_BROWSER_E2E_SYSTEM: "production" })).toBe(
      browserE2eProductionTarget,
    );
    expect(() => resolveBrowserE2eSystemTarget({ CHASE_SETS_BROWSER_E2E_SYSTEM: "preview" })).toThrow(
      /must be "development" or "production"/,
    );
  });

  it("starts every production browser e2e component without a watch wrapper", () => {
    const processes = [
      { name: "platform-api", env: { PORT: "6182" } },
      { name: "platform-worker", env: { PORT: "6183" } },
      { name: "admin-web", env: { PORT: "6174" } },
      { name: "marketplace", env: { PORT: "6173" } },
    ];

    const productionProcesses = applyDevTargetEnvOverrides(browserE2eProductionTarget, processes, { ci: true });

    for (const processDefinition of productionProcesses) {
      expect(processDefinition).toMatchObject({
        ...browserE2eProductionCommands[processDefinition.name],
      });
      expect(processDefinition.env).not.toHaveProperty("NODE_ENV");
      expect(processDefinition.args.join(" ")).not.toContain("watch");
    }
    expect(browserE2eProductionBuilds).toEqual([
      { name: "admin-web", workspace: "@chase-sets/app-admin-web" },
      { name: "marketplace", workspace: "@chase-sets/app-marketplace-web" },
    ]);
  });

  it("recognizes both browser e2e boot targets", () => {
    expect(isBrowserE2eTarget("browser-e2e")).toBe(true);
    expect(isBrowserE2eTarget(browserE2eProductionTarget)).toBe(true);
    expect(isBrowserE2eTarget("marketplace-full")).toBe(false);
  });
});
