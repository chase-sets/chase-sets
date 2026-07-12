import { computeOfferEconomicsSnapshot, type OfferEconomicsSnapshot } from "../read-model/offer-economics-policy";
import type { OfferEconomicsCrossContextPort } from "./offer-economics-contracts";

export type OfferEconomicsRuntimeDeps = Readonly<{
  crossContext?: OfferEconomicsCrossContextPort;
}>;

export type OfferEconomicsServices = Readonly<{
  /** True when the marketplace/pricing/commercial-terms `offerEconomicsCrossContext` host port is wired (always in `platform-api`; may be absent in isolated/unit test composition). */
  crossContextAvailable: boolean;
  getOfferEconomicsSnapshot: (
    params: Readonly<{ from: string; to: string; accountType?: string }>,
  ) => Promise<OfferEconomicsSnapshot>;
}>;

/**
 * The offer-economics monitor's live-computed summary: unlike the
 * ops dashboard's GMV Reconciliation Run, there is no persisted snapshot
 * table here -- every field is recomputed on request directly from
 * Marketplace's locked-fee-listing cohort, Pricing's Trades Tape, and
 * Commercial Terms' published standard schedule, the same "no mirror,
 * compute live from the one-truth source" shape the ops dashboard's own
 * GMV/liquidity/top-catalog-item panels already use. When the cross-context
 * port isn't wired (isolated composition, e.g. a context-local test
 * harness), the snapshot degrades to an honest all-zero/no-schedule result
 * rather than throwing -- an admin dashboard reachable in every deploy
 * profile is more useful than one that 500s outside `platform-api`.
 */
export function createOfferEconomicsRuntime(deps: OfferEconomicsRuntimeDeps): OfferEconomicsServices {
  return {
    crossContextAvailable: Boolean(deps.crossContext),
    async getOfferEconomicsSnapshot(params) {
      const crossContext = deps.crossContext;
      if (!crossContext) {
        return computeOfferEconomicsSnapshot({
          from: params.from,
          to: params.to,
          lockedCohort: { listingsCreatedCount: 0, lockedSellerAccountIds: [], weeklyListingsCreated: [] },
          lockedGmv: { gmvAmount: "0.00", tradeCount: 0, unitVolume: 0 },
          lockedWeeklyGmv: [],
          platformGmvAmount: "0.00",
          standardSchedule: {
            accountType: params.accountType ?? "personal",
            marketplaceSalesFeePercentageBps: 0,
            marketplaceSalesFeeFixedAmount: "0.00",
            scheduleId: null,
            scheduleLabel: null,
            resolvedAt: new Date().toISOString(),
          },
        });
      }

      const lockedCohort = await crossContext.getLockedFeeListingCohortSummary({ from: params.from, to: params.to });
      const [lockedGmv, lockedWeeklyGmv, platformGmv, standardSchedule] = await Promise.all([
        crossContext.getSellerCohortGmvSummary({
          sellerAccountIds: lockedCohort.lockedSellerAccountIds,
          from: params.from,
          to: params.to,
        }),
        crossContext.getSellerCohortWeeklyGmv({
          sellerAccountIds: lockedCohort.lockedSellerAccountIds,
          from: params.from,
          to: params.to,
        }),
        crossContext.getPlatformGmvSummary({ from: params.from, to: params.to }),
        crossContext.resolveStandardScheduleTerms({ accountType: params.accountType }),
      ]);

      return computeOfferEconomicsSnapshot({
        from: params.from,
        to: params.to,
        lockedCohort,
        lockedGmv,
        lockedWeeklyGmv,
        platformGmvAmount: platformGmv.gmvAmount,
        standardSchedule,
      });
    },
  };
}
