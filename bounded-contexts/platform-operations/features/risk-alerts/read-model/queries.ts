import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { RiskAlertQueueDetail, RiskAlertQueueItem, RiskAlertQueueMetrics } from "../api/contracts";

function pageParams(params: Readonly<{ limit?: number; offset?: number }>) {
  return {
    limit: Math.max(1, Math.min(params.limit ?? 50, 250)),
    offset: Math.max(0, params.offset ?? 0),
  };
}

function filters(params: Readonly<{ status?: string | null; alertKind?: string | null }>) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (params.status && params.status !== "all") {
    values.push(params.status);
    clauses.push(`status = $${values.length}`);
  }
  if (params.alertKind && params.alertKind !== "all") {
    values.push(params.alertKind);
    clauses.push(`alert_kind = $${values.length}`);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

const selectColumns = `
  alert_id,
  account_id,
  alert_kind,
  status,
  severity,
  manual_payout_review_candidate,
  evidence,
  threshold,
  first_triggered_at::text AS first_triggered_at,
  last_triggered_at::text AS last_triggered_at,
  last_action,
  last_action_at::text AS last_action_at,
  last_action_note,
  last_action_by_user_id,
  updated_at::text AS updated_at
`;

export async function listRiskAlertQueue(
  db: PgQueryable,
  params: Readonly<{ limit?: number; offset?: number; status?: string | null; alertKind?: string | null }>,
): Promise<{ items: RiskAlertQueueItem[]; total: number }> {
  const { limit, offset } = pageParams(params);
  const queryFilters = filters(params);
  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM platform_operations_risk_alert_queue_pages
     ${queryFilters.where}`,
    queryFilters.values,
  );
  const itemsResult = await db.query<RiskAlertQueueItem>(
    `SELECT ${selectColumns}
     FROM platform_operations_risk_alert_queue_pages
     ${queryFilters.where}
     ORDER BY
       CASE WHEN status = 'needs-review' THEN 0 ELSE 1 END,
       CASE WHEN severity = 'high' THEN 0 ELSE 1 END,
       last_triggered_at DESC,
       alert_id ASC
     LIMIT $${queryFilters.values.length + 1} OFFSET $${queryFilters.values.length + 2}`,
    [...queryFilters.values, limit, offset],
  );
  return { items: itemsResult.rows, total: Number(countResult.rows[0]?.count ?? 0) };
}

export async function getRiskAlertQueueItem(db: PgQueryable, alertId: string): Promise<RiskAlertQueueDetail | null> {
  const result = await db.query<RiskAlertQueueDetail>(
    `SELECT ${selectColumns}
     FROM platform_operations_risk_alert_queue_pages
     WHERE alert_id = $1`,
    [alertId],
  );
  return result.rows[0] ?? null;
}

export async function getRiskAlertQueueMetrics(db: PgQueryable): Promise<RiskAlertQueueMetrics> {
  const result = await db.query<{
    total_count: string;
    needs_review_count: string;
    manual_payout_review_candidate_count: string;
  }>(
    `SELECT
       COUNT(*) AS total_count,
       COUNT(*) FILTER (WHERE status = 'needs-review') AS needs_review_count,
       COUNT(*) FILTER (WHERE manual_payout_review_candidate = TRUE) AS manual_payout_review_candidate_count
     FROM platform_operations_risk_alert_queue_pages`,
  );
  const row = result.rows[0];
  return {
    total_count: Number(row?.total_count ?? 0),
    needs_review_count: Number(row?.needs_review_count ?? 0),
    manual_payout_review_candidate_count: Number(row?.manual_payout_review_candidate_count ?? 0),
  };
}
