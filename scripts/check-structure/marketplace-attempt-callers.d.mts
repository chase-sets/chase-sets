export interface MarketplaceCallerSource {
  path: string;
  source: string;
}
export interface MarketplaceAttemptCaller {
  path: string;
  method: string;
  line: number;
  call: string;
  identityEvidence?: string;
}
export const marketplaceAttemptInventoryIgnoreRules: readonly string[];
export const marketplaceOfferCallerPartition: Map<string, string>;
export function readTrackedMarketplaceCallerSources(root: string): MarketplaceCallerSource[];
export function enumerateMarketplaceAttemptCallers(
  sources: readonly MarketplaceCallerSource[],
): MarketplaceAttemptCaller[];
export function enumerateListingAttemptCallers(sources: readonly MarketplaceCallerSource[]): MarketplaceAttemptCaller[];
export const marketplaceListingCallerPartition: Map<string, string>;
export function enumerateReviewReportAttemptCallers(sources: readonly MarketplaceCallerSource[]): MarketplaceAttemptCaller[];
export const marketplaceReviewReportCallerPartition: Map<string, string>;
export function unpartitionedReviewReportAttemptCallers(callers: readonly MarketplaceAttemptCaller[]): MarketplaceAttemptCaller[];
export function unpartitionedListingAttemptCallers(
  callers: readonly MarketplaceAttemptCaller[],
): MarketplaceAttemptCaller[];
export function unpartitionedMarketplaceOfferCallers(
  callers: readonly MarketplaceAttemptCaller[],
): MarketplaceAttemptCaller[];
