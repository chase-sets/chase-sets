import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

/**
 * The market-rollups query API's presentation dials: the runtime-
 * configurable choices that shape how the already-computed, already-gated
 * (see `../../market-trades/domain/stat-hygiene-policy.ts`) rollup data is
 * SURFACED, as distinct from the stat-hygiene policy's dials that shape how
 * it is COMPUTED. Declared on the m110 platform-policy machinery with
 * compiled fallbacks identical to this milestone's launch behavior.
 *
 * Consumed at:
 *  - the item-detail market panel's verified-sale chart markers (Discovery,
 *    via the market-rollups query API's stats response -- see
 *    `../api/runtime.ts`'s `getProductMarketStatsSnapshot` composition and
 *    `discovery/features/item-detail/ui/item-detail-market-panel.tsx`).
 *  - the public market page's charted history window and the public
 *    market-pages JSON API's Cache-Control TTL (`../../public-market-pages`).
 *
 * SCOPE NOTE: the item-detail panel and the public market page share
 * ONE minimum-trade-sample gate (`marketStatHygienePolicy.minimumTradeSample`)
 * rather than a per-surface override -- the median/volume columns this gate
 * suppresses are computed and stored once, at write time, on the Daily
 * Product Rollup and Product Market Aggregate (see
 * `../read-model/rollup-maintenance.ts`), not re-gated per reader. Splitting
 * this per surface would mean the same product could show a median on one
 * page and "insufficient data" on another for the identical underlying
 * trade count -- exactly the kind of inconsistency the epic's "integrity
 * before audience" design pillar rules out. If a real per-surface need
 * emerges, it belongs on this display policy as a second, presentation-tier
 * gate layered on top of the shared write-time one, not a replacement for it.
 */

export type MarketAnalyticsDisplayPolicyValue = Readonly<{
  /** Whether verified-sale chart markers render at all (item-detail market panel). */
  showVerifiedMarkers: boolean;
  /** Trailing window, in days, the public market page charts. */
  publicPageHistoryWindowDays: number;
  /** Shared (CDN) cache lifetime, in seconds, for the public market-pages JSON API response. */
  publicPageCacheTtlSeconds: number;
}>;

/** This milestone's launch behavior, carried forward byte-identical as the compiled fallback. */
export const MARKET_ANALYTICS_DISPLAY_LAUNCH_POLICY_VALUE: MarketAnalyticsDisplayPolicyValue = {
  showVerifiedMarkers: true,
  publicPageHistoryWindowDays: 180,
  publicPageCacheTtlSeconds: 86400,
};

const MIN_HISTORY_WINDOW_DAYS = 30;
const MAX_HISTORY_WINDOW_DAYS = 365;
const MIN_CACHE_TTL_SECONDS = 60;
const MAX_CACHE_TTL_SECONDS = 604_800;

function normalizeBoundedInteger(value: unknown, fieldName: string, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new Error(`${fieldName} must be a whole number between ${min} and ${max}.`);
  }
  return numeric;
}

export function decodeMarketAnalyticsDisplayPolicyValue(raw: JsonValue): MarketAnalyticsDisplayPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Market analytics display policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;

  if (typeof record.showVerifiedMarkers !== "boolean") {
    throw new Error("showVerifiedMarkers must be a boolean.");
  }

  const publicPageHistoryWindowDays = normalizeBoundedInteger(
    record.publicPageHistoryWindowDays,
    "Public page history window days",
    MIN_HISTORY_WINDOW_DAYS,
    MAX_HISTORY_WINDOW_DAYS,
  );

  const publicPageCacheTtlSeconds = normalizeBoundedInteger(
    record.publicPageCacheTtlSeconds,
    "Public page cache TTL seconds",
    MIN_CACHE_TTL_SECONDS,
    MAX_CACHE_TTL_SECONDS,
  );

  return {
    showVerifiedMarkers: record.showVerifiedMarkers,
    publicPageHistoryWindowDays,
    publicPageCacheTtlSeconds,
  };
}

export const marketAnalyticsDisplayPolicy: PolicyDefinition<MarketAnalyticsDisplayPolicyValue> = definePolicy({
  policyKey: "pricing.market-analytics-display",
  contextName: "pricing",
  schemaSummary:
    "{ showVerifiedMarkers: boolean, publicPageHistoryWindowDays: integer 30-365, publicPageCacheTtlSeconds: integer 60-604800 }",
  defaultValue: MARKET_ANALYTICS_DISPLAY_LAUNCH_POLICY_VALUE,
  decodeValue: decodeMarketAnalyticsDisplayPolicyValue,
});
