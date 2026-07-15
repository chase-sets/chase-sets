import { describe, expect, it } from "vitest";
import {
  applyDevTargetEnvOverrides,
  browserE2ePlatformAdminEnv,
  browserE2eProjectionWakeEnv,
  browserE2eRateLimitEnv,
  browserE2eReadConsistencyEnv,
} from "./dev-system-config.mjs";

describe("dev system target env overrides", () => {
  it("configures browser e2e API freshness and projection wake capacity", () => {
    const processes = [
      { name: "platform-api", env: { PORT: "6182" } },
      { name: "platform-worker", env: { PORT: "6183" } },
      { name: "marketplace", env: { PORT: "6173" } },
    ];

    expect(applyDevTargetEnvOverrides("marketplace-full", processes)).toBe(processes);

    const browserE2eProcesses = applyDevTargetEnvOverrides("browser-e2e", processes);
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
    expect(browserE2eProcesses[1]).toMatchObject({
      name: "platform-worker",
      env: {
        PORT: "6183",
        ...browserE2eProjectionWakeEnv,
      },
    });
    expect(browserE2eProcesses[2]).toBe(processes[2]);
    expect(processes[0].env).toEqual({ PORT: "6182" });
    expect(processes[1].env).toEqual({ PORT: "6183" });
  });
});
