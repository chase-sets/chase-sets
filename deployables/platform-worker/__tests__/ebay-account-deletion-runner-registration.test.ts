import { describe, expect, it, vi } from "vitest";
import { module as channelsModule } from "@chase-sets/channels";
import { createPostgresPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { createPostgresWorkSignalStore } from "@chase-sets/platform-runtime/work-signal-store";
import { createRegisteredScheduledRunners } from "../src/scheduled-runners";
import { livenessConfig } from "./channels-liveness-config";

describe("eBay receipt registered worker", () => {
  it("requires the actual registered runner; omitted-runner control leaves the expired backlog", async () => {
    const unavailable = async (): Promise<never> => {
      throw new Error("unexpected-db");
    };
    const db = { query: unavailable, connect: unavailable };
    const channels = channelsModule.createServices(db, { channelSaleRecorder: unavailable });
    let backlog = 1001;
    vi.spyOn(channels.ebayReceiptExpiry, "cutoff").mockResolvedValue("2026-10-11T00:00:00Z");
    vi.spyOn(channels.ebayReceiptExpiry, "batch").mockImplementation(async () => {
      const deleted = Math.min(500, backlog);
      backlog -= deleted;
      return { deleted, remaining: backlog > 0 };
    });
    const controlPlane = createPostgresPlatformControlPlane(db);
    vi.spyOn(controlPlane, "claimScheduledRunner").mockResolvedValue(false);
    const completed = vi.spyOn(controlPlane, "recordScheduledRunnerCompleted").mockResolvedValue(undefined);
    const runners = createRegisteredScheduledRunners({
      services: { channels },
      config: livenessConfig,
      controlPlane,
      logger: { info: vi.fn(), warn: vi.fn() },
      workSignalCleanup: () => ({ workSignalStore: createPostgresWorkSignalStore(db), intervalMs: 60000 }),
      retentionSweep: () => ({ targets: [] }),
    });
    const receiptRunners = runners.filter((runner) => runner.name === "channels.ebay-account-deletion-receipt-expiry");
    expect(receiptRunners).toHaveLength(1);
    const run = async (selected: typeof receiptRunners) => {
      for (const runner of selected) {
        let result;
        do {
          result = await runner.runOnce();
        } while (runner.rescheduleOnCompletion?.(result));
      }
    };
    await run(receiptRunners.filter(() => false));
    expect(backlog).toBe(1001);
    await run(receiptRunners);
    expect(backlog).toBe(0);
    expect(completed).toHaveBeenCalledTimes(1);
    await run(receiptRunners);
    expect(channels.ebayReceiptExpiry.batch).toHaveBeenCalledTimes(3);
  });
});
