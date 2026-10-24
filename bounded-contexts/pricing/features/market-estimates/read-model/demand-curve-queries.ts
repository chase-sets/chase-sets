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
    currencyCode: string | null;
    freshUntil: string | null;
  }>;
export type DemandCurvePoint = CurvePoint & Readonly<{ salesCoverage: string }>;
export type DemandCurveWithPoints = DemandCurveRecord & Readonly<{ points: readonly DemandCurvePoint[] }>;

type VersionRow = {
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
  currency_code: string | null;
  fresh_until: Date | null;
};

type PointRow = {
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
};

const versionColumns = `curve.version, curve.provider_condition, curve.provider_variant, curve.provider_language,
              curve.fingerprint, curve.model_version, curve.policy_revision_id, curve.ladder_method,
              curve.anchor_condition, curve.exposure_start_reason, curve.sales_coverage,
              curve.supply_status, curve.own_seller_exclusion_applied, curve.built_at, curve.currency_code, curve.fresh_until`;
const servedAsOfSql = `curve.built_at <= $3 AND (curve.superseded_at IS NULL OR curve.superseded_at > $3)`;
const pointColumns = `point.percentile, point.price_amount::text, point.buyer_arrival_interval_days::text,
              point.competing_seller_count, point.store_win_share::text, point.median_sell_days::text,
              point.qualifying_sale_count, point.history_capped, point.hopeless, point.supply_status`;

/** Newest served immutable version at or before asOf; a superseded curve is not a stale positive answer. */
export async function getDemandCurve(
  db: PgQueryable,
  input: DemandCurveIdentity & Readonly<{ asOf: string }>,
): Promise<DemandCurveRecord | null> {
  const result = await db.query<VersionRow>(
    `SELECT ${versionColumns}
       FROM pricing_demand_curve_versions AS curve
       WHERE curve.catalog_item_id = $1 AND curve.product_id = $2
         AND ${servedAsOfSql}
       ORDER BY curve.version DESC LIMIT 1`,
    [input.catalogItemId, input.productId, input.asOf],
  );
  const row = result.rows[0];
  return row ? toDemandCurveRecord(input, row) : null;
}

/**
 * getDemandCurve for a page of identities with their points: one versions
 * query, then one points query for the versions found. An identity with no
 * served version at asOf is absent from the result.
 */
export async function listDemandCurvesAsOf(
  db: PgQueryable,
  input: Readonly<{ identities: readonly DemandCurveIdentity[]; asOf: string }>,
): Promise<readonly DemandCurveWithPoints[]> {
  if (input.identities.length === 0) return [];
  const versions = await db.query<VersionRow & { catalog_item_id: string; product_id: string }>(
    `SELECT DISTINCT ON (curve.catalog_item_id, curve.product_id) curve.catalog_item_id, curve.product_id,
              ${versionColumns}
       FROM unnest($1::text[], $2::text[]) AS identity(catalog_item_id, product_id)
       JOIN pricing_demand_curve_versions AS curve USING (catalog_item_id, product_id)
       WHERE ${servedAsOfSql}
       ORDER BY curve.catalog_item_id, curve.product_id, curve.version DESC`,
    [
      input.identities.map((identity) => identity.catalogItemId),
      input.identities.map((identity) => identity.productId),
      input.asOf,
    ],
  );
  if (versions.rows.length === 0) return [];
  const records = versions.rows.map((row) =>
    toDemandCurveRecord({ catalogItemId: row.catalog_item_id, productId: row.product_id }, row),
  );
  const points = await db.query<PointRow & { catalog_item_id: string; product_id: string }>(
    `SELECT point.catalog_item_id, point.product_id, ${pointColumns}
       FROM unnest($1::text[], $2::text[], $3::bigint[]) AS served(catalog_item_id, product_id, version)
       JOIN pricing_demand_curve_points AS point USING (catalog_item_id, product_id, version)
       ORDER BY point.catalog_item_id, point.product_id, point.percentile ASC`,
    [
      records.map((record) => record.catalogItemId),
      records.map((record) => record.productId),
      records.map((record) => record.version),
    ],
  );
  const key = (identity: DemandCurveIdentity) => JSON.stringify([identity.catalogItemId, identity.productId]);
  const pointsByCurve = new Map(records.map((record) => [key(record), [] as DemandCurvePoint[]]));
  const salesCoverage = new Map(records.map((record) => [key(record), record.salesCoverage]));
  for (const row of points.rows) {
    const identity = { catalogItemId: row.catalog_item_id, productId: row.product_id };
    pointsByCurve.get(key(identity))!.push(toDemandCurvePoint(row, salesCoverage.get(key(identity))!));
  }
  return records.map((record) => ({ ...record, points: pointsByCurve.get(key(record))! }));
}

export async function listDemandCurvePoints(
  db: PgQueryable,
  input: DemandCurveIdentity & Readonly<{ version: number }>,
): Promise<readonly DemandCurvePoint[]> {
  const result = await db.query<PointRow & { sales_coverage: string }>(
    `SELECT ${pointColumns},
              curve.sales_coverage
       FROM pricing_demand_curve_points AS point
       JOIN pricing_demand_curve_versions AS curve
         ON curve.catalog_item_id = point.catalog_item_id AND curve.product_id = point.product_id AND curve.version = point.version
       WHERE curve.catalog_item_id = $1 AND curve.product_id = $2 AND curve.version = $3
       ORDER BY point.percentile ASC`,
    [input.catalogItemId, input.productId, input.version],
  );
  return result.rows.map((row) => toDemandCurvePoint(row, row.sales_coverage));
}

function toDemandCurveRecord(identity: DemandCurveIdentity, row: VersionRow): DemandCurveRecord {
  return {
    catalogItemId: identity.catalogItemId,
    productId: identity.productId,
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
    currencyCode: row.currency_code,
    freshUntil: row.fresh_until === null ? null : new Date(row.fresh_until).toISOString(),
  };
}

function toDemandCurvePoint(row: PointRow, salesCoverage: string): DemandCurvePoint {
  return {
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
    salesCoverage,
  };
}
