import type { RepricingPolicyEvaluatedEvent } from "../../repricing-engine/domain/fact";
import type { Forecast } from "./forecast-kinds";

/** Incumbent entries price the listing; shadow entries record a shadow goal version's price and are never emitted. */
export type ForecastLedgerRole = "incumbent" | "shadow";

export type ForecastLedgerEntry = Readonly<{
  entryId: string;
  evaluationId: string;
  sellerAccountId: string;
  catalogItemId: string;
  productId: string;
  listingId: string;
  role: ForecastLedgerRole;
  goalId: string;
  goalVersion: number;
  curveVersion: number | null;
  priceAmount: string;
  quantity: number | null;
  pricedAt: string;
  forecasts: Readonly<Record<string, Forecast>>;
}>;

/**
 * The Forecast Ledger's entries of one evaluation: one per incumbent price
 * read back by a goal, and one per shadow goal version's price, each with the
 * forecasts its evaluation recorded. An incumbent price counts when it was
 * emitted or the listing already stands within tolerance of it, so a listing
 * held at its goal price stays priced in the ledger; a skip that left the
 * listing at another price does not count. An evaluation recorded before its
 * forecasts were fixed keeps its entries with none: they count as pricing and
 * are never graded.
 */
export function pricedLedgerEntries(data: RepricingPolicyEvaluatedEvent["data"]): readonly ForecastLedgerEntry[] {
  const evaluation = {
    evaluationId: data.evaluationId,
    sellerAccountId: data.sellerAccountId,
    catalogItemId: data.catalogItemId,
    productId: data.productId,
    pricedAt: data.evaluatedAt,
  };
  return data.listings.flatMap((trace): ForecastLedgerEntry[] => {
    const listing = { ...evaluation, listingId: trace.listingId, quantity: trace.quantity ?? null };
    const goal = trace.anchor?.goal;
    const priced = trace.outcome === "changed" || trace.skipReason === "within-tolerance";
    const incumbent =
      goal && priced && trace.targetPriceAmount !== null
        ? [
            {
              ...listing,
              entryId: [data.evaluationId, trace.listingId, "incumbent", `${goal.goalId}@${goal.goalVersion}`].join(
                ":",
              ),
              role: "incumbent" as const,
              goalId: goal.goalId,
              goalVersion: goal.goalVersion,
              curveVersion: goal.curveVersion,
              priceAmount: trace.targetPriceAmount,
              forecasts: trace.forecasts ?? {},
            },
          ]
        : [];
    const shadows = (trace.shadow ?? []).flatMap((shadow): ForecastLedgerEntry[] =>
      shadow.skipped === null && shadow.targetPriceAmount !== null
        ? [
            {
              ...listing,
              entryId: [
                data.evaluationId,
                trace.listingId,
                "shadow",
                `${shadow.goalId}@${shadow.goalVersion}`,
                shadow.anchorIndex,
              ].join(":"),
              role: "shadow",
              goalId: shadow.goalId,
              goalVersion: shadow.goalVersion,
              curveVersion: shadow.curveVersion,
              priceAmount: shadow.targetPriceAmount,
              forecasts: shadow.forecasts ?? {},
            },
          ]
        : [],
    );
    return [...incumbent, ...shadows];
  });
}
