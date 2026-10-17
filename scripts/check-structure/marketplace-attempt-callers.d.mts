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
export function readTrackedMarketplaceCallerSources(root: string): MarketplaceCallerSource[];
export function enumerateMarketplaceAttemptCallers(
  sources: readonly MarketplaceCallerSource[],
): MarketplaceAttemptCaller[];
export function unpartitionedMarketplaceOfferCallers(
  callers: readonly MarketplaceAttemptCaller[],
): MarketplaceAttemptCaller[];
