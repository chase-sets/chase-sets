import { readFileSync } from "node:fs";
import type { ForecastHistoryEntry, RealizedOutcomes } from "../../domain/cohort";
import type { ForecastGrade } from "../../domain/grading";

const DAY_MS = 24 * 60 * 60 * 1000;

type AppRecord = Readonly<{ sku: number; day: number; quantity: number; forecasts: Readonly<Record<string, number>> }>;
type AppGrade = Omit<ForecastGrade, "baseRateBrier">;

export type ForecastGradingOracle = Readonly<{
  sourceCommit: string;
  sourceBlobs: Readonly<Record<string, string>>;
  cohort: Readonly<{
    records: readonly AppRecord[];
    inStockSkus: readonly number[];
    forecastNames: readonly string[];
    cohorts: readonly Readonly<{
      horizonDays: number;
      members: readonly Readonly<{ sku: number; sold: boolean }>[];
      grades: Readonly<Record<string, AppGrade>>;
    }>[];
  }>;
  buyerChoice: readonly Readonly<{
    curve: readonly Readonly<{
      percentile: number;
      buyerArrivalIntervalDays: number | null;
      competingSellerCount: number | null;
    }>[];
    forecasts: readonly Readonly<{
      price: number;
      forecast: Readonly<{ medianSellDays: number; calibration: string }> | null;
    }>[];
  }>[];
  conditionRate: readonly Readonly<{
    asOf: string;
    buckets: readonly Readonly<{ weekStart: string; transactionCount: number }>[];
    intervalDays: number | null;
    forecasts: readonly Readonly<{ storeWinShare: number; medianSellDays: number | null }>[];
  }>[];
}>;

export const oracle = JSON.parse(
  readFileSync(new URL("./app-recorded-forecast-grading-oracle.json", import.meta.url), "utf8"),
) as ForecastGradingOracle;

export const listingIdForSku = (sku: number) => `lst_sku_${sku}`;

/**
 * The app's records as Forecast Ledger history and realized outcomes. The app
 * read a sale as a quantity drop between two pricings; each such drop is the
 * realized sale it stood for, at the pricing that observed it.
 */
export function appRecordsAsLedger(): Readonly<{ entries: ForecastHistoryEntry[]; outcomes: RealizedOutcomes }> {
  const entries = oracle.cohort.records.map((record) => ({
    listingId: listingIdForSku(record.sku),
    pricedAt: record.day * DAY_MS,
    quantity: record.quantity,
    forecasts: record.forecasts,
  }));
  const saleTimesByListing = new Map<string, number[]>();
  const previous = new Map<string, ForecastHistoryEntry>();
  for (const entry of [...entries].sort((left, right) => left.pricedAt - right.pricedAt)) {
    const before = previous.get(entry.listingId);
    if (before && entry.quantity! < before.quantity!) {
      saleTimesByListing.set(entry.listingId, [...(saleTimesByListing.get(entry.listingId) ?? []), entry.pricedAt]);
    }
    previous.set(entry.listingId, entry);
  }
  return {
    entries,
    outcomes: { saleTimesByListing, inStockListingIds: new Set(oracle.cohort.inStockSkus.map(listingIdForSku)) },
  };
}
