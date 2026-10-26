import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { RepricingEngineServices } from "../../repricing-engine/api/runtime";
import type { RepricingHealthSummary } from "../../repricing-engine/api/health-summary";
import { hashRepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import {
  buildCandidateBody,
  type AttentionValues,
  type CandidateMetrics,
  type EconomicsSet,
  type GoalChoice,
} from "../api/goal-comparison";

export type ComparisonFacts = Readonly<{
  raised: number;
  lowered: number;
  economicsSet: EconomicsSet;
  attentionValues: AttentionValues;
  evidenceCurrent: boolean;
}>;

/** Counts and currency-partitioned sums only: no listing or trace rows leave SQL. */
export async function readComparisonFacts(
  db: PgQueryable,
  input: Readonly<{ accountId: string; dryRunId: string; now: string }>,
): Promise<ComparisonFacts> {
  const result = await db.query<{
    raised: number;
    lowered: number;
    economicsDigest: string;
    economicsSize: number;
    attentionValues: AttentionValues;
    evidenceCurrent: boolean;
  }>(
    `WITH captured AS (
       SELECT (health->>'capturedAt')::timestamptz AS at
       FROM pricing_repricing_dry_runs WHERE seller_account_id=$1 AND dry_run_id=$2
     ), items AS (
       SELECT listing_id, outcome, delta_cents, flags, health,
         health->>'currencyCode' AS currency,
         COALESCE((health->>'quantity')::numeric * (health->>'currentPriceAmount')::numeric, 0) AS listed_value,
         health->'economics' IS NOT NULL AND health->'economics' <> 'null'::jsonb AS in_e,
         health->'modeled' IS NOT NULL AND health->'modeled' <> 'null'::jsonb AS in_m
       FROM pricing_repricing_dry_run_traces WHERE seller_account_id=$1 AND dry_run_id=$2
     ), amounts AS (
       SELECT currency,
         jsonb_build_object(
           'economics', jsonb_build_object('value', COALESCE(sum(listed_value) FILTER (WHERE in_m AND NOT in_e),0),
             'count', count(*) FILTER (WHERE in_m AND NOT in_e)),
           'value-at-risk', jsonb_build_object('value', COALESCE(sum(listed_value) FILTER (WHERE health->>'risk' IN ('hopeless','slow')),0),
             'count', count(*) FILTER (WHERE health->>'risk' IN ('hopeless','slow'))),
           'floor-binding', jsonb_build_object('value', COALESCE(sum(listed_value) FILTER (WHERE 'floor-binding'=ANY(flags)),0),
             'count', count(*) FILTER (WHERE 'floor-binding'=ANY(flags))),
           'stale-curve', jsonb_build_object('value', COALESCE(sum(listed_value) FILTER (WHERE health->>'modeledReason'='stale-curve'),0),
             'count', count(*) FILTER (WHERE health->>'modeledReason'='stale-curve'))
         ) AS attention
       FROM items WHERE currency IS NOT NULL GROUP BY currency
     )
     SELECT count(*) FILTER (WHERE outcome='changed' AND delta_cents>0)::integer AS raised,
       count(*) FILTER (WHERE outcome='changed' AND delta_cents<0)::integer AS lowered,
       md5(COALESCE(string_agg(to_jsonb(listing_id)::text, ',' ORDER BY listing_id) FILTER (WHERE in_e),'')) AS "economicsDigest",
       count(*) FILTER (WHERE in_e)::integer AS "economicsSize",
       COALESCE((SELECT jsonb_object_agg(currency, attention) FROM amounts),'{}'::jsonb) AS "attentionValues",
       NOT EXISTS (
         SELECT 1 FROM items AS item
         LEFT JOIN pricing_market_listing_inputs AS listing ON listing.listing_id=item.listing_id
           AND listing.seller_account_id=$1
         WHERE listing.listing_id IS NULL
           OR listing.price_amount IS DISTINCT FROM (item.health->>'currentPriceAmount')::numeric
           OR listing.quantity_cap IS DISTINCT FROM (item.health->>'quantity')::integer
           OR upper(listing.price_currency_code) IS DISTINCT FROM item.currency
           OR EXISTS (
             SELECT 1 FROM pricing_demand_curve_versions AS curve
             WHERE curve.catalog_item_id=listing.catalog_catalog_item_id AND curve.product_id=listing.product_id
               AND (curve.built_at > (SELECT at FROM captured)
                 OR curve.version > (item.health#>>'{modeled,curveVersion}')::integer
                 OR (curve.version = (item.health#>>'{modeled,curveVersion}')::integer AND curve.fresh_until <= $3::timestamptz))
           )
       ) AS "evidenceCurrent"
     FROM items`,
    [input.accountId, input.dryRunId, input.now],
  );
  const row = result.rows[0]!;
  return {
    raised: row.raised,
    lowered: row.lowered,
    economicsSet: { digest: row.economicsDigest, size: row.economicsSize },
    attentionValues: row.attentionValues,
    evidenceCurrent: row.evidenceCurrent,
  };
}

export async function readCandidateComparison(
  db: PgQueryable,
  engine: Pick<RepricingEngineServices, "getDryRun">,
  input: Readonly<{
    accountId: string;
    policyId: string;
    targetRevision: number;
    targetUpdatedAt: string | null;
    body: Parameters<typeof buildCandidateBody>[0];
    choice: GoalChoice;
    now: string;
    basisCapturedAt?: string;
    basisFacts?: Readonly<{ dryRunId: string; facts: ComparisonFacts }>;
  }>,
): Promise<CandidateMetrics | null> {
  const bodyHash = hashRepricingDryRunBody(buildCandidateBody(input.body, input.choice));
  const stored = await readPricingHealthRun(db, { ...input, bodyHash });
  const latest = await db.query<{ dryRunId: string }>(
    `SELECT dry_run_id AS "dryRunId" FROM pricing_repricing_dry_runs
     WHERE seller_account_id=$1 AND replacing_policy_id=$2 AND body_hash=$3
     ORDER BY requested_at DESC, dry_run_id DESC LIMIT 1`,
    [input.accountId, input.policyId, bodyHash],
  );
  const id = latest.rows[0]?.dryRunId;
  const run = id ? await engine.getDryRun(input.accountId, id) : null;
  if (
    !run ||
    run.replacingPolicyId !== input.policyId ||
    run.bodyHash !== bodyHash ||
    hashRepricingDryRunBody(run.body) !== bodyHash ||
    (input.targetUpdatedAt && Date.parse(run.requestedAt) < Date.parse(input.targetUpdatedAt)) ||
    (input.basisCapturedAt && Date.parse(run.requestedAt) < Date.parse(input.basisCapturedAt))
  )
    return null;
  const health = run.status === "completed" && stored.run?.dryRunId === run.dryRunId ? stored.health : null;
  const facts = health
    ? input.basisFacts?.dryRunId === run.dryRunId
      ? input.basisFacts.facts
      : await readComparisonFacts(db, { ...input, dryRunId: run.dryRunId })
    : null;
  if (facts && !facts.evidenceCurrent) return null;
  const metric = <T>(select: (summary: NonNullable<typeof health>["currencies"][string]) => T) =>
    health
      ? Object.fromEntries(Object.entries(health.currencies).map(([currency, summary]) => [currency, select(summary)]))
      : null;
  const listingCount = health?.population.listingCount ?? null;
  const directive = input.body.rules[0]?.directive;
  return {
    goalId: input.choice.goalId,
    goalVersion: input.choice.goalVersion,
    dryRunId: run.dryRunId,
    status: run.status,
    requestedAt: run.requestedAt,
    completedAt: run.completedAt,
    bodyHash,
    targetPolicyId: input.policyId,
    targetRevision: input.targetRevision,
    listingCount,
    raised: facts?.raised ?? null,
    lowered: facts?.lowered ?? null,
    held: listingCount !== null && facts ? listingCount - facts.raised - facts.lowered : null,
    heldReasons: {
      "pause-requested": run.summary?.outcomes["pause-requested"] ?? 0,
      "notify-only": run.summary?.outcomes["notify-only"] ?? 0,
      ...run.summary?.skipReasons,
    },
    value: metric((summary) => summary.modeledValueAmount),
    medianWaitDays: metric((summary) => summary.expectedWait.medianDays),
    p90WaitDays: metric((summary) => summary.expectedWait.p90Days),
    boundStatusCount: metric((summary) => summary.coverage.boundStatusCount),
    coverage: metric((summary) => summary.coverage.unitRatio),
    profitPerDay: metric((summary) => summary.profitPerDay.value),
    capitalTurn: metric((summary) => summary.capitalTurn.value),
    economicsSet: facts?.economicsSet ?? null,
    flags: run.summary?.flags ?? {},
    parameters: { ...input.choice.parameters },
    currencyCode: directive?.currencyCode ?? null,
    floor: directive?.floor,
    guardrails: directive?.guardrails,
  };
}

export type PricingHealthRun = Readonly<{
  dryRunId: string;
  requestedAt: string;
  completedAt: string;
  bodyHash: string;
}>;

export async function readPricingHealthRun(
  db: PgQueryable,
  input: Readonly<{ accountId: string; policyId: string; bodyHash: string }>,
) {
  const values = [input.accountId, input.policyId, input.bodyHash];
  const completed = await db.query<PricingHealthRun & { health: RepricingHealthSummary | null }>(
    `SELECT dry_run_id AS "dryRunId", requested_at::text AS "requestedAt",
       completed_at::text AS "completedAt", body_hash AS "bodyHash", health
     FROM pricing_repricing_dry_runs
     WHERE seller_account_id = $1 AND replacing_policy_id = $2 AND body_hash = $3
       AND status = 'completed' AND health IS NOT NULL
     ORDER BY completed_at DESC, dry_run_id DESC LIMIT 1`,
    values,
  );
  const pending = await db.query<{ computing: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pricing_repricing_dry_runs AS run
       JOIN pricing_repricing_dry_run_jobs AS job ON job.job_id = run.dry_run_id
         AND job.payload->>'sellerAccountId' = run.seller_account_id
       WHERE run.seller_account_id = $1 AND run.replacing_policy_id = $2 AND run.body_hash = $3
         AND run.status IN ('queued', 'running') AND job.status <> 'failed') AS computing`,
    values,
  );
  const row = completed.rows[0];
  return {
    health: row?.health ?? null,
    run: row
      ? { dryRunId: row.dryRunId, requestedAt: row.requestedAt, completedAt: row.completedAt, bodyHash: row.bodyHash }
      : null,
    computing: pending.rows[0]?.computing ?? false,
  };
}
