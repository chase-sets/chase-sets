/**
 * Stat-hygiene policy seam for the daily rollup slice.
 *
 * The tape-integrity slice declares outlier-trimming percentiles,
 * minimum-sample-before-median counts, and 30/90-day lookback windows as
 * pricing-owned m110 policy, explicitly "consumed by the rollup slice" in
 * its own acceptance criteria. That slice has not landed yet, and the m110
 * policy-resolution machinery this context would read them through does not
 * land in pricing until the policy-consolidation slice (deliberately LAST in
 * the market-analytics epic's sequencing).
 *
 * Rather than block on either, these constants use the same default values
 * the tape-integrity slice documents (minimum sample = 3, lookback windows =
 * 30/90 days), hard-coded here as a single, obviously-named seam. Outlier
 * trimming itself is NOT implemented in this slice -- there is no flagged-
 * outlier input to trim yet (that lands with the tape-integrity slice's
 * fraud/self-dealing exclusion wiring); today's rollups only omit `excluded`
 * trades, per the Trades Tape's existing refund/cancel exclusion.
 *
 * When the tape-integrity and policy-consolidation slices land, replace
 * every reference below with the resolved policy value at its one call site
 * in rollup-maintenance.ts / queries.ts -- no other file should hard-code
 * these numbers.
 */
export const ROLLUP_MINIMUM_TRADE_SAMPLE = 3;

export const ROLLUP_CONVENIENCE_LOOKBACK_DAYS = Object.freeze({
  short: 30,
  long: 90,
});

/**
 * Trailing window the daily closer job recomputes on every run (not just
 * "today"), so a late refund/cancellation exclusion on a recently-closed day
 * is reflected without a manual backfill. Recompute-safe by construction:
 * every day in the window is fully re-derived from the Trades Tape, never
 * incrementally patched.
 */
export const ROLLUP_CLOSER_TRAILING_WINDOW_DAYS = 3;
