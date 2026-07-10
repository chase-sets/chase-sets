import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  SupportChecklistItem,
  SupportEvidence,
  SupportOffer,
  SupportResolution,
  SupportResponse,
} from "../domain/common";

export type SupportRequestListRow = Readonly<{
  support_request_id: string;
  order_id: string;
  buyer_account_id: string;
  seller_account_id: string;
  flow_type: string;
  status: string;
  priority: string;
  opened_by_account_id: string;
  opened_by_role: string;
  opened_at: string;
  updated_at: string;
  seller_response_due_at: string | null;
  support_review_due_at: string | null;
  seller_condition_attestation_due_at: string | null;
  order_return_context: unknown;
  return_investigation: unknown;
  checklist: readonly SupportChecklistItem[];
  pending_offer: SupportOffer | null;
  resolution: SupportResolution | null;
  closed_at: string | null;
  cancellation_reason: string | null;
  escalated_at: string | null;
  escalated_by_account_id: string | null;
  escalated_by_role: string | null;
  escalation_reason: string | null;
}>;

export type SupportRequestDetailRow = SupportRequestListRow &
  Readonly<{
    evidence: readonly SupportEvidence[];
    responses: readonly SupportResponse[];
    offers: readonly SupportOffer[];
  }>;

const listSelect = `
  SELECT
    support_request_id,
    order_id,
    buyer_account_id,
    seller_account_id,
    flow_type,
    status,
    priority,
    opened_by_account_id,
    opened_by_role,
    opened_at::text AS opened_at,
    updated_at::text AS updated_at,
    seller_response_due_at::text AS seller_response_due_at,
    support_review_due_at::text AS support_review_due_at,
    seller_condition_attestation_due_at::text AS seller_condition_attestation_due_at,
    order_return_context,
    return_investigation,
    checklist,
    pending_offer,
    resolution,
    closed_at::text AS closed_at,
    cancellation_reason,
    escalated_at::text AS escalated_at,
    escalated_by_account_id,
    escalated_by_role,
    escalation_reason
  FROM support_request_pages
`;

const detailSelect = `
  SELECT
    support_request_id,
    order_id,
    buyer_account_id,
    seller_account_id,
    flow_type,
    status,
    priority,
    opened_by_account_id,
    opened_by_role,
    opened_at::text AS opened_at,
    updated_at::text AS updated_at,
    seller_response_due_at::text AS seller_response_due_at,
    support_review_due_at::text AS support_review_due_at,
    seller_condition_attestation_due_at::text AS seller_condition_attestation_due_at,
    order_return_context,
    return_investigation,
    checklist,
    evidence,
    responses,
    offers,
    pending_offer,
    resolution,
    closed_at::text AS closed_at,
    cancellation_reason,
    escalated_at::text AS escalated_at,
    escalated_by_account_id,
    escalated_by_role,
    escalation_reason
  FROM support_request_pages
`;

function normalizePageParams(params: Readonly<{ limit?: number; offset?: number }>) {
  return {
    limit: Math.max(1, Math.min(params.limit ?? 50, 250)),
    offset: Math.max(0, params.offset ?? 0),
  };
}

