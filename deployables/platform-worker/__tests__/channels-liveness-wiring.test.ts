import { readFileSync } from "node:fs";
import { module as channelsModule } from "@chase-sets/channels";
import { isChannelsServices } from "@chase-sets/channels/server";
import { createPostgresPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { createPostgresWorkSignalStore } from "@chase-sets/platform-runtime/work-signal-store";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { livenessConfig } from "./channels-liveness-config";
import { createRegisteredScheduledRunners } from "../src/scheduled-runners";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("channels-liveness-runner-registration", () => {
  const db: PgTransactionalPool = {
    query: async () => {
      throw new Error("unit registration must not query");
    },
    connect: async () => {
      throw new Error("unit registration must not connect");
    },
  };

  it.each([60_000, null])("registers exactly the named runner with interval %s", async (interval) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T12:00:00.000Z"));
    const channels = channelsModule.createServices(db, {
      channelSaleRecorder: async () => {
        throw new Error("no sale in registration");
      },
    });
    expect(isChannelsServices(channels)).toBe(true);
    const sweep = vi.spyOn(channels.connectionHealth, "sweepConnectorLiveness").mockResolvedValue({
      examined: 9,
      accepted: 2,
      refusals: [],
    });
    const controlPlane = createPostgresPlatformControlPlane(db);
    const claim = vi.spyOn(controlPlane, "claimScheduledRunner").mockResolvedValue(true);
    const completed = vi.spyOn(controlPlane, "recordScheduledRunnerCompleted").mockResolvedValue(undefined);
    const register = (candidate: unknown) =>
      createRegisteredScheduledRunners({
        services: { channels: candidate },
        config: { ...livenessConfig, channelsConnectorLivenessSweepIntervalMs: interval },
        controlPlane,
        logger: { info: vi.fn(), warn: vi.fn() },
        workSignalCleanup: () => ({ workSignalStore: createPostgresWorkSignalStore(db), intervalMs: 60_000 }),
        retentionSweep: () => ({ targets: [] }),
      }).filter((runner) => runner.name === "channels.connector-liveness-sweep");
    const runners = register(channels);
    expect(runners).toHaveLength(interval === null ? 0 : 1);
    expect(register(undefined)).toEqual([]);
    expect(register({ connectionHealth: { sweepConnectorLiveness: sweep } })).toEqual([]);
    expect(
      register({ ...channels, connectionHealth: { ...channels.connectionHealth, sweepConnectorLiveness: undefined } }),
    ).toEqual([]);
    if (interval !== null) {
      await expect(runners[0]!.runOnce()).resolves.toEqual({ processed: 2, lastGlobalPosition: "0" });
      expect(sweep).toHaveBeenCalledExactlyOnceWith({ now: "2026-10-09T12:00:00.000Z", limit: 100 });
      expect(claim).toHaveBeenCalledExactlyOnceWith({ runnerName: runners[0]!.name, intervalMs: interval });
      expect(completed).toHaveBeenCalledExactlyOnceWith({ runnerName: runners[0]!.name });
      claim.mockResolvedValue(false);
      await expect(runners[0]!.runOnce()).resolves.toMatchObject({ processed: 0 });
      expect(sweep).toHaveBeenCalledTimes(1);
    } else expect(sweep).not.toHaveBeenCalled();
  });
});

describe("channels-liveness-wiring", () => {
  it("enrolls both composed proofs in DB Profile Tests, never the unit profile", () => {
    const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    for (const file of [
      "channel-connector-liveness-hold-path.db.test.ts",
      "channel-connector-liveness-rebuild-fence.db.test.ts",
    ]) {
      expect(scripts["test:db"].split(" ")).toContain(`__tests__/${file}`);
      for (const profile of ["test", "test:fast", "test:unit"]) {
        expect(scripts[profile]).toContain(`--exclude __tests__/${file}`);
      }
    }
  });
  it("uses the exported guard without a Channels cast and forwards config from main", () => {
    const source = readFileSync(new URL("../src/scheduled-runners.ts", import.meta.url), "utf8");
    expect(source).toContain('import { isChannelsServices } from "@chase-sets/channels/server"');
    expect(source).toContain("isChannelsServices(channels)");
    expect(source).not.toMatch(/services\.channels\s+as\b/);
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/createRegisteredScheduledRunners\(\{\s*services: runtime\.services,\s*config,/);
    const env = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    expect(env).toMatch(/^CHANNELS_CONNECTOR_LIVENESS_SWEEP_INTERVAL_MS=60000$/m);
  });
});
