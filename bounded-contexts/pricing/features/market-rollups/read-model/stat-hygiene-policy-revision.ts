import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  decodeMarketStatHygienePolicyValue,
  MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE,
  type MarketStatHygienePolicyValue,
} from "../../market-trades/domain/stat-hygiene-policy";

/**
 * Stable built-in revisions used when a daily period has no platform-policy
 * event to bind to. Keep both mappings forever: rollup rows persist the id,
 * then re-derivation loads the value by that exact id.
 */
export const MARKET_STAT_HYGIENE_LEGACY_UNTRIMMED_REVISION_ID = "pricing.market-stat-hygiene/legacy-untrimmed-v1";
export const MARKET_STAT_HYGIENE_COMPILED_REVISION_ID = "pricing.market-stat-hygiene/compiled-v1";

const MARKET_STAT_HYGIENE_LEGACY_UNTRIMMED_VALUE: MarketStatHygienePolicyValue = {
  ...MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE,
  outlierTrimPercentile: 0,
};

export type MarketStatHygienePolicyRevision = Readonly<{
  revisionId: string;
  value: MarketStatHygienePolicyValue;
}>;

type PolicyRevisionRow = Readonly<{ event_id: string; value: unknown }>;

/**
 * Resolves the immutable revision governing a UTC daily period. A policy
 * revision must both cover the period close and have been recorded before
 * that close, so a later retroactive edit cannot reinterpret an old period
 * during projection replay.
 */
export async function resolveMarketStatHygienePolicyRevisionForPeriod(
  db: PgQueryable,
  day: string,
): Promise<MarketStatHygienePolicyRevision> {
  const periodEnd = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(periodEnd.getTime())) {
    throw new Error(`Invalid daily rollup period '${day}'.`);
  }
  periodEnd.setUTCDate(periodEnd.getUTCDate() + 1);
  const result = await db.query<PolicyRevisionRow>(
    `SELECT event_id, value
     FROM platform_policy_document_history
     WHERE policy_key = 'pricing.market-stat-hygiene'
       AND status = 'active'
       AND effective_from < $1
       AND (effective_until IS NULL OR effective_until >= $1)
       AND recorded_at < $1
     ORDER BY effective_from DESC, recorded_at DESC, history_id DESC
     LIMIT 1`,
    [periodEnd.toISOString()],
  );
  const revision = result.rows[0];
  if (!revision) {
    return {
      revisionId: MARKET_STAT_HYGIENE_COMPILED_REVISION_ID,
      value: MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE,
    };
  }
  return decodeStoredRevision(revision);
}

/** Loads a previously-bound revision without consulting the live policy document. */
export async function loadMarketStatHygienePolicyRevision(
  db: PgQueryable,
  revisionId: string,
): Promise<MarketStatHygienePolicyRevision> {
  if (revisionId === MARKET_STAT_HYGIENE_LEGACY_UNTRIMMED_REVISION_ID) {
    return { revisionId, value: MARKET_STAT_HYGIENE_LEGACY_UNTRIMMED_VALUE };
  }
  if (revisionId === MARKET_STAT_HYGIENE_COMPILED_REVISION_ID) {
    return { revisionId, value: MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE };
  }

  const result = await db.query<PolicyRevisionRow>(
    `SELECT event_id, value
     FROM platform_policy_document_history
     WHERE event_id = $1
       AND policy_key = 'pricing.market-stat-hygiene'`,
    [revisionId],
  );
  const revision = result.rows[0];
  if (!revision) {
    throw new Error(`Bound market stat-hygiene policy revision '${revisionId}' was not found.`);
  }
  return decodeStoredRevision(revision);
}

function decodeStoredRevision(revision: PolicyRevisionRow): MarketStatHygienePolicyRevision {
  return {
    revisionId: revision.event_id,
    value: decodeMarketStatHygienePolicyValue(revision.value as never),
  };
}
