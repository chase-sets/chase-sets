import { escapeLikePattern, type PgQueryable } from "@chase-sets/event-core-postgres";
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
  affected_line_items?: unknown;
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
  return_refund_gate_status: string | null;
  return_delivered_at: string | null;
  return_refund_release_due_at: string | null;
  return_condition_disputed_at: string | null;
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
    affected_line_items,
    return_investigation,
    checklist,
    pending_offer,
    resolution,
    closed_at::text AS closed_at,
    cancellation_reason,
    escalated_at::text AS escalated_at,
    escalated_by_account_id,
    escalated_by_role,
    escalation_reason,
    return_refund_gate_status,
    return_delivered_at::text AS return_delivered_at,
    return_refund_release_due_at::text AS return_refund_release_due_at,
    return_condition_disputed_at::text AS return_condition_disputed_at
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
    affected_line_items,
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
    escalation_reason,
    return_refund_gate_status,
    return_delivered_at::text AS return_delivered_at,
    return_refund_release_due_at::text AS return_refund_release_due_at,
    return_condition_disputed_at::text AS return_condition_disputed_at
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

const SUPPORT_OPERATIONS_QUEUE_STATUSES = new Set([
  "open",
  "waiting-on-buyer",
  "waiting-on-seller",
  "ready-for-support",
  "resolved",
  "closed",
  "cancelled",
]);
const SUPPORT_OPERATIONS_QUEUE_PRIORITIES = new Set(["normal", "urgent"]);

export async function listSupportOperationsQueue(
  db: PgQueryable,
  params: Readonly<{
    accountId?: string | null;
    now?: string;
    limit?: number;
    offset?: number;
    status?: string;
    priority?: string;
    search?: string;
  }>,
): Promise<{ items: SupportRequestListRow[]; total: number }> {
  const { limit, offset } = normalizePageParams(params);
  const now = params.now ?? new Date().toISOString();
  const values: unknown[] = [now];
  const conditions: string[] = [];

  if (params.accountId) {
    values.push(params.accountId);
    conditions.push(`(buyer_account_id = $${values.length} OR seller_account_id = $${values.length})`);
  }

  const status = params.status && SUPPORT_OPERATIONS_QUEUE_STATUSES.has(params.status) ? params.status : null;
  if (status) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }

  const priority = params.priority && SUPPORT_OPERATIONS_QUEUE_PRIORITIES.has(params.priority) ? params.priority : null;
  if (priority) {
    values.push(priority);
    conditions.push(`priority = $${values.length}`);
  }

  const search = params.search?.trim() ? params.search.trim() : null;
  if (search) {
    values.push(`%${escapeLikePattern(search)}%`);
    conditions.push(`(
        support_request_id ILIKE $${values.length} ESCAPE '\\'
        OR order_id ILIKE $${values.length} ESCAPE '\\'
        OR buyer_account_id ILIKE $${values.length} ESCAPE '\\'
        OR seller_account_id ILIKE $${values.length} ESCAPE '\\'
      )`);
  }

  const extraFilterSql = conditions.map((condition) => `AND ${condition}`).join("\n       ");
  const limitParam = values.length + 1;
  const offsetParam = values.length + 2;
  // A resolved (even closed) `return-for-refund` case whose seller disputed
  // the returned item's condition stays in the queue: the refund is stuck
  // until an operator releases or otherwise adjudicates it, and that state
  // has no further automatic deadline.
  const activeStatusPredicate = `(
    (status NOT IN ('resolved', 'closed', 'cancelled')
      AND (
        priority = 'urgent'
        OR seller_response_due_at <= $1::timestamptz
        OR support_review_due_at <= $1::timestamptz
        OR seller_condition_attestation_due_at <= $1::timestamptz
        OR status = 'ready-for-support'
      ))
    OR return_refund_gate_status = 'return-condition-disputed'
  )`;
  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM support_request_pages
       WHERE ${activeStatusPredicate}
         ${extraFilterSql}`,
      values,
    ),
    db.query<SupportRequestListRow>(
      `${listSelect}
       WHERE ${activeStatusPredicate}
         ${extraFilterSql}
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

