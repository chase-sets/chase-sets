import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CurveCursor } from "./demand-curve-writes";

export type DemandCurveCandidate = Readonly<{
  catalogItemId: string;
  productId: string;
  condition: string;
  variant: string;
  language: string;
  priority: number;
}>;

/** A provider tuple is usable only when weekly evidence binds it to exactly one Product Key. */
export async function listDemandCurveCandidates(
  db: PgQueryable,
  input: Readonly<{
    since: string;
    asOf: string;
    limit: number;
    after: CurveCursor | null;
  }>,
): Promise<Readonly<{ candidates: readonly DemandCurveCandidate[]; unmapped: number }>> {
  const result = await db.query<{
    catalog_item_id: string;
    product_id: string;
    provider_condition: string;
    provider_variant: string;
    provider_language: string;
    priority: number;
  }>(
    `WITH bindings AS (
        SELECT bucket.catalog_item_id, bucket.provider_condition, bucket.provider_variant, bucket.provider_language,
               MIN(bucket.catalog_product_key) AS product_id,
               COUNT(DISTINCT bucket.catalog_product_key) AS bound_keys,
               BOOL_OR(bucket.catalog_product_key IS NULL) AS has_unbound
        FROM pricing_external_weekly_sale_buckets AS bucket
        WHERE bucket.last_observed_at <= $2 AND bucket.week_start >= $1::date
        GROUP BY bucket.catalog_item_id,bucket.provider_condition,bucket.provider_variant,bucket.provider_language
      ), identities AS (
        SELECT binding.catalog_item_id,binding.product_id,binding.provider_condition,binding.provider_variant,binding.provider_language
        FROM bindings AS binding WHERE binding.bound_keys = 1 AND NOT binding.has_unbound
        UNION
        SELECT curve.catalog_item_id,curve.product_id,curve.provider_condition,curve.provider_variant,curve.provider_language
        FROM pricing_demand_curve_versions AS curve WHERE curve.superseded_at IS NULL
      ), candidates AS (
        SELECT identity.catalog_item_id,identity.product_id,identity.provider_condition,identity.provider_variant,identity.provider_language,
          CASE WHEN EXISTS (SELECT 1 FROM pricing_market_listing_inputs AS listing
                            WHERE listing.catalog_catalog_item_id=identity.catalog_item_id AND listing.product_id=identity.product_id
                              AND listing.status = 'active')
                    OR EXISTS (SELECT 1 FROM pricing_inventory_item_inputs AS item
                               WHERE item.catalog_catalog_item_id=identity.catalog_item_id AND item.product_id=identity.product_id
                                 AND (item.total_quantity > 0 OR EXISTS (
                                   SELECT 1 FROM pricing_inventory_hold_inputs AS hold
                                   WHERE hold.item_id=item.item_id AND hold.status='active' AND hold.quantity > 0)))
               THEN 0 ELSE 1 END AS priority
        FROM identities AS identity
      )
      SELECT candidate.catalog_item_id,candidate.product_id,candidate.provider_condition,candidate.provider_variant,
             candidate.provider_language,candidate.priority
      FROM candidates AS candidate
      WHERE ($3::integer IS NULL OR (candidate.priority,candidate.catalog_item_id,candidate.product_id)
        > ($3::integer,$4::text,$5::text))
      ORDER BY candidate.priority,candidate.catalog_item_id,candidate.product_id LIMIT $6`,
    [
      input.since,
      input.asOf,
      input.after?.priority ?? null,
      input.after?.catalogItemId ?? null,
      input.after?.productId ?? null,
      input.limit,
    ],
  );
  const unmapped = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM (
    SELECT bucket.catalog_item_id,bucket.provider_condition,bucket.provider_variant,bucket.provider_language
    FROM pricing_external_weekly_sale_buckets AS bucket
    WHERE bucket.last_observed_at <= $2 AND bucket.week_start >= $1::date
    GROUP BY bucket.catalog_item_id,bucket.provider_condition,bucket.provider_variant,bucket.provider_language
    HAVING COUNT(DISTINCT bucket.catalog_product_key) <> 1 OR BOOL_OR(bucket.catalog_product_key IS NULL)
  ) AS unmapped`,
    [input.since, input.asOf],
  );
  return {
    candidates: result.rows.map((row) => ({
      catalogItemId: row.catalog_item_id,
      productId: row.product_id,
      condition: row.provider_condition,
      variant: row.provider_variant,
      language: row.provider_language,
      priority: row.priority,
    })),
    unmapped: Number(unmapped.rows[0]?.count ?? 0),
  };
}
