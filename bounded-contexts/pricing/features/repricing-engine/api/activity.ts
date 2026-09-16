import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { RepricingEvaluationSkipReason, RepricingPolicyListingTrace } from "../domain/fact";

const skipFilterSql = {
  "within-tolerance": "outcome.trace->>'skipReason' = 'within-tolerance'",
  "anchor-chain-exhausted": "outcome.trace->>'skipReason' = 'anchor-chain-exhausted'",
  "terminal-hold": "outcome.trace->>'skipReason' = 'terminal-hold'",
  "terminal-pause": "outcome.trace->>'skipReason' = 'terminal-pause'",
  "terminal-notify-only": "outcome.trace->>'skipReason' = 'terminal-notify-only'",
  "currency-input-incomplete-or-mismatched": "outcome.trace->>'skipReason' = 'currency-input-incomplete-or-mismatched'",
  "budget-exhausted": "outcome.trace->>'skipReason' = 'budget-exhausted'",
  "manual-edit-conflict": "outcome.trace->>'skipReason' = 'manual-edit-conflict'",
  "domain-no-op": "outcome.trace->>'skipReason' = 'domain-no-op'",
  "policy-precondition-failed": "outcome.trace->>'skipReason' = 'policy-precondition-failed'",
  "spiral-breaker-frozen": "outcome.trace->>'skipReason' = 'spiral-breaker-frozen'",
  "resume-hysteresis": "outcome.trace->>'skipReason' = 'resume-hysteresis'",
  "repause-cooldown": "outcome.trace->>'skipReason' = 'repause-cooldown'",
  "command-error": "outcome.trace->>'skipReason' = 'command-error'",
} satisfies Record<RepricingEvaluationSkipReason, string>;

export const activityFilterSql = {
  changed: "outcome.trace->>'outcome' = 'changed'",
  ...skipFilterSql,
  "paused-for-missing-input": "pause.listing_id IS NOT NULL AND pause.resumed_at IS NULL",
  "floor-binding": "outcome.floor_binding_since IS NOT NULL",
  "spiral-breaker": "outcome.frozen_until > $3::timestamptz",
} as const;
export type RepricingActivityFilter = keyof typeof activityFilterSql;
export const repricingActivityFilters = Object.keys(activityFilterSql) as RepricingActivityFilter[];

export type RepricingActivityRow = Readonly<{
  listingId: string;
  evaluationId: string;
  policyId: string;
  productKey: Readonly<{ catalogItemId: string; productId: string }>;
  evaluatedAt: string;
  trace: RepricingPolicyListingTrace;
  floorBindingSince: string | null;
  frozenUntil: string | null;
  affectedListingCount: number;
}>;

const activityFromSql = `FROM pricing_repricing_listing_outcomes AS outcome
  LEFT JOIN pricing_repricing_policy_listing_pauses AS pause
    ON pause.listing_id = outcome.listing_id AND pause.policy_id = outcome.policy_id
  WHERE outcome.seller_account_id = $1 AND outcome.policy_id = $2`;