export async function listBuyerSupportRequests(
  db: PgQueryable,
  params: Readonly<{ buyerAccountId: string; limit?: number; offset?: number }>,
): Promise<{ items: SupportRequestListRow[]; total: number }> {
  const { limit, offset } = normalizePageParams(params);
  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM support_request_pages
       WHERE buyer_account_id = $1`,
      [params.buyerAccountId],
    ),
    db.query<SupportRequestListRow>(
      `${listSelect}
       WHERE buyer_account_id = $1
       ORDER BY updated_at DESC, support_request_id DESC
       LIMIT $2 OFFSET $3`,
      [params.buyerAccountId, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function listSellerSupportRequests(
  db: PgQueryable,
  params: Readonly<{ sellerAccountId: string; limit?: number; offset?: number }>,
): Promise<{ items: SupportRequestListRow[]; total: number }> {
  const { limit, offset } = normalizePageParams(params);
  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM support_request_pages
       WHERE seller_account_id = $1`,
      [params.sellerAccountId],
    ),
    db.query<SupportRequestListRow>(
      `${listSelect}
       WHERE seller_account_id = $1
       ORDER BY updated_at DESC, support_request_id DESC
       LIMIT $2 OFFSET $3`,
      [params.sellerAccountId, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function listSupportOperationsQueue(
  db: PgQueryable,
  params: Readonly<{
    accountId?: string | null;
    now?: string;
    limit?: number;
    offset?: number;
  }>,
): Promise<{ items: SupportRequestListRow[]; total: number }> {
  const { limit, offset } = normalizePageParams(params);
  const now = params.now ?? new Date().toISOString();
  const accountFilter = params.accountId ? "AND (buyer_account_id = $2 OR seller_account_id = $2)" : "";
  const values = params.accountId ? [now, params.accountId] : [now];
  const limitParam = values.length + 1;
  const offsetParam = values.length + 2;
  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM support_request_pages
       WHERE status NOT IN ('resolved', 'closed', 'cancelled')
         ${accountFilter}
         AND (
           priority = 'urgent'
           OR seller_response_due_at <= $1::timestamptz
           OR support_review_due_at <= $1::timestamptz
           OR seller_condition_attestation_due_at <= $1::timestamptz
           OR status = 'ready-for-support'
         )`,
      values,
    ),
    db.query<SupportRequestListRow>(
      `${listSelect}
       WHERE status NOT IN ('resolved', 'closed', 'cancelled')
         ${accountFilter}
         AND (
           priority = 'urgent'
           OR seller_response_due_at <= $1::timestamptz
           OR support_review_due_at <= $1::timestamptz
           OR seller_condition_attestation_due_at <= $1::timestamptz
           OR status = 'ready-for-support'
         )
       ORDER BY
         CASE WHEN priority = 'urgent' THEN 0 ELSE 1 END,
         LEAST(
           COALESCE(seller_response_due_at, 'infinity'::timestamptz),
           COALESCE(support_review_due_at, 'infinity'::timestamptz),
           COALESCE(seller_condition_attestation_due_at, 'infinity'::timestamptz)
         ) ASC,
         updated_at ASC,
         support_request_id ASC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...values, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getAccountSupportRequest(
  db: PgQueryable,
  supportRequestId: string,
  accountId: string,
): Promise<SupportRequestDetailRow | null> {
  const result = await db.query<SupportRequestDetailRow>(
    `${detailSelect}
     WHERE support_request_id = $1
       AND (buyer_account_id = $2 OR seller_account_id = $2)`,
    [supportRequestId, accountId],
  );

  return result.rows[0] ?? null;
}

export async function getSupportOperationsRequest(
  db: PgQueryable,
  supportRequestId: string,
): Promise<SupportRequestDetailRow | null> {
  const result = await db.query<SupportRequestDetailRow>(
    `${detailSelect}
     WHERE support_request_id = $1`,
    [supportRequestId],
  );

  return result.rows[0] ?? null;
}

export async function findOpenSupportRequestForOrderAndFlow(
  db: PgQueryable,
  params: Readonly<{ orderId: string; flowType: string }>,
): Promise<Pick<SupportRequestDetailRow, "support_request_id"> | null> {
  const result = await db.query<{ support_request_id: string }>(
    `SELECT support_request_id
     FROM support_request_pages
     WHERE order_id = $1
       AND flow_type = $2
       AND status NOT IN ('resolved', 'closed', 'cancelled')
     ORDER BY opened_at ASC, support_request_id ASC
     LIMIT 1`,
    [params.orderId, params.flowType],
  );

  return result.rows[0] ?? null;
}
