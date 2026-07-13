import type {
  OfferEconomicsLockedFeeCohortSummary,
  OfferEconomicsProtectionReserveSummary,
  OfferEconomicsSellerCohortGmvSummary,
  OfferEconomicsSellerCohortWeeklyGmvPoint,
  OfferEconomicsStandardScheduleTerms,
} from "../api/offer-economics-contracts";

/**
 * Offer economics monitor. Pure computation: no I/O, so the
 * founders 0%-locked-cohort math (GMV share, foregone-fee estimate,
 * week-over-week sell-through) is exercised directly against fixture
 * inputs, the same convention as `reconciliation-policy.ts`'s drift
 * computation.
 *
 * Settlement supplies replay-safe protection-reserve contribution and
 * reversal totals through the platform-api host port. Isolated compositions
 * stay explicitly unavailable instead of fabricating a zero reserve.
 */

export type OfferEconomicsWeeklySellThroughPoint = Readonly<{
  weekStart: string;
  listingsCreatedCount: number;
  cumulativeListingsCreatedCount: number;
  tradeCount: number;
  cumulativeTradeCount: number;
  /** cumulativeTradeCount / cumulativeListingsCreatedCount, null before any listing exists in the window. */
  sellThroughRate: string | null;
}>;

export type OfferEconomicsProtectionReserveStatus =
  | Readonly<{ available: false; reason: string }>
  | (Readonly<{ available: true }> & OfferEconomicsProtectionReserveSummary);

export type OfferEconomicsSnapshot = Readonly<{
  from: string;
  to: string;
  listingsCreatedCount: number;
  lockedSellerAccountCount: number;
  lockedGmvAmount: string;
  lockedTradeCount: number;
  platformGmvAmount: string;
  /** lockedGmvAmount / platformGmvAmount, null when platform GMV is zero (nothing to divide by). */
  lockedGmvShareRatio: string | null;
  standardFeePercentageBps: number;
  standardFeeFixedAmount: string;
  standardScheduleSource: Readonly<{ scheduleId: string | null; scheduleLabel: string | null }>;
  /**
   * percentageBps applied to lockedGmvAmount, plus fixedAmount applied ONCE
   * PER LOCKED TRADE (not once to the aggregate GMV) -- the standard
   * schedule's fixed component is a per-line-item fee, so aggregating it
   * across many trades without multiplying by trade count would
   * understate foregone revenue on a cohort with many small sales.
   */
  foregoneFeeEstimateAmount: string;
  weeklySellThrough: readonly OfferEconomicsWeeklySellThroughPoint[];
  protectionReserve: OfferEconomicsProtectionReserveStatus;
}>;

export const PROTECTION_RESERVE_PENDING_REASON =
  "Settlement protection-reserve contribution data is unavailable in this runtime profile.";

export type OfferEconomicsSnapshotInputs = Readonly<{
  from: string;
  to: string;
  lockedCohort: OfferEconomicsLockedFeeCohortSummary;
  lockedGmv: OfferEconomicsSellerCohortGmvSummary;
  lockedWeeklyGmv: readonly OfferEconomicsSellerCohortWeeklyGmvPoint[];
  platformGmvAmount: string;
  standardSchedule: OfferEconomicsStandardScheduleTerms;
  protectionReserve?: OfferEconomicsProtectionReserveSummary;
}>;

function computeWeeklySellThrough(
  weeklyListingsCreated: OfferEconomicsLockedFeeCohortSummary["weeklyListingsCreated"],
  weeklyGmv: readonly OfferEconomicsSellerCohortWeeklyGmvPoint[],
): readonly OfferEconomicsWeeklySellThroughPoint[] {
  const weekStarts = Array.from(
    new Set([...weeklyListingsCreated.map((point) => point.weekStart), ...weeklyGmv.map((point) => point.weekStart)]),
  ).sort();

  let cumulativeListingsCreatedCount = 0;
  let cumulativeTradeCount = 0;

  return weekStarts.map((weekStart) => {
    const listingsCreatedCount =
      weeklyListingsCreated.find((point) => point.weekStart === weekStart)?.listingsCreatedCount ?? 0;
    const tradeCount = weeklyGmv.find((point) => point.weekStart === weekStart)?.tradeCount ?? 0;
    cumulativeListingsCreatedCount += listingsCreatedCount;
    cumulativeTradeCount += tradeCount;

    return {
      weekStart,
      listingsCreatedCount,
      cumulativeListingsCreatedCount,
      tradeCount,
      cumulativeTradeCount,
      sellThroughRate:
        cumulativeListingsCreatedCount > 0 ? (cumulativeTradeCount / cumulativeListingsCreatedCount).toFixed(4) : null,
    };
  });
}

export function computeOfferEconomicsSnapshot(inputs: OfferEconomicsSnapshotInputs): OfferEconomicsSnapshot {
  const lockedGmvAmount = Number(inputs.lockedGmv.gmvAmount);
  const platformGmvAmount = Number(inputs.platformGmvAmount);
  const lockedGmvShareRatio = platformGmvAmount > 0 ? (lockedGmvAmount / platformGmvAmount).toFixed(4) : null;

  const percentageFeeAmount = (lockedGmvAmount * inputs.standardSchedule.marketplaceSalesFeePercentageBps) / 10000;
  const fixedFeeAmount = Number(inputs.standardSchedule.marketplaceSalesFeeFixedAmount) * inputs.lockedGmv.tradeCount;
  const foregoneFeeEstimateAmount = (percentageFeeAmount + fixedFeeAmount).toFixed(2);

  return {
    from: inputs.from,
    to: inputs.to,
    listingsCreatedCount: inputs.lockedCohort.listingsCreatedCount,
    lockedSellerAccountCount: inputs.lockedCohort.lockedSellerAccountIds.length,
    lockedGmvAmount: inputs.lockedGmv.gmvAmount,
    lockedTradeCount: inputs.lockedGmv.tradeCount,
    platformGmvAmount: inputs.platformGmvAmount,
    lockedGmvShareRatio,
    standardFeePercentageBps: inputs.standardSchedule.marketplaceSalesFeePercentageBps,
    standardFeeFixedAmount: inputs.standardSchedule.marketplaceSalesFeeFixedAmount,
    standardScheduleSource: {
      scheduleId: inputs.standardSchedule.scheduleId,
      scheduleLabel: inputs.standardSchedule.scheduleLabel,
    },
    foregoneFeeEstimateAmount,
    weeklySellThrough: computeWeeklySellThrough(inputs.lockedCohort.weeklyListingsCreated, inputs.lockedWeeklyGmv),
    protectionReserve: inputs.protectionReserve
      ? { available: true, ...inputs.protectionReserve }
      : { available: false, reason: PROTECTION_RESERVE_PENDING_REASON },
  };
}
