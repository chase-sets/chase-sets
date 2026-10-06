import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { isReviewOpportunityChangedV1 } from "@chase-sets/event-core/review-opportunity-facts";

export type OrderingOrderDeliverySummary = Readonly<{
  shipment_count: number;
  delivered_count: number;
  latest_delivered_at: string | null;
}>;

export async function getOrderingOrderDeliverySummary(
  db: PgQueryable,
  orderId: string,
): Promise<OrderingOrderDeliverySummary> {
  const result = await db.query<OrderingOrderDeliverySummary>(
    `SELECT
       COUNT(*)::integer AS shipment_count,
       COUNT(*) FILTER (WHERE status = 'delivered')::integer AS delivered_count,
       MAX(delivered_at)::text AS latest_delivered_at
     FROM ordering_order_review_shipment_sources
     WHERE order_id = $1`,
    [orderId],
  );
  return result.rows[0]!;
}

export type OrderingOrderReviewOpportunity = Readonly<{
  order_id: string;
  subject_account_id: string;
  subject_display_name: string | null;
  author_role: string;
  eligible_at: string;
  active_review_id: string | null;
  active_review_revealed_at: string | null;
  window_expires_at: string;
  submission_state: "allowed" | "held" | "expired";
  hold_reason: "feedback-on-hold" | null;
  window_expired: boolean;
  revealed: boolean;
}>;

export type OrderingOrderReviewOutcome =
  | Readonly<{ status: "ready"; opportunity: OrderingOrderReviewOpportunity | null }>
  | Readonly<{ status: "unavailable"; opportunity: null }>;

type OpportunityRow = {
  fact: unknown;
  valid: boolean;
  buyer_account_id: string;
  seller_account_id: string;
  subject_display_name: string | null;
  source_positions: Record<string, string> | null;
  current: boolean;
};

export function orderReviewOutcome(
  row: OpportunityRow | undefined,
  accountId: string,
  now: Date,
): OrderingOrderReviewOutcome {
  const unavailable = { status: "unavailable", opportunity: null } as const;
  if (!row || !row.valid || !row.current || !isReviewOpportunityChangedV1(row.fact)) return unavailable;
  const fact = row.fact;
  if (fact.buyerAccountId !== row.buyer_account_id || fact.sellerAccountId !== row.seller_account_id)
    return unavailable;
  const role = accountId === fact.buyerAccountId ? "buyer" : accountId === fact.sellerAccountId ? "seller" : null;
  if (!role) return unavailable;
  for (const [source, position] of Object.entries(row.source_positions ?? {})) {
    const key = source === "platform-operations" ? "support" : source;
    if (!(key in fact.provenance) || BigInt(position) > BigInt(fact.provenance[key as keyof typeof fact.provenance]))
      return unavailable;
  }
  const slot = role === "buyer" ? fact.buyerToSeller : fact.sellerToBuyer;
  if (!slot) return { status: "ready", opportunity: null };
  const held = slot.held || slot.submissionState === "held";
  const revealed = !held && slot.activeReviewRevealedAt !== null;
  const expired =
    !held &&
    !revealed &&
    slot.activeReviewId === null &&
    (slot.submissionState === "expired" || now.getTime() >= Date.parse(slot.effectiveDeadlineAt));
  return {
    status: "ready",
    opportunity: {
      order_id: fact.orderId,
      subject_account_id: role === "buyer" ? fact.sellerAccountId : fact.buyerAccountId,
      subject_display_name: row.subject_display_name,
      author_role: role,
      eligible_at: slot.eligibleAt,
      active_review_id: slot.activeReviewId,
      active_review_revealed_at: slot.activeReviewRevealedAt,
      window_expires_at: slot.effectiveDeadlineAt,
      submission_state: held ? "held" : expired ? "expired" : "allowed",
      hold_reason: held ? "feedback-on-hold" : null,
      window_expired: expired,
      revealed,
    },
  };
}

export async function getOrderingOrderReviewOpportunity(
  db: PgQueryable,
  params: Readonly<{
    orderId: string;
    authorAccountId: string;
    now?: Date;
  }>,
): Promise<OrderingOrderReviewOutcome> {
  const result = await db.query<OpportunityRow>(
    `SELECT opportunity.fact, opportunity.valid, order_page.buyer_account_id, order_page.seller_account_id,
       subject.display_name AS subject_display_name,
       (SELECT jsonb_object_agg(source_context_name, source_position::text)
          FROM ordering_order_review_opportunity_sources WHERE order_id = $1) AS source_positions,
       (EXISTS (SELECT 1 FROM event_projection_group_generations AS generation
         WHERE generation.target_context_name = 'ordering'
           AND generation.projection_name = 'ordering-order-review-opportunity-projection'
           AND generation.state = 'active')
        AND EXISTS (SELECT 1 FROM event_projection_group_revisions AS revision
          WHERE revision.target_context_name = 'ordering' AND revision.projection_name = 'ordering-order-review-opportunity-projection'
            AND revision.projection_revision = 2)
        AND (SELECT COUNT(*) = 4 FROM event_subscription_checkpoints AS checkpoint
          JOIN event_projection_recovery_markers AS recovery ON recovery.projection_kind = 'subscription'
            AND recovery.projection_key = checkpoint.checkpoint_key
            AND recovery.last_global_position >= checkpoint.last_global_position
          WHERE checkpoint.projection_name = 'ordering-order-review-opportunity-projection'
            AND checkpoint.subscription_version = 2
            AND checkpoint.source_context_name IN ('ordering', 'fulfillment', 'platform-operations', 'marketplace')
            AND (checkpoint.source_context_name <> 'marketplace' OR checkpoint.last_global_position >= opportunity.source_position)
            AND NOT EXISTS (SELECT 1 FROM event_projection_blocked_streams AS blocked
              WHERE blocked.projection_key = checkpoint.checkpoint_key))) AS current
     FROM ordering_order_pages AS order_page
     JOIN ordering_order_review_opportunity_pages AS opportunity ON opportunity.order_id = order_page.order_id
     LEFT JOIN ordering_account_pages AS subject ON subject.account_id = CASE
       WHEN order_page.buyer_account_id = $2 THEN order_page.seller_account_id ELSE order_page.buyer_account_id END
     WHERE order_page.order_id = $1 AND $2 IN (order_page.buyer_account_id, order_page.seller_account_id)`,
    [params.orderId, params.authorAccountId],
  );

  return orderReviewOutcome(result.rows[0], params.authorAccountId, params.now ?? new Date());
}