export type SupportRequestSweepCandidateRow = Readonly<{
  support_request_id: string;
  flow_type: string;
  opened_at: string;
  /**
   * The stamped seller-response deadline, present only on rows returned by
   * queries that select it (`listSupportRequestsPastSellerResponseDeadline`,
   * `listSupportRequestsNeedingResponseReminder`). The sweep derives
   * halfway/window-elapsed timing from this stamped value rather than
   * re-reading the flow's compiled or policy-resolved hours, so a support
   * deadline policy revision never desyncs reminder timing from the deadline
   * that was actually stamped on this request at open time.
   */
  seller_response_due_at?: string | null;
}>;

export type SupportRequestReviewReminderCandidateRow = Readonly<{
  support_request_id: string;
  flow_type: string;
  opened_at: string;
  support_review_due_at: string;
}>;

function normalizeSweepLimit(limit: number | undefined) {
  return Math.max(1, Math.min(limit ?? 100, 500));
}

/**
 * Cases still `waiting-on-seller` whose seller-response deadline has passed:
 * the deadline sweep's silence candidates.
 */
export async function listSupportRequestsPastSellerResponseDeadline(
  db: PgQueryable,
  params: Readonly<{ now: string; limit?: number }>,
): Promise<readonly SupportRequestSweepCandidateRow[]> {
  const result = await db.query<SupportRequestSweepCandidateRow>(
    `SELECT support_request_id, flow_type, opened_at::text AS opened_at,
            seller_response_due_at::text AS seller_response_due_at
     FROM support_request_pages
     WHERE status = 'waiting-on-seller'
       AND seller_response_due_at IS NOT NULL
       AND seller_response_due_at <= $1::timestamptz
     ORDER BY seller_response_due_at ASC, support_request_id ASC
     LIMIT $2`,
    [params.now, normalizeSweepLimit(params.limit)],
  );
  return result.rows;
}

/**
 * Cases still `waiting-on-seller`, not yet at their deadline, that have not
 * been reminded yet. The caller derives the halfway threshold from the
 * stamped `opened_at` and `seller_response_due_at` (never a live or
 * catalog-compiled hour count), so the reminder timing always matches the
 * deadline that was actually resolved and stamped on this request at open
 * time, regardless of later support-deadline policy revisions.
 */
export async function listSupportRequestsNeedingResponseReminder(
  db: PgQueryable,
  params: Readonly<{ now: string; limit?: number }>,
): Promise<readonly SupportRequestSweepCandidateRow[]> {
  const result = await db.query<SupportRequestSweepCandidateRow>(
    `SELECT support_request_id, flow_type, opened_at::text AS opened_at,
            seller_response_due_at::text AS seller_response_due_at
     FROM support_request_pages
     WHERE status = 'waiting-on-seller'
       AND seller_response_reminder_sent_at IS NULL
       AND seller_response_due_at IS NOT NULL
       AND seller_response_due_at > $1::timestamptz
     ORDER BY seller_response_due_at ASC, support_request_id ASC
     LIMIT $2`,
    [params.now, normalizeSweepLimit(params.limit)],
  );
  return result.rows;
}

/**
 * Cases `ready-for-support`, not yet at their support-review deadline, that
 * have not been reminded yet. The caller derives the approaching threshold
 * from the stamped `opened_at` and `support_review_due_at` for the same
 * stamped-deadline reason as the response-reminder query above.
 */
export async function listSupportRequestsNeedingReviewReminder(
  db: PgQueryable,
  params: Readonly<{ now: string; limit?: number }>,
): Promise<readonly SupportRequestReviewReminderCandidateRow[]> {
  const result = await db.query<SupportRequestReviewReminderCandidateRow>(
    `SELECT support_request_id, flow_type, opened_at::text AS opened_at,
            support_review_due_at::text AS support_review_due_at
     FROM support_request_pages
     WHERE status = 'ready-for-support'
       AND support_review_reminder_sent_at IS NULL
       AND support_review_due_at IS NOT NULL
       AND support_review_due_at > $1::timestamptz
     ORDER BY support_review_due_at ASC, support_request_id ASC
     LIMIT $2`,
    [params.now, normalizeSweepLimit(params.limit)],
  );
  return result.rows;
}

