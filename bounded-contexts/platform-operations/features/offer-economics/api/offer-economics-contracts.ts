/**
 * Cross-context read shapes for the offer-economics monitor: the
 * founders 0%-locked-fee cohort's listing volume (Marketplace), realized
 * GMV (Pricing), and the published standard fee schedule the foregone-fee
 * estimate is measured against (Commercial Terms). Structurally mirrors
 * every other cross-context port in this bounded context -- these types are
 * declared here rather than imported from the source contexts' packages
 * (see `allowedContextDependencies: []` in context.json); the
 * `offerEconomicsCrossContext` host port is assembled in the platform-api
 * composition root, which DOES import marketplace, pricing, and
 * commercial-terms directly and hands platform-operations only these
 * function-shaped ports.
 */

export type OfferEconomicsLockedFeeCohortSummary = Readonly<{
  listingsCreatedCount: number;
  lockedSellerAccountIds: readonly string[];
  weeklyListingsCreated: readonly Readonly<{ weekStart: string; listingsCreatedCount: number }>[];
}>;

export type OfferEconomicsSellerCohortGmvSummary = Readonly<{
  gmvAmount: string;
  tradeCount: number;
  unitVolume: number;
}>;

export type OfferEconomicsSellerCohortWeeklyGmvPoint = Readonly<{
  weekStart: string;
  gmvAmount: string;
  tradeCount: number;
}>;

export type OfferEconomicsPlatformGmvSummary = Readonly<{ gmvAmount: string }>;

export type OfferEconomicsProtectionReserveSummary = Readonly<{
  contributionAmount: string;
  allowanceAmount: string;
  overageAmount: string;
  reversalAmount: string;
  coveredOrderCount: number;
}>;

export type OfferEconomicsStandardScheduleTerms = Readonly<{
  accountType: string;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  scheduleId: string | null;
  scheduleLabel: string | null;
  resolvedAt: string;
}>;

export type OfferEconomicsCrossContextPort = Readonly<{
  getLockedFeeListingCohortSummary: (
    params: Readonly<{ from: string; to: string }>,
  ) => Promise<OfferEconomicsLockedFeeCohortSummary>;
  getSellerCohortGmvSummary: (
    params: Readonly<{ sellerAccountIds: readonly string[]; from: string; to: string }>,
  ) => Promise<OfferEconomicsSellerCohortGmvSummary>;
  getSellerCohortWeeklyGmv: (
    params: Readonly<{ sellerAccountIds: readonly string[]; from: string; to: string }>,
  ) => Promise<readonly OfferEconomicsSellerCohortWeeklyGmvPoint[]>;
  getPlatformGmvSummary: (params: Readonly<{ from: string; to: string }>) => Promise<OfferEconomicsPlatformGmvSummary>;
  getProtectionReserveSummary: (
    params: Readonly<{ from: string; to: string }>,
  ) => Promise<OfferEconomicsProtectionReserveSummary>;
  resolveStandardScheduleTerms: (
    params?: Readonly<{ accountType?: string; effectiveAt?: string }>,
  ) => Promise<OfferEconomicsStandardScheduleTerms>;
}>;
