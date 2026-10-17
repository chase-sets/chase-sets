import type { Economics, EconomicsFact, EconomicsScope, ResolveEconomicsRequest, SignedMoney } from "./contracts";
import type { AcquisitionLotObservation, SaleObservation } from "./observations";
import type { CostBasisFacts, CycleFacts, InventoryCostLot } from "./derivation";
import type { SellerOverheadTerms } from "./overhead";

export type EconomicsEvidenceSnapshot = Readonly<{
  acquisitions: readonly AcquisitionLotObservation[];
  sales: readonly SaleObservation[];
  costLots: readonly InventoryCostLot[];
  inventoryWatermark: string;
  pricingWatermark: string;
  inventoryObservedAt: string;
  pricingObservedAt: string;
}>;

export interface EconomicsEvidenceReader {
  resolve(request: ResolveEconomicsRequest): Promise<EconomicsEvidenceSnapshot>;
}

/** A safe unavailable result deliberately omits platform fee values. The
 * consumer still receives the numeric cost/history/hurdle facts required to
 * make a stable hold decision, but no missing fee is invented as zero (or any
 * other business value). */
export type UnavailableEconomics = Readonly<{
  kind: "unavailable";
  reason: "provider-unavailable" | "terms-unavailable";
  accountId: string;
  channel: EconomicsScope;
  currency: string;
  effectiveAt: string;
  revision: string;
  facts: Readonly<{
    costBasisShareOfMarketBps: CostBasisFacts["share"];
    costBasisCoverageBps: CostBasisFacts["coverage"];
    costBasisDiscountPerUnitAmount: EconomicsFact<SignedMoney>;
    turnaroundDays: CycleFacts["turnaround"];
    dailyReturnHurdle: CycleFacts["dailyReturnHurdle"];
  }>;
  diagnostics: CycleFacts["diagnostics"] &
    Readonly<{
      inventoryWatermark: string;
      pricingWatermark: string;
      generatedAt: string;
      inventoryObservedAt: string;
      pricingObservedAt: string;
      generatedAgeSeconds: number;
      inventorySourceAgeSeconds: number;
      pricingSourceAgeSeconds: number;
    }>;
}>;

export type EconomicsResolution = Readonly<{ kind: "resolved"; economics: Economics }> | UnavailableEconomics;

export type EconomicsResolver = Readonly<{
  resolve(request: ResolveEconomicsRequest): Promise<EconomicsResolution>;
}>;

/** Only resolved Economics carries the six effective overhead terms; an
 * unavailable result has no fee value to copy. */
export type EconomicsForPricingGoal =
  | (Readonly<{
      availability: "resolved";
      reason: null;
      currency: string;
      effectiveAt: string;
      dailyReturnHurdle: EconomicsFact<number>;
    }> &
      SellerOverheadTerms)
  | Readonly<{
      availability: "unavailable";
      reason: UnavailableEconomics["reason"];
      currency: string;
      effectiveAt: string;
      dailyReturnHurdle: EconomicsFact<number>;
    }>;

/** Pure goal-facing adapter: it copies already-resolved facts and never
 * derives fees, costs, or hurdles in the goal engine. */
export function toEconomicsForPricingGoal(resolution: EconomicsResolution): EconomicsForPricingGoal {
  if (resolution.kind === "resolved") {
    const { facts } = resolution.economics;
    return {
      availability: "resolved",
      reason: null,
      currency: resolution.economics.currency,
      effectiveAt: resolution.economics.effectiveAt,
      dailyReturnHurdle: facts.dailyReturnHurdle,
      platformFeeRelativeBps: facts.platformFeeRelativeBps.effectiveValue,
      platformFeeFixedPerUnitAmount: facts.platformFeeFixedPerUnitAmount.effectiveValue,
      platformFeeCapPerUnitAmount: facts.platformFeeCapPerUnitAmount.effectiveValue,
      sellerHandlingRelativeBps: facts.sellerHandlingRelativeBps.effectiveValue,
      sellerHandlingFixedPerUnitAmount: facts.sellerHandlingFixedPerUnitAmount.effectiveValue,
      sellerHandlingCapPerUnitAmount: facts.sellerHandlingCapPerUnitAmount.effectiveValue,
    };
  }
  return {
    availability: "unavailable",
    reason: resolution.reason,
    currency: resolution.currency,
    effectiveAt: resolution.effectiveAt,
    dailyReturnHurdle: resolution.facts.dailyReturnHurdle,
  };
}
