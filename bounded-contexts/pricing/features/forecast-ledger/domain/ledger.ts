import type { GoalForecast } from "../../repricing-policies/domain/goals/curve-math";
import type { RepricingGoalTrace } from "../../repricing-engine/domain/evaluate";
import type { RepricingPolicyEvaluatedEvent } from "../../repricing-engine/domain/fact";
import { forecastEntry, type Forecast, type ForecastCurve, type ForecastKindDefinition } from "./forecast-kinds";

/** Incumbent entries price the listing; shadow entries record a shadow goal version's price and are never emitted. */
export type ForecastLedgerRole = "incumbent" | "shadow";

/** One priced entry of an evaluation, before its forecasts are taken. */
export type PricedLedgerEntry = Readonly<{
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
  goalForecast: GoalForecast | null;
}>;

export type ForecastLedgerEntry = Omit<PricedLedgerEntry, "goalForecast"> &
  Readonly<{ forecasts: Readonly<Record<string, Forecast>> }>;

/**
 * The Forecast Ledger's entries of one evaluation: one per incumbent price
 * read back by a goal, and one per shadow goal version's price. An incumbent
 * price counts when it was emitted or the listing already stands within
 * tolerance of it, so a listing held at its goal price stays priced in the
 * ledger; a skip that left the listing at another price does not count.
 */
export function pricedLedgerEntries(data: RepricingPolicyEvaluatedEvent["data"]): readonly PricedLedgerEntry[] {
  const evaluation = {
    evaluationId: data.evaluationId,
    sellerAccountId: data.sellerAccountId,
    catalogItemId: data.catalogItemId,
    productId: data.productId,
    pricedAt: data.evaluatedAt,
  };
  return data.listings.flatMap((trace): PricedLedgerEntry[] => {
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
              goalForecast: goalForecast(goal),
            },
          ]
        : [];
    const shadows = (trace.shadow ?? []).flatMap((shadow): PricedLedgerEntry[] =>
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
              goalForecast: shadow.anchor?.goal ? goalForecast(shadow.anchor.goal) : null,
            },
          ]
        : [],
    );
    return [...incumbent, ...shadows];
  });
}

/** Takes every registered forecast of each entry once, from the Demand Curve version the entry names. */
export function toForecastLedgerEntries(
  entries: readonly PricedLedgerEntry[],
  curveFor: (curveVersion: number) => ForecastCurve | null,
  kinds: readonly ForecastKindDefinition[],
): readonly ForecastLedgerEntry[] {
  return entries.map(({ goalForecast, ...entry }) => ({
    ...entry,
    forecasts: forecastEntry(kinds, {
      priceAmount: entry.priceAmount,
      pricedAt: entry.pricedAt,
      goalForecast,
      curve: entry.curveVersion === null ? null : curveFor(entry.curveVersion),
    }),
  }));
}

function goalForecast(goal: RepricingGoalTrace): GoalForecast {
  return { medianSellDays: goal.forecastMedianSellDays, status: goal.forecastStatus };
}
