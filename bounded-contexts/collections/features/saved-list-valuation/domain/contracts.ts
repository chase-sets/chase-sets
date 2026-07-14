import type {
  MarketEstimateBand,
  MarketEstimateConfidence,
  MarketEstimateDisclosure,
} from "@chase-sets/market-estimate-display";
import type { SavedListId, SavedListLineId, SavedListVisibility } from "../../saved-lists/domain";

export const savedListValuationProjectionName = "collections-saved-list-valuation-projection" as const;
export const marketPriceEstimatedEventType = "pricing.market-price.estimated" as const;

export type SavedListMarketEstimate = Readonly<{
  catalogItemId: string;
  productId: string;
  estimateVersion: string;
  windowStartedAt: string;
  windowEndedAt: string;
  amount: string;
  currencyCode: string;
  band: MarketEstimateBand | null;
  confidence: MarketEstimateConfidence;
  estimatedAt: string;
  freshUntil: string;
  disclosure: MarketEstimateDisclosure;
}>;

export type SavedListValuationInputLine = Readonly<{
  lineId: SavedListLineId;
  catalogItemId: string;
  productId: string;
  trackedQuantity: number;
}>;

export type SavedListValuationLineStatus = "priced" | "missing" | "stale";

export type SavedListLineValuation = Readonly<{
  lineId: SavedListLineId;
  catalogItemId: string;
  productId: string;
  trackedQuantity: number;
  status: SavedListValuationLineStatus;
  unitEstimateAmount: string | null;
  estimatedValueAmount: string | null;
  estimatedValueBand: MarketEstimateBand | null;
  currencyCode: string | null;
  confidence: MarketEstimateConfidence | null;
  estimatedAt: string | null;
  freshUntil: string | null;
  estimateVersion: string | null;
}>;

export type SavedListValuationCount = Readonly<{
  lines: number;
  units: number;
}>;

export type SavedListValuationCoverage = Readonly<{
  priced: SavedListValuationCount;
  total: SavedListValuationCount;
  missing: SavedListValuationCount;
  stale: SavedListValuationCount;
  lowConfidence: SavedListValuationCount;
}>;

export type SavedListValuationSummary = Readonly<{
  estimatedTotalAmount: string | null;
  estimatedTotalBand: MarketEstimateBand | null;
  currencyCode: string;
  coverage: SavedListValuationCoverage;
  estimateAsOf: string | null;
  valuedAt: string;
}>;

export type SavedListValuationSnapshot = Readonly<{
  contractVersion: 1;
  listId: SavedListId;
  visibility: SavedListVisibility;
  summary: SavedListValuationSummary;
  lines: readonly SavedListLineValuation[];
}>;

export type SavedListValuationViewerDisclosure = Readonly<{
  showTrackedQuantities: boolean;
}>;

export type SavedListValuationProjectionFanoutObservation = Readonly<{
  productId: string;
  affectedListCount: number;
  strategy: "join-on-read";
}>;
