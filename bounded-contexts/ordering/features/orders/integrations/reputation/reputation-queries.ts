import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type OrderingOrderReviewOpportunity = Readonly<{
  order_id: string;
  subject_account_id: string;
  subject_display_name: string | null;
  author_role: string;
  eligible_at: string;
  active_review_id: string | null;
}>;

export async function getOrderingOrderReviewOpportunity(
  db: PgQueryable,
  params: Readonly<{
    orderId: string;
    authorAccountId: string;
  }>,
): Promise<OrderingOrderReviewOpportunity | null> {
  const result = await db.query<OrderingOrderReviewOpportunity>(
    `SELECT
       eligibility.order_id,
       eligibility.subject_account_id,
       subject.display_name AS subject_display_name,
       eligibility.author_role,
       eligibility.eligible_at::text AS eligible_at,
       active.review_id AS active_review_id
     FROM ordering_order_review_eligibility_pages AS eligibility
     INNER JOIN ordering_order_pages AS order_page
       ON order_page.order_id = eligibility.order_id
     LEFT JOIN ordering_account_pages AS subject
       ON subject.account_id = eligibility.subject_account_id
     LEFT JOIN ordering_order_review_pages AS active
       ON active.order_id = eligibility.order_id
      AND active.author_account_id = eligibility.author_account_id
      AND active.subject_account_id = eligibility.subject_account_id
      AND active.status = 'active'
     WHERE eligibility.order_id = $1
       AND eligibility.author_account_id = $2
       AND (
         (
           eligibility.author_role = 'buyer'
           AND order_page.buyer_account_id = eligibility.author_account_id
           AND order_page.seller_account_id = eligibility.subject_account_id
         )
         OR (
           eligibility.author_role = 'seller'
           AND order_page.seller_account_id = eligibility.author_account_id
           AND order_page.buyer_account_id = eligibility.subject_account_id
         )
       )`,
    [params.orderId, params.authorAccountId],
  );

  return result.rows[0] ?? null;
}
