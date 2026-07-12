import { describe, expect, it } from "vitest";
import { computeOfferEconomicsSnapshot, PROTECTION_RESERVE_PENDING_REASON } from "./offer-economics-policy";

describe("offer economics snapshot computation (#4075)", () => {
  it("computes GMV share, foregone-fee estimate (percentage + per-trade fixed), and cumulative sell-through", () => {
    const snapshot = computeOfferEconomicsSnapshot({
      from: "2026-07-01",
      to: "2026-07-14",
      lockedCohort: {
        listingsCreatedCount: 10,
        lockedSellerAccountIds: ["acc_founder_1", "acc_founder_2"],
        weeklyListingsCreated: [
          { weekStart: "2026-06-29", listingsCreatedCount: 6 },
          { weekStart: "2026-07-06", listingsCreatedCount: 4 },
        ],
      },
      lockedGmv: { gmvAmount: "1000.00", tradeCount: 4, unitVolume: 4 },
      lockedWeeklyGmv: [
        { weekStart: "2026-06-29", gmvAmount: "600.00", tradeCount: 3 },
        { weekStart: "2026-07-06", gmvAmount: "400.00", tradeCount: 1 },
      ],
      platformGmvAmount: "20000.00",
      standardSchedule: {
        accountType: "personal",
        marketplaceSalesFeePercentageBps: 900,
        marketplaceSalesFeeFixedAmount: "0.15",
        scheduleId: "cts_seed_personal_default",
        scheduleLabel: "Personal Default",
        resolvedAt: "2026-07-14T00:00:00.000Z",
      },
    });

    expect(snapshot.listingsCreatedCount).toBe(10);
    expect(snapshot.lockedSellerAccountCount).toBe(2);
    expect(snapshot.lockedGmvAmount).toBe("1000.00");
    // 1000 * 900bps = 90.00, plus 0.15 * 4 trades = 0.60 => 90.60
    expect(snapshot.foregoneFeeEstimateAmount).toBe("90.60");
    // 1000 / 20000 = 0.05
    expect(snapshot.lockedGmvShareRatio).toBe("0.0500");

    expect(snapshot.weeklySellThrough).toEqual([
      {
        weekStart: "2026-06-29",
        listingsCreatedCount: 6,
        cumulativeListingsCreatedCount: 6,
        tradeCount: 3,
        cumulativeTradeCount: 3,
        sellThroughRate: "0.5000",
      },
      {
        weekStart: "2026-07-06",
        listingsCreatedCount: 4,
        cumulativeListingsCreatedCount: 10,
        tradeCount: 1,
        cumulativeTradeCount: 4,
        sellThroughRate: "0.4000",
      },
    ]);
    // Sell-through decayed from 50% to 40% cumulative as more listings piled up than sold that second week.
    expect(Number(snapshot.weeklySellThrough[1]!.sellThroughRate)).toBeLessThan(
      Number(snapshot.weeklySellThrough[0]!.sellThroughRate),
    );
  });

  it("never fabricates protection-reserve data (#4098 pending)", () => {
    const snapshot = computeOfferEconomicsSnapshot({
      from: "2026-07-01",
      to: "2026-07-14",
      lockedCohort: { listingsCreatedCount: 0, lockedSellerAccountIds: [], weeklyListingsCreated: [] },
      lockedGmv: { gmvAmount: "0.00", tradeCount: 0, unitVolume: 0 },
      lockedWeeklyGmv: [],
      platformGmvAmount: "0.00",
      standardSchedule: {
        accountType: "personal",
        marketplaceSalesFeePercentageBps: 900,
        marketplaceSalesFeeFixedAmount: "0.15",
        scheduleId: "cts_seed_personal_default",
        scheduleLabel: "Personal Default",
        resolvedAt: "2026-07-14T00:00:00.000Z",
      },
    });

    expect(snapshot.protectionReserve).toEqual({ available: false, reason: PROTECTION_RESERVE_PENDING_REASON });
  });

  it("degrades to a null GMV share and an empty sell-through series with no locked cohort or platform activity", () => {
    const snapshot = computeOfferEconomicsSnapshot({
      from: "2026-07-01",
      to: "2026-07-14",
      lockedCohort: { listingsCreatedCount: 0, lockedSellerAccountIds: [], weeklyListingsCreated: [] },
      lockedGmv: { gmvAmount: "0.00", tradeCount: 0, unitVolume: 0 },
      lockedWeeklyGmv: [],
      platformGmvAmount: "0.00",
      standardSchedule: {
        accountType: "personal",
        marketplaceSalesFeePercentageBps: 0,
        marketplaceSalesFeeFixedAmount: "0.00",
        scheduleId: null,
        scheduleLabel: null,
        resolvedAt: "2026-07-14T00:00:00.000Z",
      },
    });

    expect(snapshot.lockedGmvShareRatio).toBeNull();
    expect(snapshot.weeklySellThrough).toEqual([]);
    expect(snapshot.foregoneFeeEstimateAmount).toBe("0.00");
  });
});