export async function listRepricingActivity(
  db: PgQueryable,
  input: Readonly<{
    accountId: string;
    policyId: string;
    filter?: RepricingActivityFilter;
    after?: string;
    limit: number;
    now: string;
  }>,
) {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
    throw new Error("Activity limit must be between 1 and 50.");
  }
  const values = [input.accountId, input.policyId, input.now];
  const countColumns = repricingActivityFilters
    .map((filter) => `count(*) FILTER (WHERE ${activityFilterSql[filter]})::integer AS "${filter}"`)
    .join(", ");
  const counts = await db.query<Record<RepricingActivityFilter, number>>(
    `SELECT ${countColumns} ${activityFromSql}`,
    values,
  );
  const page = await db.query<{ row: RepricingActivityRow }>(
    `WITH frozen AS (
       SELECT catalog_catalog_item_id, product_id, count(*)::integer AS affected
       FROM pricing_repricing_listing_outcomes
       WHERE seller_account_id = $1 AND frozen_until > $3::timestamptz
       GROUP BY catalog_catalog_item_id, product_id
     ) SELECT jsonb_build_object(
       'listingId', outcome.listing_id, 'evaluationId', outcome.evaluation_id, 'policyId', outcome.policy_id,
       'productKey', jsonb_build_object('catalogItemId', outcome.catalog_catalog_item_id, 'productId', outcome.product_id),
       'evaluatedAt', outcome.evaluated_at, 'trace', outcome.trace,
       'floorBindingSince', outcome.floor_binding_since, 'frozenUntil', outcome.frozen_until,
       'affectedListingCount', COALESCE((SELECT frozen.affected FROM frozen
         WHERE frozen.catalog_catalog_item_id = outcome.catalog_catalog_item_id
           AND frozen.product_id = outcome.product_id), 0)) AS row
     ${activityFromSql}
       AND (${input.filter ? activityFilterSql[input.filter] : "true"})
       AND ($4::text IS NULL OR outcome.listing_id > $4)
     ORDER BY outcome.listing_id LIMIT $5`,
    [...values, input.after ?? null, input.limit + 1],
  );
  const rows = page.rows.slice(0, input.limit).map(({ row }) => row);
  return {
    rows,
    next: page.rows.length > input.limit ? rows.at(-1)!.listingId : null,
    filterCounts: counts.rows[0]!,
  };
}

export async function getRepricingAttentionSummary(
  db: PgQueryable,
  input: Readonly<{ accountId: string; floorBindingAlertDays: number; now: string }>,
) {
  const floor = await db.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM pricing_repricing_listing_outcomes
     WHERE seller_account_id = $1 AND floor_binding_since <= $2::timestamptz - $3 * interval '1 day'`,
    [input.accountId, input.now, input.floorBindingAlertDays],
  );
  const paused = await db.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM pricing_repricing_policy_listing_pauses AS pause
     JOIN pricing_repricing_policies AS policy ON policy.policy_id = pause.policy_id
     WHERE policy.seller_account_id = $1 AND pause.resumed_at IS NULL`,
    [input.accountId],
  );
  const budget = await db.query<{ policyId: string; count: number }>(
    `SELECT policy_id AS "policyId", count(*)::integer AS count
     FROM pricing_repricing_listing_outcomes
     WHERE seller_account_id = $1 AND trace->>'skipReason' = 'budget-exhausted'
       AND evaluated_at >= date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       AND evaluated_at < (date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC'
     GROUP BY policy_id ORDER BY policy_id`,
    [input.accountId, input.now],
  );
  const halt = await db.query<{ engaged: boolean }>(
    `SELECT engaged FROM pricing_repricing_halts WHERE seller_account_id = $1`,
    [input.accountId],
  );
  const frozen = await db.query<{
    productKey: RepricingActivityRow["productKey"];
    listingCount: number;
    frozenUntil: Date;
  }>(
    `SELECT jsonb_build_object('catalogItemId', catalog_catalog_item_id, 'productId', product_id) AS "productKey",
       count(*)::integer AS "listingCount", max(frozen_until) AS "frozenUntil"
     FROM pricing_repricing_listing_outcomes WHERE seller_account_id = $1 AND frozen_until > $2::timestamptz
     GROUP BY catalog_catalog_item_id, product_id ORDER BY catalog_catalog_item_id, product_id`,
    [input.accountId, input.now],
  );
  return {
    floorBinding: floor.rows[0]!.count,
    pausedForMissingInput: paused.rows[0]!.count,
    budgetExhaustedToday: budget.rows,
    haltEngaged: halt.rows[0]?.engaged ?? false,
    frozenProducts: frozen.rows.map((row) => ({ ...row, frozenUntil: row.frozenUntil.toISOString() })),
  };
}
