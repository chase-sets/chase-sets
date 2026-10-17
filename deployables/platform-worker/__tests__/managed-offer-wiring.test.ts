import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import type { MarketplaceServices } from "@chase-sets/marketplace/server";
import { createRegisteredScheduledRunners } from "../src/scheduled-runners";

describe("registered managed Offer entrypoints", () => {
  it("dispatches the declared Pricing reaction and both scheduled runners to the typed Marketplace work service", async () => {
    const work: MarketplaceServices["managedOfferWork"] = {
      enqueue: vi.fn(async () => "work"),
      run: vi.fn(async () => 1),
      recover: vi.fn(async () => 1),
    };
    const services = {
      managedOfferWork: work,
      db: { query: vi.fn() },
      policies: {},
      listings: {},
      reviews: {},
    } as unknown as MarketplaceServices;
    const reaction = marketplaceModule.buildSubscriptions!(services).find(
      (s) => s.reactionName === "marketplace-managed-offer-reaction",
    )!;
    const event = buildTransportEvent("pricing.market-price.estimated", {
      catalogItemId: "cat_one",
      productId: "cat_one::",
      estimateVersion: "7",
    });
    expect(work.enqueue).not.toHaveBeenCalled();
    await reaction.handlers[event.type]!(event);
    expect(work.enqueue).toHaveBeenCalledWith(
      { catalogItemId: "cat_one", productId: "cat_one::" },
      event.id,
      expect.any(Object),
    );
    const runners = createRegisteredScheduledRunners({
      services: { marketplace: services },
      config: {} as never,
      controlPlane: { claimScheduledRunner: async () => true, recordScheduledRunnerCompleted: vi.fn() } as never,
      logger: { info: vi.fn(), warn: vi.fn() },
      workSignalCleanup: () => ({ workSignalStore: { cleanupExpiredWorkSignals: vi.fn() } }),
      retentionSweep: () => ({ targets: [] }),
    });
    await runners.find((r) => r.name === "marketplace.managed-offer-work")!.runOnce();
    await runners.find((r) => r.name === "marketplace.managed-offer-recovery")!.runOnce();
    expect(work.run).toHaveBeenCalledTimes(1);
    expect(work.recover).toHaveBeenCalledTimes(1);
  });
});