/**
 * Open cases outside `waiting-on-seller` (contested/open/waiting-on-buyer)
 * whose seller-response or support-review deadline has passed. These
 * escalate rather than auto-resolve because the sweep cannot safely infer an
 * outcome once a case has diverged from the silence path.
 */
export async function listSupportRequestsOverdueForEscalation(
  db: PgQueryable,
  params: Readonly<{ now: string; limit?: number }>,
): Promise<readonly Pick<SupportRequestSweepCandidateRow, "support_request_id">[]> {
  const result = await db.query<Pick<SupportRequestSweepCandidateRow, "support_request_id">>(
    `SELECT support_request_id
     FROM support_request_pages
     WHERE status NOT IN ('waiting-on-seller', 'ready-for-support', 'resolved', 'closed', 'cancelled')
       AND (
         seller_response_due_at <= $1::timestamptz
         OR support_review_due_at <= $1::timestamptz
       )
     ORDER BY
       LEAST(
         COALESCE(seller_response_due_at, 'infinity'::timestamptz),
         COALESCE(support_review_due_at, 'infinity'::timestamptz)
       ) ASC,
       support_request_id ASC
     LIMIT $2`,
    [params.now, normalizeSweepLimit(params.limit)],
  );
  return result.rows;
}

/** Resolved cases whose 7-day auto-close clock has elapsed. */
export async function listSupportRequestsReadyForAutoClose(
  db: PgQueryable,
  params: Readonly<{ now: string; limit?: number }>,
): Promise<readonly Pick<SupportRequestSweepCandidateRow, "support_request_id">[]> {
  const result = await db.query<Pick<SupportRequestSweepCandidateRow, "support_request_id">>(
    `SELECT support_request_id
     FROM support_request_pages
     WHERE status = 'resolved'
       AND auto_close_due_at IS NOT NULL
       AND auto_close_due_at <= $1::timestamptz
     ORDER BY auto_close_due_at ASC, support_request_id ASC
     LIMIT $2`,
    [params.now, normalizeSweepLimit(params.limit)],
  );
  return result.rows;
}

/**
 * `return-for-refund` cases whose returned item was delivered back and whose
 * 5-day inspection window has elapsed with no seller condition dispute: the
 * deadline sweep's return-refund auto-release candidates.
 */
export async function listSupportRequestsReadyForReturnRefundRelease(
  db: PgQueryable,
  params: Readonly<{ now: string; limit?: number }>,
): Promise<readonly Pick<SupportRequestSweepCandidateRow, "support_request_id">[]> {
  const result = await db.query<Pick<SupportRequestSweepCandidateRow, "support_request_id">>(
    `SELECT support_request_id
     FROM support_request_pages
     WHERE return_refund_gate_status = 'awaiting-return-inspection'
       AND return_refund_release_due_at IS NOT NULL
       AND return_refund_release_due_at <= $1::timestamptz
     ORDER BY return_refund_release_due_at ASC, support_request_id ASC
     LIMIT $2`,
    [params.now, normalizeSweepLimit(params.limit)],
  );
  return result.rows;
}

/**
 * `return-for-refund` cases whose returned item has never been recorded as
 * delivered back. There is no deadline for this state (the issue does not
 * specify a never-arrives fallback), so this query is the operator-visible
 * surface support tooling uses to find and manually follow up on them.
 */
export async function listSupportRequestsAwaitingReturnDelivery(
  db: PgQueryable,
  params: Readonly<{ limit?: number; offset?: number }>,
): Promise<{ items: SupportRequestListRow[]; total: number }> {
  const { limit, offset } = normalizePageParams(params);
  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM support_request_pages
       WHERE return_refund_gate_status = 'awaiting-return-delivery'`,
    ),
    db.query<SupportRequestListRow>(
      `${listSelect}
       WHERE return_refund_gate_status = 'awaiting-return-delivery'
       ORDER BY updated_at ASC, support_request_id ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
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
