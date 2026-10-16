const DAY_MS = 24 * 60 * 60 * 1000;

/** One priced entry of a listing's history, with median sell days by forecast name. */
export type ForecastHistoryEntry = Readonly<{
  listingId: string;
  pricedAt: number;
  /** Null when the evaluation predates quantity tracing; such an entry is not graded. */
  quantity: number | null;
  forecasts: Readonly<Record<string, number>>;
}>;

/** What happened after pricing, read only from realized sale facts and current stock. */
export type RealizedOutcomes = Readonly<{
  saleTimesByListing: ReadonlyMap<string, readonly number[]>;
  inStockListingIds: ReadonlySet<string>;
}>;

export type ForecastCohortMember = Readonly<{
  listingId: string;
  sold: boolean;
  forecasts: Readonly<Record<string, number>>;
}>;

/**
 * The parity app's `buildCohort` (`forecastGrading.ts`, tcgplayer-automation-app
 * at bdeffa01). A listing joins the Forecast Cohort at its first entry in
 * stock that carries every forecast under test, and is followed for a fixed
 * horizon. It sold if a sale was realized after it joined and within the
 * horizon, or if it stopped being priced before the horizon ran out and is out
 * of stock now. A listing that stopped being priced but is still in stock left
 * for another reason and is censored out. The grace covers the gap between one
 * pricing and the next. The app read a sale as a quantity drop between two
 * pricings; here only a realized sale counts, so a restock or a seller's own
 * quantity edit is never a sale and never moves the joining entry.
 */
export function buildForecastCohort(
  entries: readonly ForecastHistoryEntry[],
  forecastNames: readonly string[],
  outcomes: RealizedOutcomes,
  rules: Readonly<{ horizonDays: number; graceDays: number }>,
): ForecastCohortMember[] {
  const byListing = new Map<string, ForecastHistoryEntry[]>();
  const known = entries.filter((entry) => entry.quantity !== null);
  for (const entry of known) {
    byListing.set(entry.listingId, [...(byListing.get(entry.listingId) ?? []), entry]);
  }
  const end = known.reduce((latest, entry) => Math.max(latest, entry.pricedAt), Number.NEGATIVE_INFINITY);
  const horizonMs = rules.horizonDays * DAY_MS;
  const graceMs = rules.graceDays * DAY_MS;
  const members: ForecastCohortMember[] = [];
  for (const [listingId, history] of byListing) {
    history.sort((left, right) => left.pricedAt - right.pricedAt);
    const start = history.find(
      (entry) => entry.quantity! > 0 && forecastNames.every((name) => (entry.forecasts[name] ?? 0) > 0),
    );
    if (!start || end - start.pricedAt < horizonMs) continue;
    const sold = (outcomes.saleTimesByListing.get(listingId) ?? []).some(
      (soldAt) => soldAt > start.pricedAt && soldAt - start.pricedAt <= horizonMs,
    );
    const leftEarly = history.at(-1)!.pricedAt - start.pricedAt < horizonMs - graceMs;
    if (!sold && leftEarly && outcomes.inStockListingIds.has(listingId)) continue;
    members.push({ listingId, sold: sold || leftEarly, forecasts: start.forecasts });
  }
  return members;
}
