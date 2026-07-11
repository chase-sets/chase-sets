import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type ReasonCount = { reason: string; count: number };
type ReportSummary = {
  reportId: string;
  reporterKind: string;
  reporterKey: string;
  reporterAccountId: string | null;
  reason: string;
  details: string | null;
  submittedAt: string;
};

function incrementReasonCounts(existing: unknown, reason: string): ReasonCount[] {
  const counts = new Map<string, number>();
  if (Array.isArray(existing)) {
    for (const entry of existing) {
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const key = String(record.reason ?? "").trim();
        const count = Number(record.count ?? 0);
        if (key) {
          counts.set(key, Math.max(0, count));
        }
      }
    }
  }
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ reason: key, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function normalizeReports(existing: unknown): ReportSummary[] {
  return Array.isArray(existing)
    ? existing
        .map((entry) => (entry && typeof entry === "object" ? (entry as ReportSummary) : null))
        .filter((entry): entry is ReportSummary => Boolean(entry?.reportId))
    : [];
}

function appendReport(existing: readonly ReportSummary[], report: ReportSummary): ReportSummary[] {
  if (existing.some((entry) => entry.reportId === report.reportId)) {
    return [...existing];
  }
  return [...existing, report].sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
}

export function buildMarketplaceReportedContentProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "marketplace.report.submitted": async (event) => {
      const data = event.data as {
        reportId: string;
        targetType: "listing" | "review";
        targetId: string;
        targetOwnerAccountId: string | null;
        reporterKind: string;
        reporterKey: string;
        reporterAccountId: string | null;
        reason: string;
        details: string | null;
        submittedAt: string;
      };
      const existing = await db.query<{ reasons: unknown; reports: unknown }>(
        `SELECT reasons, reports
         FROM platform_operations_reported_content_queue_pages
         WHERE target_type = $1 AND target_id = $2`,
        [data.targetType, data.targetId],
      );
      const row = existing.rows[0];
      const existingReports = normalizeReports(row?.reports);
      const isNewReport = !existingReports.some((entry) => entry.reportId === data.reportId);
      const reports = appendReport(existingReports, {
        reportId: data.reportId,
        reporterKind: data.reporterKind,
        reporterKey: data.reporterKey,
        reporterAccountId: data.reporterAccountId,
        reason: data.reason,
        details: data.details,
        submittedAt: data.submittedAt,
      });

      await db.query(
        `INSERT INTO platform_operations_reported_content_queue_pages (
           target_type,
           target_id,
           target_owner_account_id,
           status,
           report_count,
           reasons,
           reports,
           first_reported_at,
           last_reported_at,
           updated_at
         ) VALUES ($1, $2, $3, 'needs-review', $4, $5::jsonb, $6::jsonb, $7, $7, $8)
         ON CONFLICT (target_type, target_id) DO UPDATE SET
           target_owner_account_id = COALESCE(EXCLUDED.target_owner_account_id, platform_operations_reported_content_queue_pages.target_owner_account_id),
           report_count = EXCLUDED.report_count,
           reasons = EXCLUDED.reasons,
           reports = EXCLUDED.reports,
           last_reported_at = GREATEST(platform_operations_reported_content_queue_pages.last_reported_at, EXCLUDED.last_reported_at),
           updated_at = EXCLUDED.updated_at`,
        [
          data.targetType,
          data.targetId,
          data.targetOwnerAccountId,
          reports.length,
          JSON.stringify(isNewReport ? incrementReasonCounts(row?.reasons, data.reason) : (row?.reasons ?? [])),
          JSON.stringify(reports),
          data.submittedAt,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.auto-unlisted": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const data = event.data as {
        reportId: string;
        threshold: number;
        autoUnlistedAt: string;
      };

      await db.query(
        `UPDATE platform_operations_reported_content_queue_pages
         SET status = 'auto-unlisted',
             auto_unlisted_at = $2,
             auto_unlist_report_id = $3,
             auto_unlist_threshold = $4,
             updated_at = $5
         WHERE target_type = 'listing'
           AND target_id = $1`,
        [listingId, data.autoUnlistedAt, data.reportId, data.threshold, event.timing.recordedAt],
      );
    },
  };
}

export function buildPlatformOperationsReportedContentProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "platform-operations.reported-content.action-recorded": async (event) => {
      const data = event.data as {
        targetType: string;
        targetId: string;
        action: string;
        note: string | null;
        operatorUserId: string | null;
        recordedAt: string;
      };
      const statusByAction: Record<string, string> = {
        dismiss: "dismissed",
        "contact-seller": "seller-contact-requested",
        unlist: "manually-unlisted",
        "escalate-account-suspension": "suspension-escalated",
        "withdraw-review": "review-withdrawn",
        "redact-review-feedback": "review-feedback-redacted",
        "withdraw-review-reply": "review-reply-withdrawn",
      };
      const status = statusByAction[data.action];
      if (!status) {
        return;
      }

      await db.query(
        `UPDATE platform_operations_reported_content_queue_pages
         SET status = $3,
             last_action = $4,
             last_action_at = $5,
             last_action_note = $6,
             last_action_by_user_id = $7,
             updated_at = $5
         WHERE target_type = $1
           AND target_id = $2`,
        [data.targetType, data.targetId, status, data.action, data.recordedAt, data.note, data.operatorUserId],
      );
    },
  };
}

export function buildReportedContentProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    ...buildMarketplaceReportedContentProjectionHandlers(db),
    ...buildPlatformOperationsReportedContentProjectionHandlers(db),
  };
}
