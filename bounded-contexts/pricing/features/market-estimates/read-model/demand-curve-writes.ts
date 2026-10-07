import { createHash } from "node:crypto";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import type { CurvePoint, SupplyStatus } from "../domain/demand-curve/curve";
import type { DemandCurveIdentity } from "./demand-curve-queries";

export const liquidityEstimatedEventType = "pricing.liquidity-estimated" as const;
export const demandCurveModelVersion = "pooled-supply-v1" as const;

export type LiquidityEstimatedPayload = Readonly<{
  schemaVersion: 1;
  catalogItemId: string;
  productId: string;
  curveVersion: number;
  fastestMedianSellDays: number | null;
  marketMedianSellDays: number | null;
  competingSellerCount: number | null;
  supplyStatus: SupplyStatus;
  builtAt: string;
}>;

const context: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: { performedByUserId: "usr_pricing_system" as never, forAccountId: "acc_pricing_system" as never },
};

export function curveFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function demandCurveStreamId(identity: DemandCurveIdentity): string {
  return `pricing.demand-curve-${createHash("sha256")
    .update(JSON.stringify([identity.catalogItemId, identity.productId]))
    .digest("hex")}`;
}

type CurveWrite = DemandCurveIdentity &
  Readonly<{
    providerCondition: string;
    providerVariant: string;
    providerLanguage: string;
    fingerprint: string;
    policyRevisionId: string;
    ladderMethod: string;
    anchorCondition: string | null;
    exposureStartReason: string;
    salesCoverage: string;
    supplyStatus: SupplyStatus;
    ownSellerExclusionApplied: boolean | null;
    points: readonly CurvePoint[];
    builtAt: string;
  }>;

