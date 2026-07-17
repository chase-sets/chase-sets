import { describe, expect, it } from "vitest";
import {
  applyDevTargetEnvOverrides,
  browserE2eDirectCiCommands,
  browserE2ePlatformAdminEnv,
  browserE2ePlatformWorkerCiCommand,
  browserE2ePlatformWorkerEnv,
  browserE2eRateLimitEnv,
  browserE2eReadConsistencyEnv,
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

  it("keeps the watch-based worker loop for local browser development", () => {
    const worker = { name: "platform-worker", env: { PORT: "6183" } };

    expect(applyDevTargetEnvOverrides("browser-e2e", [worker], { ci: false })[0]).toEqual({
      ...worker,
      env: { ...worker.env, ...browserE2ePlatformWorkerEnv },
    });
  });
});
