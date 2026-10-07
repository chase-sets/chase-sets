import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CurvePoint } from "../domain/demand-curve/curve";

export type DemandCurveIdentity = Readonly<{ catalogItemId: string; productId: string }>;
export type DemandCurveRecord = DemandCurveIdentity &
  Readonly<{
    version: number;
    providerCondition: string;
    providerVariant: string;
    providerLanguage: string;
    fingerprint: string;
    modelVersion: string;
    policyRevisionId: string;
    ladderMethod: string;
    anchorCondition: string | null;
    exposureStartReason: string;
    salesCoverage: string;
    supplyStatus: CurvePoint["supplyStatus"];
    ownSellerExclusionApplied: boolean | null;
    builtAt: string;
  }>;
export type DemandCurvePoint = CurvePoint & Readonly<{ salesCoverage: string }>;

/** Newest served immutable version at or before asOf; a superseded curve is not a stale positive answer. */
export async function getDemandCurve(
  db: PgQueryable,
  input: DemandCurveIdentity & Readonly<{ asOf: string }>,
): Promise<DemandCurveRecord | null> {
  const result = await db.query<{
    version: string;
    provider_condition: string;
    provider_variant: string;
    provider_language: string;
    fingerprint: string;
    model_version: string;
    policy_revision_id: string;
    ladder_method: string;
    anchor_condition: string | null;
    exposure_start_reason: string;
    sales_coverage: string;
    supply_status: CurvePoint["supplyStatus"];
    own_seller_exclusion_applied: boolean | null;
    built_at: Date;
  }>(
    `SELECT curve.version, curve.provider_condition, curve.provider_variant, curve.provider_language,
              curve.fingerprint, curve.model_version, curve.policy_revision_id, curve.ladder_method,
              curve.anchor_condition, curve.exposure_start_reason, curve.sales_coverage,
              curve.supply_status, curve.own_seller_exclusion_applied, curve.built_at
       FROM pricing_demand_curve_versions AS curve
       WHERE curve.catalog_item_id = $1 AND curve.product_id = $2
         AND curve.built_at <= $3 AND (curve.superseded_at IS NULL OR curve.superseded_at > $3)
       ORDER BY curve.version DESC LIMIT 1`,
    [input.catalogItemId, input.productId, input.asOf],
  );
  const row = result.rows[0];
  return row
    ? {
        catalogItemId: input.catalogItemId,
        productId: input.productId,
        version: Number(row.version),
        providerCondition: row.provider_condition,
        providerVariant: row.provider_variant,
        providerLanguage: row.provider_language,
        fingerprint: row.fingerprint,
        modelVersion: row.model_version,
        policyRevisionId: row.policy_revision_id,
        ladderMethod: row.ladder_method,
        anchorCondition: row.anchor_condition,
        exposureStartReason: row.exposure_start_reason,
        salesCoverage: row.sales_coverage,
        supplyStatus: row.supply_status,
        ownSellerExclusionApplied: row.own_seller_exclusion_applied,
        builtAt: new Date(row.built_at).toISOString(),
      }
    : null;
}

export async function listDemandCurvePoints(
  db: PgQueryable,
  input: DemandCurveIdentity & Readonly<{ version: number }>,
): Promise<readonly DemandCurvePoint[]> {
  const result = await db.query<{
    percentile: number;
    price_amount: string;
    buyer_arrival_interval_days: string | null;
    competing_seller_count: number | null;
    store_win_share: string | null;
    median_sell_days: string | null;
    qualifying_sale_count: number;
    history_capped: boolean;
    hopeless: boolean;
    supply_status: CurvePoint["supplyStatus"];
    sales_coverage: string;
  }>(
    `SELECT point.percentile, point.price_amount::text, point.buyer_arrival_interval_days::text,
              point.competing_seller_count, point.store_win_share::text, point.median_sell_days::text,
              point.qualifying_sale_count, point.history_capped, point.hopeless, point.supply_status,
              curve.sales_coverage
       FROM pricing_demand_curve_points AS point
       JOIN pricing_demand_curve_versions AS curve
         ON curve.catalog_item_id = point.catalog_item_id AND curve.product_id = point.product_id AND curve.version = point.version
       WHERE curve.catalog_item_id = $1 AND curve.product_id = $2 AND curve.version = $3
       ORDER BY point.percentile ASC`,
    [input.catalogItemId, input.productId, input.version],
  );
  return result.rows.map((row) => ({
    percentile: row.percentile,
    priceAmount: row.price_amount,
    buyerArrivalIntervalDays: row.buyer_arrival_interval_days === null ? null : Number(row.buyer_arrival_interval_days),
    competingSellerCount: row.competing_seller_count,
    storeWinShare: row.store_win_share === null ? null : Number(row.store_win_share),
    medianSellDays: row.median_sell_days === null ? null : Number(row.median_sell_days),
    qualifyingSaleCount: row.qualifying_sale_count,
    historyCapped: row.history_capped,
    hopeless: row.hopeless,
    supplyStatus: row.supply_status,
    salesCoverage: row.sales_coverage,
  }));
}
