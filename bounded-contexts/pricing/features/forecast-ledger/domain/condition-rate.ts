const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_DAYS = 364;
const QUARTER_DAYS = 91;
const BUCKET_MS = 7 * DAY_MS;

export const CONDITION_RATE_METHOD = "annual-buckets-v1";

/** One provider week of sales in the curve's own condition, variant, and language. */
export type ConditionSaleBucket = Readonly<{ weekStart: string; transactionCount: number }>;

/**
 * The parity app's condition sale rate (`conditionSaleRate.ts`,
 * tcgplayer-automation-app at bdeffa01): the buyer arrival interval for the
 * listed condition alone, from a year of its weekly sale counts. The rate is
 * the mean of the yearly and quarterly rates, so the latest quarter counts
 * twice. A window counts every week overlapping it, so a week straddling the
 * window's start keeps its sales. Weeks are seven days because provider
 * observations store only weeks with a sale, where the app measured the gap
 * between its first two reported weeks; nothing here limits the window to when
 * the listing became available, which the app's caller never set either.
 */
export function estimateConditionSaleIntervalDays(
  buckets: readonly ConditionSaleBucket[],
  asOf: number,
): number | null {
  const window = (days: number) => {
    const start = asOf - days * DAY_MS;
    const transactions = buckets.reduce((total, bucket) => {
      const startedAt = Date.parse(bucket.weekStart);
      return startedAt + BUCKET_MS > start && startedAt <= asOf ? total + bucket.transactionCount : total;
    }, 0);
    return { transactions, days };
  };
  const year = window(YEAR_DAYS);
  const quarter = window(QUARTER_DAYS);
  if (year.transactions === 0) return null;
  const rate = (year.transactions / year.days + quarter.transactions / quarter.days) / 2;
  return 1 / rate;
}

/** Median wait at a price where the store wins the given share of buyers (the app's `medianSellDays`). */
export function conditionRateMedianSellDays(intervalDays: number | null, storeWinShare: number | null): number | null {
  return isPositive(intervalDays) && isPositive(storeWinShare) ? (Math.LN2 * intervalDays) / storeWinShare : null;
}

function isPositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}
