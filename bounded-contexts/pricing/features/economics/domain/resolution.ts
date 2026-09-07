import type {
  Economics,
  EconomicsFact,
  ResolveEconomicsRequest,
  ResolvedChannelConnection,
  SignedMoney,
} from "./contracts";
import type { AcquisitionLotObservation, SaleObservation } from "./observations";
import type { CostBasisFacts, CycleFacts, InventoryCostLot } from "./derivation";

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
  channel: ResolvedChannelConnection;
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

export type EconomicsForPricingGoal = Readonly<{
  availability: "resolved" | "unavailable";
  reason: UnavailableEconomics["reason"] | null;
  currency: string;
  effectiveAt: string;
  dailyReturnHurdle: EconomicsFact<number>;
}>;

/** Pure #7706-facing adapter: it copies already-resolved facts and never
 * derives fees, costs, or hurdles in the goal engine. */
export function toEconomicsForPricingGoal(resolution: EconomicsResolution): EconomicsForPricingGoal {
  return resolution.kind === "resolved"
    ? {
        availability: "resolved",
        reason: null,
        currency: resolution.economics.currency,
        effectiveAt: resolution.economics.effectiveAt,
        dailyReturnHurdle: resolution.economics.facts.dailyReturnHurdle,
      }
    : {
        availability: "unavailable",
        reason: resolution.reason,
        currency: resolution.currency,
        effectiveAt: resolution.effectiveAt,
        dailyReturnHurdle: resolution.facts.dailyReturnHurdle,
      };
}