/** The event stream is authoritative for the last authored fingerprint and version, not the asynchronously served row. */
export async function writeDemandCurve(
  pool: PgTransactionalPool,
  store: PostgresEventStore,
  input: CurveWrite,
): Promise<"built" | "unchanged" | "conflict"> {
  return withPgTransaction(pool, async (client) => {
    const streamId = demandCurveStreamId(input);
    const history = await readCompleteStream(
      { readStream: (page) => store.readStreamInTransaction(client, page) },
      { streamId, maxEvents: 10_000 },
    );
    const last = history.at(-1);
    const prior = last?.payload as { fingerprint?: string; curveVersion?: number } | undefined;
    const current = await client.query<{ version: string; fingerprint: string; superseded_at: Date | null }>(
      `SELECT curve.version, curve.fingerprint, curve.superseded_at
       FROM pricing_demand_curve_versions AS curve
       WHERE curve.catalog_item_id = $1 AND curve.product_id = $2
       ORDER BY curve.version DESC LIMIT 1`,
      [input.catalogItemId, input.productId],
    );
    const row = current.rows[0];
    if (
      prior?.fingerprint === input.fingerprint &&
      row &&
      row.superseded_at === null &&
      row.fingerprint === input.fingerprint
    )
      return "unchanged";
    const version = (prior?.curveVersion ?? 0) + 1;
    // A row CAS proves this writer still sees the same served version. The stream append has its own expected-version fence.
    if (row && row.superseded_at === null) {
      const removed = await client.query(
        `UPDATE pricing_demand_curve_versions AS curve SET superseded_at = $4
         WHERE curve.catalog_item_id = $1 AND curve.product_id = $2 AND curve.version = $3 AND curve.superseded_at IS NULL`,
        [input.catalogItemId, input.productId, row.version, input.builtAt],
      );
      if (removed.rowCount !== 1) return "conflict";
    }
    await client.query(
      `INSERT INTO pricing_demand_curve_versions
      (catalog_item_id,product_id,version,provider_condition,provider_variant,provider_language,fingerprint,model_version,
       policy_revision_id,ladder_method,anchor_condition,exposure_start_reason,sales_coverage,supply_status,
       own_seller_exclusion_applied,built_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        input.catalogItemId,
        input.productId,
        version,
        input.providerCondition,
        input.providerVariant,
        input.providerLanguage,
        input.fingerprint,
        demandCurveModelVersion,
        input.policyRevisionId,
        input.ladderMethod,
        input.anchorCondition,
        input.exposureStartReason,
        input.salesCoverage,
        input.supplyStatus,
        input.ownSellerExclusionApplied,
        input.builtAt,
      ],
    );
    await client.query(
      `INSERT INTO pricing_demand_curve_points
      (catalog_item_id,product_id,version,percentile,price_amount,buyer_arrival_interval_days,competing_seller_count,
       store_win_share,median_sell_days,qualifying_sale_count,history_capped,hopeless,supply_status)
      SELECT $1,$2,$3,point.percentile,point.price_amount,point.buyer_arrival_interval_days,
             point.competing_seller_count,point.store_win_share,point.median_sell_days,
             point.qualifying_sale_count,point.history_capped,point.hopeless,point.supply_status
      FROM jsonb_to_recordset($4::jsonb) AS point(
        percentile integer,price_amount numeric(12,2),buyer_arrival_interval_days numeric(20,8),
        competing_seller_count integer,store_win_share numeric(12,10),median_sell_days numeric(20,8),
        qualifying_sale_count integer,history_capped boolean,hopeless boolean,supply_status text)`,
      [
        input.catalogItemId,
        input.productId,
        version,
        JSON.stringify(
          input.points.map((point) => ({
            percentile: point.percentile,
            price_amount: point.priceAmount,
            buyer_arrival_interval_days: point.buyerArrivalIntervalDays,
            competing_seller_count: point.competingSellerCount,
            store_win_share: point.storeWinShare,
            median_sell_days: point.medianSellDays,
            qualifying_sale_count: point.qualifyingSaleCount,
            history_capped: point.historyCapped,
            hopeless: point.hopeless,
            supply_status: point.supplyStatus,
          })),
        ),
      ],
    );
    const median =
      input.points.find((point) => point.percentile === 50) ?? input.points[Math.floor(input.points.length / 2)];
    const fastest = input.points.flatMap((point) => (point.medianSellDays === null ? [] : [point.medianSellDays]));
    const payload: LiquidityEstimatedPayload & { fingerprint: string } = {
      schemaVersion: 1,
      catalogItemId: input.catalogItemId,
      productId: input.productId,
      curveVersion: version,
      fastestMedianSellDays: fastest.length ? Math.min(...fastest) : null,
      marketMedianSellDays: median?.medianSellDays ?? null,
      competingSellerCount: median?.competingSellerCount ?? null,
      supplyStatus: input.supplyStatus,
      builtAt: input.builtAt,
      fingerprint: input.fingerprint,
    };
    await store.appendToStreamInTransaction(client, {
      streamId,
      expectedVersion: last?.streamVersion ?? "no_stream",
      context,
      wakeSourceContextName: "pricing",
      events: [{ eventType: liquidityEstimatedEventType, payload }],
    });
    return "built";
  });
}

export async function supersedeDemandCurve(
  db: PgQueryable,
  identity: DemandCurveIdentity,
  at: string,
): Promise<boolean> {
  const read = (
    await db.query<{ version: string; fingerprint: string }>(
      `SELECT curve.version,curve.fingerprint FROM pricing_demand_curve_versions AS curve
     WHERE curve.catalog_item_id=$1 AND curve.product_id=$2 AND curve.superseded_at IS NULL
     ORDER BY curve.version DESC LIMIT 1`,
      [identity.catalogItemId, identity.productId],
    )
  ).rows[0];
  if (!read) return false;
  const result = await db.query(
    `UPDATE pricing_demand_curve_versions AS curve SET superseded_at = $3
    WHERE curve.catalog_item_id = $1 AND curve.product_id = $2 AND curve.superseded_at IS NULL
      AND curve.version=$4 AND curve.fingerprint=$5`,
    [identity.catalogItemId, identity.productId, at, read.version, read.fingerprint],
  );
  return result.rowCount === 1;
}

export type CurveCursor = DemandCurveIdentity & Readonly<{ priority: number; generation: number }>;
export async function getDemandCurveCursor(db: PgQueryable): Promise<CurveCursor | null> {
  const row = (
    await db.query<{
      after_priority: number;
      after_catalog_item_id: string;
      after_product_id: string;
      generation: string;
    }>(
      `SELECT after_priority,after_catalog_item_id,after_product_id,generation FROM pricing_demand_curve_closer_cursors WHERE closer_name='demand-curve'`,
    )
  ).rows[0];
  return row
    ? {
        priority: row.after_priority,
        catalogItemId: row.after_catalog_item_id,
        productId: row.after_product_id,
        generation: Number(row.generation),
      }
    : null;
}

export async function saveDemandCurveCursor(
  db: PgQueryable,
  read: CurveCursor | null,
  next: Omit<CurveCursor, "generation"> | null,
  at: string,
): Promise<boolean> {
  if (read === null) {
    if (next === null) return true;
    const result = await db.query(
      `INSERT INTO pricing_demand_curve_closer_cursors
      (closer_name,after_priority,after_catalog_item_id,after_product_id,generation,updated_at)
      VALUES ('demand-curve',$1,$2,$3,1,$4) ON CONFLICT DO NOTHING`,
      [next.priority, next.catalogItemId, next.productId, at],
    );
    return result.rowCount === 1;
  }
  const result = await db.query(
    `UPDATE pricing_demand_curve_closer_cursors AS cursor
    SET after_priority=$2,after_catalog_item_id=$3,after_product_id=$4,generation=cursor.generation+1,updated_at=$5
    WHERE cursor.closer_name='demand-curve' AND cursor.generation=$1
      AND cursor.after_priority=$6 AND cursor.after_catalog_item_id=$7 AND cursor.after_product_id=$8`,
    [
      read.generation,
      next?.priority ?? 0,
      next?.catalogItemId ?? "",
      next?.productId ?? "",
      at,
      read.priority,
      read.catalogItemId,
      read.productId,
    ],
  );
  return result.rowCount === 1;
}
