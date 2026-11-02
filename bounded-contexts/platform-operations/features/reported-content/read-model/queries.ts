import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  ReportedContentQueueDetail,
  ReportedContentQueueItem,
  ReportedContentQueueMetrics,
  ReportedContentReportSummary,
} from "../api/contracts";

// A row with no projected report is an action that arrived before its report (cross-source
// replay order); it holds the action until the report lands and is never a queue item.
const queuedRow = "report_count > 0";

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
    where: `WHERE ${[queuedRow, ...clauses].join(" AND ")}`,
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
  const result = await db.query<ReportedContentQueueItem & { reports: unknown }>(
    `SELECT ${selectColumns}, reports
     FROM platform_operations_reported_content_queue_pages
     WHERE target_type = $1
       AND target_id = $2
       AND ${queuedRow}`,
    [targetType, targetId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const { reports, ...item } = row;
  const stored = Array.isArray(reports) ? (reports as readonly StoredReport[]) : [];
  return {
    ...item,
    reports: stored.map(
      (report): ReportedContentReportSummary => ({
        reportId: report.reportId,
        reporterKind: report.reporterKind,
        reason: report.reason,
        details: report.details,
        submittedAt: report.submittedAt,
      }),
    ),
    distinct_reporter_count: new Set(stored.map((report) => report.reporterKey)).size,
  };
}

/** The action precondition: a target is actionable only once a report has queued it. */
export async function isReportedContentTargetQueued(
  db: PgQueryable,
  targetType: string,
  targetId: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
     FROM platform_operations_reported_content_queue_pages
     WHERE target_type = $1
       AND target_id = $2
       AND ${queuedRow}`,
    [targetType, targetId],
  );

  return result.rows.length > 0;
}

/** The projection-owned stored report; its reporter key and account never leave this module. */
type StoredReport = ReportedContentReportSummary & Readonly<{ reporterKey: string }>;

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
     FROM platform_operations_reported_content_queue_pages
     WHERE ${queuedRow}`,
  );
  const row = result.rows[0];

  return {
    total_count: Number(row?.total_count ?? 0),
    needs_review_count: Number(row?.needs_review_count ?? 0),
    auto_unlisted_count: Number(row?.auto_unlisted_count ?? 0),
  };
}
