export interface MarketplaceCallerSource {
  path: string;
  source: string;
}
export interface MarketplaceAttemptCaller {
  path: string;
  method: string;
  line: number;
  call: string;
}
export const marketplaceAttemptInventoryIgnoreRules: readonly string[];
export const marketplaceOfferCallerPartition: Map<string, string>;
export function readTrackedMarketplaceCallerSources(root: string, pattern?: string): MarketplaceCallerSource[];
export const listingCallerPattern: string;
export const marketplaceListingCallerPartition: Map<string, string | RegExp>;
export function enumerateListingAttemptCallers(sources: readonly MarketplaceCallerSource[]): MarketplaceAttemptCaller[];
export function unpartitionedListingCallers(callers: readonly MarketplaceAttemptCaller[]): MarketplaceAttemptCaller[];
export function enumerateMarketplaceAttemptCallers(
  sources: readonly MarketplaceCallerSource[],
): MarketplaceAttemptCaller[];
export function unpartitionedMarketplaceOfferCallers(
  callers: readonly MarketplaceAttemptCaller[],
): MarketplaceAttemptCaller[];
