import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type SellerBehavioralMetricsSummaryRow = Readonly<{
  seller_account_id: string;
  window_days: number;
  orders_created_count: number;
  seller_cancelled_count: number;
  cancellation_rate: string | null;
  shipments_dispatched_count: number;
  shipments_on_time_count: number;
  on_time_shipment_rate: string | null;
  disputes_resolved_count: number;
  disputes_against_seller_count: number;
  dispute_rate: string | null;
  computed_at: string;
  updated_at: string;
}>;

/** Full detail for the seller's own dashboard -- no display gating; a seller may always see their own raw counts. */
export async function getSellerBehavioralMetricsSummary(
  db: PgQueryable,
  sellerAccountId: string,
): Promise<SellerBehavioralMetricsSummaryRow | null> {
  const result = await db.query<SellerBehavioralMetricsSummaryRow>(
    `SELECT
       seller_account_id,
       window_days,
       orders_created_count,
       seller_cancelled_count,
       cancellation_rate::text AS cancellation_rate,
       shipments_dispatched_count,
       shipments_on_time_count,
       on_time_shipment_rate::text AS on_time_shipment_rate,
       disputes_resolved_count,
       disputes_against_seller_count,
       dispute_rate::text AS dispute_rate,
       computed_at::text AS computed_at,
       updated_at::text AS updated_at
     FROM marketplace_seller_metrics_summary_pages
     WHERE seller_account_id = $1`,
    [sellerAccountId],
  );

  return result.rows[0] ?? null;
}

export type SellerBehavioralMetricsChips = Readonly<{
  sellerAccountId: string;
  /** Null when shipments_dispatched_count is under the display threshold -- no chip, not a misleading 100%/0% on a tiny sample. */
  shipsOnTime: boolean | null;
  /** Null when orders_created_count is under the display threshold. */
  lowCancellationRate: boolean | null;
  /** Null when orders_created_count is under the display threshold. */
  lowDisputeRate: boolean | null;
}>;

/**
 * Buyer-facing qualitative chips (AC: "chips, not raw percentages"). No
 * numeric rate crosses this function's return boundary -- only
 * threshold-gated booleans, so a caller cannot accidentally leak a raw
 * small-sample percentage onto a public surface. `minDisplayOrderCount` is
 * applied per metric against that metric's own denominator.
 *
 * The qualitative cutoffs (what counts as "ships on time") are the same
 * bar this slice's own summary treats as a pass: at or above the metric's
 * complement of a generous default. Kept here (query layer) rather than on
 * the policy, since these are display-copy decisions, not the
 * window/threshold business values the policy owns.
 */
export async function getSellerBehavioralMetricsChips(
  db: PgQueryable,
  sellerAccountId: string,
  minDisplayOrderCount: number,
): Promise<SellerBehavioralMetricsChips> {
  const summary = await getSellerBehavioralMetricsSummary(db, sellerAccountId);
  if (!summary) {
    return { sellerAccountId, shipsOnTime: null, lowCancellationRate: null, lowDisputeRate: null };
  }

  const shipsOnTime =
    summary.shipments_dispatched_count >= minDisplayOrderCount && summary.on_time_shipment_rate !== null
      ? Number(summary.on_time_shipment_rate) >= 0.9
      : null;
  const lowCancellationRate =
    summary.orders_created_count >= minDisplayOrderCount && summary.cancellation_rate !== null
      ? Number(summary.cancellation_rate) <= 0.05
      : null;
  const lowDisputeRate =
    summary.orders_created_count >= minDisplayOrderCount && summary.dispute_rate !== null
      ? Number(summary.dispute_rate) <= 0.02
      : null;

  return { sellerAccountId, shipsOnTime, lowCancellationRate, lowDisputeRate };
}
