import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { RepricingPolicyEvaluatedEvent } from "../domain/fact";

const factColumns = `listing_id, evaluation_id, seller_account_id, policy_id,
  catalog_catalog_item_id, product_id, evaluated_at, global_position, trace, floor_binding, frozen_until`;

/** Both statements must use the same projection transaction. */
export async function projectListingOutcomeFacts(
  db: PgQueryable,
  data: RepricingPolicyEvaluatedEvent["data"],
  globalPosition: string,
): Promise<void> {
  // The no-op upsert also locks first arrivals, in listing order. A lock taken
  // only by the recompute would leave its READ COMMITTED snapshot stale after a wait.
  await db.query(
    `WITH incoming AS MATERIALIZED (
       SELECT trace->>'listingId' AS listing_id, $1::text AS evaluation_id,
         $2::text AS seller_account_id, $3::text AS policy_id,
         $4::text AS catalog_catalog_item_id, $5::text AS product_id,
         $6::timestamptz AS evaluated_at, $7::bigint AS global_position, trace,
         (trace->'clamps'->>'floor')::boolean AS floor_binding,
         (trace->>'frozenUntil')::timestamptz AS frozen_until
       FROM jsonb_array_elements($8::jsonb) AS traces(trace)
     ), locked AS (
       INSERT INTO pricing_repricing_listing_outcomes (${factColumns})
       SELECT ${factColumns} FROM incoming ORDER BY listing_id
       ON CONFLICT (listing_id) DO UPDATE SET listing_id = EXCLUDED.listing_id
       RETURNING listing_id
     )
     INSERT INTO pricing_repricing_listing_outcome_facts (${factColumns})
     SELECT incoming.*
     FROM incoming JOIN locked USING (listing_id)
     ON CONFLICT (listing_id, evaluation_id) DO NOTHING`,
    [
      data.evaluationId,
      data.sellerAccountId,
      data.policyId,
      data.catalogItemId,
      data.productId,
      data.evaluatedAt,
      globalPosition,
      JSON.stringify(data.listings),
    ],
  );
  await db.query(
    `WITH locked AS MATERIALIZED (
       SELECT outcome.* FROM pricing_repricing_listing_outcomes AS outcome
       WHERE outcome.listing_id = ANY($1::text[])
         AND (outcome.compacted_through_at IS NULL OR
           ($2::timestamptz, $3::text) >
           (outcome.compacted_through_at, outcome.compacted_through_evaluation_id))
       ORDER BY outcome.listing_id FOR UPDATE
     ), ordered AS (
       SELECT fact.*, locked.compaction_run_since,
         count(*) FILTER (WHERE NOT fact.floor_binding) OVER (
           PARTITION BY fact.listing_id ORDER BY fact.evaluated_at, fact.evaluation_id
           ROWS UNBOUNDED PRECEDING) AS run
       FROM locked JOIN pricing_repricing_listing_outcome_facts AS fact USING (listing_id)
       WHERE locked.compacted_through_at IS NULL OR
         (fact.evaluated_at, fact.evaluation_id) >
         (locked.compacted_through_at, locked.compacted_through_evaluation_id)
     ), runs AS (
       SELECT ordered.*, min(evaluated_at) FILTER (WHERE floor_binding) OVER (
         PARTITION BY listing_id, run) AS run_since
       FROM ordered
     ), current AS (
       SELECT DISTINCT ON (listing_id) * FROM runs
       ORDER BY listing_id, evaluated_at DESC, evaluation_id DESC
     )
     UPDATE pricing_repricing_listing_outcomes AS outcome SET
       evaluation_id = current.evaluation_id, seller_account_id = current.seller_account_id,
       policy_id = current.policy_id, catalog_catalog_item_id = current.catalog_catalog_item_id,
       product_id = current.product_id, evaluated_at = current.evaluated_at,
       global_position = current.global_position, trace = current.trace,
       floor_binding = current.floor_binding, frozen_until = current.frozen_until,
       floor_binding_since = CASE WHEN NOT current.floor_binding THEN NULL
         WHEN current.run = 0 THEN COALESCE(current.compaction_run_since, current.run_since)
         ELSE current.run_since END
     FROM current WHERE outcome.listing_id = current.listing_id`,
    [data.listings.map(({ listingId }) => listingId), data.evaluatedAt, data.evaluationId],
  );
}

/** digestedSql is trusted caller SQL over alias `fact`, proving that fact's own window was emitted. */
export async function compactListingOutcomeFacts(
  db: PgQueryable,
  input: Readonly<{ retainFrom: string; digestedSql: string }>,
): Promise<number> {
  const result = await db.query<{ deleted: number }>(
    `WITH locked AS MATERIALIZED (
       SELECT outcome.* FROM pricing_repricing_listing_outcomes AS outcome
       ORDER BY outcome.listing_id FOR UPDATE
     ), ordered AS MATERIALIZED (
       SELECT fact.*, locked.compacted_through_at, locked.compacted_through_evaluation_id,
         locked.compaction_run_since,
         row_number() OVER (PARTITION BY fact.listing_id
           ORDER BY fact.evaluated_at DESC, fact.evaluation_id DESC) AS descending_position,
         bool_and(fact.evaluated_at < $1::timestamptz AND COALESCE((${input.digestedSql}), false)) OVER (
           PARTITION BY fact.listing_id ORDER BY fact.evaluated_at, fact.evaluation_id
           ROWS UNBOUNDED PRECEDING) AS eligible
       FROM locked JOIN pricing_repricing_listing_outcome_facts AS fact USING (listing_id)
     ), prefix AS MATERIALIZED (
       SELECT * FROM ordered WHERE eligible AND descending_position > 1
     ), above_boundary AS (
       SELECT prefix.*, count(*) FILTER (WHERE NOT floor_binding) OVER (
         PARTITION BY listing_id ORDER BY evaluated_at, evaluation_id
         ROWS UNBOUNDED PRECEDING) AS run
       FROM prefix WHERE compacted_through_at IS NULL OR
         (evaluated_at, evaluation_id) > (compacted_through_at, compacted_through_evaluation_id)
     ), runs AS (
       SELECT above_boundary.*, min(evaluated_at) FILTER (WHERE floor_binding) OVER (
         PARTITION BY listing_id, run) AS run_since FROM above_boundary
     ), boundary AS (
       SELECT DISTINCT ON (listing_id) * FROM runs
       ORDER BY listing_id, evaluated_at DESC, evaluation_id DESC
     ), summarized AS (
       UPDATE pricing_repricing_listing_outcomes AS outcome SET
         compacted_through_at = boundary.evaluated_at,
         compacted_through_evaluation_id = boundary.evaluation_id,
         compaction_run_since = CASE WHEN NOT boundary.floor_binding THEN NULL
           WHEN boundary.run = 0 THEN COALESCE(boundary.compaction_run_since, boundary.run_since)
           ELSE boundary.run_since END
       FROM boundary WHERE outcome.listing_id = boundary.listing_id
       RETURNING outcome.listing_id
     ), deleted AS (
       DELETE FROM pricing_repricing_listing_outcome_facts AS fact USING prefix
       WHERE fact.listing_id = prefix.listing_id AND fact.evaluation_id = prefix.evaluation_id
       RETURNING fact.listing_id
     ) SELECT count(*)::integer AS deleted FROM deleted`,
    [input.retainFrom],
  );
  return result.rows[0]!.deleted;
}
