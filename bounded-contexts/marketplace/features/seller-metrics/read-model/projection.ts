import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { isResolutionAgainstSeller, type SupportRequestSnapshot } from "@chase-sets/review-eligibility";
import {
  marketplaceSellerBehavioralMetricsPolicy,
  MARKETPLACE_SELLER_BEHAVIORAL_METRICS_LAUNCH_POLICY_VALUE,
} from "../domain/behavioral-metrics-policy";
import { SELLER_CAUSED_CANCELLATION_REASON } from "../domain/common";

type ResolvePolicy = PolicyRuntime["resolvePolicy"];

function rate(numerator: number, denominator: number): string | null {
  return denominator > 0 ? (numerator / denominator).toFixed(4) : null;
}

/**
 * Recomputes one seller's rolling-window behavioral-metrics summary from
 * this slice's own source mirrors. A full recompute scoped to one seller on
 * every relevant event -- the same idiom as reviews'
 * `refreshReviewSummary` and risk-alerts' `refreshAccountAlerts` -- rather
 * than incremental counters, so replay is trivially correct.
 *
 * Denominators are metric-specific, not one blended order count (see the
 * policy's doc comment and read-model/queries.ts's per-metric N-gate):
 * - On-time-shipment rate: shipments dispatched in the window (cancelled
 *   orders that never shipped are cancellation-rate's concern, not this
 *   metric's -- conflating the two would penalize a seller twice for one
 *   failure and blur two distinct signals the AC asks for separately).
 * - Cancellation rate: all orders created in the window.
 * - Dispute rate: all orders created in the window, same denominator as
 *   cancellation rate (not the count of orders whose support request
 *   resolved in the window) -- bounding the denominator by resolution date
 *   instead would let a seller dilute the rate by driving order volume up
 *   without changing dispute count, since a busy window could out-run the
 *   resolutions that trail it.
 */
export async function refreshSellerBehavioralMetrics(
  db: PgQueryable,
  sellerAccountId: string,
  now: string,
  resolvePolicy?: ResolvePolicy,
): Promise<void> {
  const policyValue = resolvePolicy
    ? (await resolvePolicy(marketplaceSellerBehavioralMetricsPolicy, { at: now })).value
    : MARKETPLACE_SELLER_BEHAVIORAL_METRICS_LAUNCH_POLICY_VALUE;

  const ordersResult = await db.query<{
    orders_created_count: string;
    seller_cancelled_count: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE created_at >= $2::timestamptz - make_interval(days => $3))::int AS orders_created_count,
       COUNT(*) FILTER (
         WHERE created_at >= $2::timestamptz - make_interval(days => $3)
           AND cancellation_reason = $4
       )::int AS seller_cancelled_count
     FROM marketplace_seller_metrics_order_sources
     WHERE seller_account_id = $1`,
    [sellerAccountId, now, policyValue.windowDays, SELLER_CAUSED_CANCELLATION_REASON],
  );
  const orders = ordersResult.rows[0] ?? { orders_created_count: "0", seller_cancelled_count: "0" };

  const shipmentsResult = await db.query<{
    shipments_dispatched_count: string;
    shipments_on_time_count: string;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE s.dispatched_at IS NOT NULL
           AND s.dispatched_at >= $2::timestamptz - make_interval(days => $3)
       )::int AS shipments_dispatched_count,
       COUNT(*) FILTER (
         WHERE s.dispatched_at IS NOT NULL
           AND s.dispatched_at >= $2::timestamptz - make_interval(days => $3)
           AND o.ready_for_fulfillment_at IS NOT NULL
           AND s.dispatched_at <= o.ready_for_fulfillment_at + make_interval(hours => $4)
       )::int AS shipments_on_time_count
     FROM marketplace_seller_metrics_shipment_sources s
     LEFT JOIN marketplace_seller_metrics_order_sources o ON o.order_id = s.order_id
     WHERE s.seller_account_id = $1`,
    [sellerAccountId, now, policyValue.windowDays, policyValue.dispatchWindowHours],
  );
  const shipments = shipmentsResult.rows[0] ?? { shipments_dispatched_count: "0", shipments_on_time_count: "0" };

  // Dispute classification is a business-rule predicate (the shared,
  // already-reviewed review-eligibility resolution taxonomy), not a
  // timestamp comparison -- applied in TS against the small per-seller
  // window slice rather than duplicated as a second, driftable SQL
  // expression of the same rule.
  const supportResult = await db.query<{
    resolution_type: string | null;
    flow_type: string | null;
    resolved_at: string;
  }>(
    `SELECT resolution_type, flow_type, resolved_at::text AS resolved_at
     FROM marketplace_seller_metrics_support_request_sources
     WHERE seller_account_id = $1
       AND resolved_at IS NOT NULL
       AND resolved_at >= $2::timestamptz - make_interval(days => $3)`,
    [sellerAccountId, now, policyValue.windowDays],
  );
  const disputesResolvedCount = supportResult.rows.length;
  const disputesAgainstSellerCount = supportResult.rows.filter((row) =>
    isResolutionAgainstSeller({
      status: "resolved",
      resolutionType: row.resolution_type,
      flowType: row.flow_type,
      resolvedAt: row.resolved_at,
    } satisfies SupportRequestSnapshot),
  ).length;

  const ordersCreatedCount = Number(orders.orders_created_count);
  const sellerCancelledCount = Number(orders.seller_cancelled_count);
  const shipmentsDispatchedCount = Number(shipments.shipments_dispatched_count);
  const shipmentsOnTimeCount = Number(shipments.shipments_on_time_count);

  await db.query(
    `INSERT INTO marketplace_seller_metrics_summary_pages (
       seller_account_id,
       window_days,
       orders_created_count,
       seller_cancelled_count,
       cancellation_rate,
       shipments_dispatched_count,
       shipments_on_time_count,
       on_time_shipment_rate,
       disputes_resolved_count,
       disputes_against_seller_count,
       dispute_rate,
       computed_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
     ON CONFLICT (seller_account_id) DO UPDATE SET
       window_days = EXCLUDED.window_days,
       orders_created_count = EXCLUDED.orders_created_count,
       seller_cancelled_count = EXCLUDED.seller_cancelled_count,
       cancellation_rate = EXCLUDED.cancellation_rate,
       shipments_dispatched_count = EXCLUDED.shipments_dispatched_count,
       shipments_on_time_count = EXCLUDED.shipments_on_time_count,
       on_time_shipment_rate = EXCLUDED.on_time_shipment_rate,
       disputes_resolved_count = EXCLUDED.disputes_resolved_count,
       disputes_against_seller_count = EXCLUDED.disputes_against_seller_count,
       dispute_rate = EXCLUDED.dispute_rate,
       computed_at = EXCLUDED.computed_at,
       updated_at = EXCLUDED.updated_at`,
    [
      sellerAccountId,
      policyValue.windowDays,
      ordersCreatedCount,
      sellerCancelledCount,
      rate(sellerCancelledCount, ordersCreatedCount),
      shipmentsDispatchedCount,
      shipmentsOnTimeCount,
      rate(shipmentsOnTimeCount, shipmentsDispatchedCount),
      disputesResolvedCount,
      disputesAgainstSellerCount,
      rate(disputesAgainstSellerCount, ordersCreatedCount),
      now,
    ],
  );
}
