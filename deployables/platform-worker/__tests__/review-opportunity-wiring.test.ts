import { describe, expect, it, vi } from "vitest";
import type { MarketplaceServices } from "@chase-sets/marketplace/server";
import { createRegisteredScheduledRunners } from "../src/scheduled-runners";

describe("registered review opportunity publication", () => {
  it("unconditionally invokes the real publication and backfill interface without sweep configuration", async () => {
    const publication: MarketplaceServices["reviewOpportunityPublication"] = {
      run: vi.fn(async () => 1),
      backfill: vi.fn(async () => 1),
    };
    const marketplace = { reviewOpportunityPublication: publication } satisfies Pick<
      MarketplaceServices,
      "reviewOpportunityPublication"
    >;
    const runners = createRegisteredScheduledRunners({
      services: { marketplace },
      config: {} as never,
      controlPlane: { claimScheduledRunner: async () => true, recordScheduledRunnerCompleted: vi.fn() } as never,
      logger: { info: vi.fn(), warn: vi.fn() },
      workSignalCleanup: () => ({ workSignalStore: { cleanupExpiredWorkSignals: vi.fn() } }),
      retentionSweep: () => ({ targets: [] }),
    });
    await runners.find((r) => r.name === "marketplace.review-opportunity-publication")!.runOnce();
    await runners.find((r) => r.name === "marketplace.review-opportunity-backfill")!.runOnce();
    expect(publication.run).toHaveBeenCalledTimes(1);
    expect(publication.run).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }));
    expect(publication.backfill).toHaveBeenCalledTimes(1);
  });
});
