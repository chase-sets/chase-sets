import { describe, expect, it, vi } from "vitest";
import { createOfferEconomicsRuntime } from "./offer-economics-runtime";
import type { OfferEconomicsCrossContextPort } from "./offer-economics-contracts";

function fakeCrossContext(): OfferEconomicsCrossContextPort {
  return {
    getLockedFeeListingCohortSummary: vi.fn(async () => ({
      listingsCreatedCount: 5,
      lockedSellerAccountIds: ["acc_founder_1"],
      weeklyListingsCreated: [{ weekStart: "2026-06-29", listingsCreatedCount: 5 }],
    })),
    getSellerCohortGmvSummary: vi.fn(async () => ({ gmvAmount: "300.00", tradeCount: 2, unitVolume: 2 })),
    getSellerCohortWeeklyGmv: vi.fn(async () => [{ weekStart: "2026-06-29", gmvAmount: "300.00", tradeCount: 2 }]),
    getPlatformGmvSummary: vi.fn(async () => ({ gmvAmount: "6000.00" })),
    resolveStandardScheduleTerms: vi.fn(async () => ({
      accountType: "personal",
      marketplaceSalesFeePercentageBps: 900,
      marketplaceSalesFeeFixedAmount: "0.15",
      scheduleId: "cts_seed_personal_default",
      scheduleLabel: "Personal Default",
      resolvedAt: "2026-07-12T00:00:00.000Z",
    })),
  };
}

describe("offer economics runtime (#4075)", () => {
  it("reports crossContextAvailable and fetches the cohort's seller ids before requesting their GMV", async () => {
    const crossContext = fakeCrossContext();
    const runtime = createOfferEconomicsRuntime({ crossContext });

    expect(runtime.crossContextAvailable).toBe(true);

    const snapshot = await runtime.getOfferEconomicsSnapshot({ from: "2026-07-01", to: "2026-07-12" });

    expect(crossContext.getSellerCohortGmvSummary).toHaveBeenCalledWith({
      sellerAccountIds: ["acc_founder_1"],
      from: "2026-07-01",
      to: "2026-07-12",
    });
    expect(snapshot.listingsCreatedCount).toBe(5);
    expect(snapshot.lockedGmvAmount).toBe("300.00");
    expect(snapshot.lockedGmvShareRatio).toBe("0.0500");
    expect(snapshot.protectionReserve.available).toBe(false);
  });

  it("degrades to an honest zeroed snapshot without throwing when the cross-context port isn't wired", async () => {
    const runtime = createOfferEconomicsRuntime({});

    expect(runtime.crossContextAvailable).toBe(false);

    const snapshot = await runtime.getOfferEconomicsSnapshot({ from: "2026-07-01", to: "2026-07-12" });

    expect(snapshot.listingsCreatedCount).toBe(0);
    expect(snapshot.lockedGmvAmount).toBe("0.00");
    expect(snapshot.lockedGmvShareRatio).toBeNull();
    expect(snapshot.standardScheduleSource).toEqual({ scheduleId: null, scheduleLabel: null });
  });
});
