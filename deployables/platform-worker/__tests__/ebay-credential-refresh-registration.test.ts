import { describe, expect, it, vi } from "vitest";
import { module as channelsModule } from "@chase-sets/channels";
import { parseEbayOAuthConfiguration } from "@chase-sets/channels/server";
import { createPostgresPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { createPostgresWorkSignalStore } from "@chase-sets/platform-runtime/work-signal-store";
import { createRegisteredScheduledRunners } from "./scheduled-job-test-support";
import { livenessConfig } from "./channels-liveness-config";

describe("eBay credential refresh registered worker", () => {
  it("registers exactly once at the policy cadence and omitted-runner control does not invoke maintenance", async () => {
    const unavailable = async (): Promise<never> => {
      throw new Error("unexpected-db");
    };
    const db = { query: unavailable, connect: unavailable };
    const channels = channelsModule.createServices(db, {
      channelSaleRecorder: unavailable,
      ebayOAuthConfiguration: parseEbayOAuthConfiguration(
        "sandbox",
        "synthetic-app",
        "synthetic-secret",
        "synthetic-runame",
      ),
    });
    const sweep = vi.spyOn(channels.ebayConnection!.credentialRefresh, "sweep").mockResolvedValue(1);
    const controlPlane = createPostgresPlatformControlPlane(db);
    const claim = vi.spyOn(controlPlane, "claimScheduledRunner").mockResolvedValueOnce(true).mockResolvedValue(false);
    vi.spyOn(controlPlane, "recordScheduledRunnerCompleted").mockResolvedValue(undefined);
    const runners = createRegisteredScheduledRunners({
      services: { channels },
      config: livenessConfig,
      controlPlane,
      logger: { info: vi.fn(), warn: vi.fn() },
      workSignalCleanup: () => ({ workSignalStore: createPostgresWorkSignalStore(db), intervalMs: 60000 }),
      retentionSweep: () => ({ targets: [] }),
    }).filter((r) => r.name === "channels.ebay-credential-refresh");
    expect(runners).toHaveLength(1);
    for (const runner of runners.filter(() => false)) await runner.runOnce();
    expect(sweep).not.toHaveBeenCalled();
    await runners[0].runOnce();
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: 450000 }));
    await runners[0].runOnce();
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
