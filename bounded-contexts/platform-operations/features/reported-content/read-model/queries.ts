import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  ReportedContentQueueDetail,
  ReportedContentQueueItem,
  ReportedContentQueueMetrics,
} from "../api/contracts";

function normalizePageParams(params: Readonly<{ limit?: number; offset?: number }>) {
  return {
    limit: Math.max(1, Math.min(params.limit ?? 50, 250)),
    offset: Math.max(0, params.offset ?? 0),
  };
}

function queueFilters(params: Readonly<{ status?: string | null; targetType?: string | null }>) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (params.status && params.status !== "all") {
    values.push(params.status);
    clauses.push(`status = $${values.length}`);
  }
  if (params.targetType && params.targetType !== "all") {
    values.push(params.targetType);
    clauses.push(`target_type = $${values.length}`);
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

const selectColumns = `
  target_type,
  target_id,
  target_owner_account_id,
  status,
  report_count,
  reasons,
  reports,
  first_reported_at::text AS first_reported_at,
  last_reported_at::text AS last_reported_at,
  auto_unlisted_at::text AS auto_unlisted_at,
  auto_unlist_report_id,
  auto_unlist_threshold,
  last_action,
  last_action_at::text AS last_action_at,
  last_action_note,
  last_action_by_user_id,
  updated_at::text AS updated_at
`;

export async function listReportedContentQueue(
  db: PgQueryable,
  params: Readonly<{
    limit?: number;
    offset?: number;
    status?: string | null;
    targetType?: string | null;
  }>,
): Promise<{ items: ReportedContentQueueItem[]; total: number }> {
  const { limit, offset } = normalizePageParams(params);
  const filters = queueFilters(params);
  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM platform_operations_reported_content_queue_pages
     ${filters.where}`,
    filters.values,
  );
  const itemsResult = await db.query<ReportedContentQueueItem>(
    `SELECT ${selectColumns}
     FROM platform_operations_reported_content_queue_pages
     ${filters.where}
     ORDER BY
       CASE WHEN status = 'auto-unlisted' THEN 0 ELSE 1 END,
       report_count DESC,
       last_reported_at DESC,
       target_id ASC
     LIMIT $${filters.values.length + 1} OFFSET $${filters.values.length + 2}`,
    [...filters.values, limit, offset],
  );

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getReportedContentQueueItem(
  db: PgQueryable,
  targetType: string,
  targetId: string,
): Promise<ReportedContentQueueDetail | null> {
  const result = await db.query<ReportedContentQueueDetail>(
    `SELECT ${selectColumns}
     FROM platform_operations_reported_content_queue_pages
     WHERE target_type = $1
       AND target_id = $2`,
    [targetType, targetId],
  );

  return result.rows[0] ?? null;
}

export async function getReportedContentQueueMetrics(db: PgQueryable): Promise<ReportedContentQueueMetrics> {
  const result = await db.query<{
    total_count: string;
    needs_review_count: string;
    auto_unlisted_count: string;
  }>(
    `SELECT
       COUNT(*) AS total_count,
       COUNT(*) FILTER (WHERE status = 'needs-review') AS needs_review_count,
       COUNT(*) FILTER (WHERE status = 'auto-unlisted') AS auto_unlisted_count
     FROM platform_operations_reported_content_queue_pages`,
  );
  const row = result.rows[0];

  return {
    total_count: Number(row?.total_count ?? 0),
    needs_review_count: Number(row?.needs_review_count ?? 0),
    auto_unlisted_count: Number(row?.auto_unlisted_count ?? 0),
  };
}
