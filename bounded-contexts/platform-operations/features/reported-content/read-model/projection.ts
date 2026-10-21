import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  parseIdentityAccountProfileReportSubmittedPayload,
  parseMarketplaceListingAutoUnlistedPayload,
  parseMarketplaceListingOperatorUnlistedPayload,
  parseMarketplaceReportSubmittedPayload,
  parsePlatformOperationsReportedContentActionRecordedPayload,
} from "@chase-sets/event-core";
import { REPORTED_CONTENT_STATUS_BY_ACTION, type ReportedContentTargetType } from "../api/contracts";

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

/**
 * Queues one report against its target. Redelivery of a known report id changes nothing but
 * the update time, and a re-report never changes the queue status. A row that so far holds
 * only an early-delivered action takes its report times from its first report.
 */
async function projectReport(
  db: PgQueryable,
  target: Readonly<{ targetType: ReportedContentTargetType; targetId: string; ownerAccountId: string | null }>,
  report: ReportSummary,
  recordedAt: string,
) {
  const existing = await db.query<{ reasons: unknown; reports: unknown }>(
    `SELECT reasons, reports
     FROM platform_operations_reported_content_queue_pages
     WHERE target_type = $1 AND target_id = $2`,
    [target.targetType, target.targetId],
  );
  const row = existing.rows[0];
  const existingReports = normalizeReports(row?.reports);
  const isNewReport = !existingReports.some((entry) => entry.reportId === report.reportId);
  const reports = appendReport(existingReports, report);

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
       first_reported_at = CASE
         WHEN platform_operations_reported_content_queue_pages.report_count = 0 THEN EXCLUDED.first_reported_at
         ELSE platform_operations_reported_content_queue_pages.first_reported_at
       END,
       last_reported_at = CASE
         WHEN platform_operations_reported_content_queue_pages.report_count = 0 THEN EXCLUDED.last_reported_at
         ELSE GREATEST(platform_operations_reported_content_queue_pages.last_reported_at, EXCLUDED.last_reported_at)
       END,
       updated_at = GREATEST(platform_operations_reported_content_queue_pages.updated_at, EXCLUDED.updated_at)`,
    [
      target.targetType,
      target.targetId,
      target.ownerAccountId,
      reports.length,
      JSON.stringify(isNewReport ? incrementReasonCounts(row?.reasons, report.reason) : (row?.reasons ?? [])),
      JSON.stringify(reports),
      report.submittedAt,
      recordedAt,
    ],
  );
}

export function buildMarketplaceReportedContentProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "marketplace.report.submitted": async (event) => {
      const data = parseMarketplaceReportSubmittedPayload(event.data);
      await projectReport(
        db,
        { targetType: data.targetType, targetId: data.targetId, ownerAccountId: data.targetOwnerAccountId },
        {
          reportId: data.reportId,
          reporterKind: data.reporterKind,
          reporterKey: data.reporterKey,
          reporterAccountId: data.reporterAccountId,
          reason: data.reason,
          details: data.details,
          submittedAt: data.submittedAt,
        },
        event.timing.recordedAt,
      );
    },
    "marketplace.listing.operator-unlisted": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const { listingEnforcement } = parseMarketplaceListingOperatorUnlistedPayload(event.data);
      await db.query(
        `UPDATE platform_operations_reported_content_queue_pages
         SET status = 'manually-unlisted',
             updated_at = GREATEST(updated_at, $2::timestamptz)
         WHERE target_type = 'listing'
           AND target_id = $1
           AND (last_action_at IS NULL OR last_action_at <= $2::timestamptz)`,
        [listingId, listingEnforcement.occurredAt],
      );
    },
    "marketplace.listing.auto-unlisted": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const data = parseMarketplaceListingAutoUnlistedPayload(event.data);

      // Provenance always records; the status yields to an operator action recorded later.
      await db.query(
        `UPDATE platform_operations_reported_content_queue_pages
         SET status = CASE
               WHEN last_action_at IS NULL OR last_action_at <= $2::timestamptz THEN 'auto-unlisted'
               ELSE status
             END,
             auto_unlisted_at = $2,
             auto_unlist_report_id = $3,
             auto_unlist_threshold = $4,
             updated_at = GREATEST(updated_at, $5::timestamptz)
         WHERE target_type = 'listing'
           AND target_id = $1`,
        [listingId, data.autoUnlistedAt, data.reportId, data.threshold, event.timing.recordedAt],
      );
    },
  };
}

export function buildIdentityReportedContentProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.account-profile.report-submitted": async (event) => {
      const data = parseIdentityAccountProfileReportSubmittedPayload(event.data);
      await projectReport(
        db,
        { targetType: data.targetType, targetId: data.targetId, ownerAccountId: data.targetId },
        {
          reportId: data.reportId,
          reporterKind: "account",
          reporterKey: `account:${data.reporterAccountId}`,
          reporterAccountId: data.reporterAccountId,
          reason: data.reason,
          details: data.details,
          submittedAt: data.submittedAt,
        },
        event.timing.recordedAt,
      );
    },
  };
}

export function buildPlatformOperationsReportedContentProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "platform-operations.reported-content.action-recorded": async (event) => {
      const data = parsePlatformOperationsReportedContentActionRecordedPayload(event.data);

      // An action that replays before its target's first report holds a report-less row
      // (never a queue item) until the report lands. An older action never overwrites a
      // newer one, and its status never overwrites a later automatic unlisting.
      await db.query(
        `INSERT INTO platform_operations_reported_content_queue_pages (
           target_type,
           target_id,
           status,
           report_count,
           first_reported_at,
           last_reported_at,
           last_action,
           last_action_at,
           last_action_note,
           last_action_by_user_id,
           updated_at
         ) VALUES ($1, $2, $3, 0, $5, $5, $4, $5, $6, $7, $5)
         ON CONFLICT (target_type, target_id) DO UPDATE SET
           status = CASE
             WHEN platform_operations_reported_content_queue_pages.auto_unlisted_at IS NULL
               OR platform_operations_reported_content_queue_pages.auto_unlisted_at <= EXCLUDED.last_action_at
             THEN EXCLUDED.status
             ELSE platform_operations_reported_content_queue_pages.status
           END,
           last_action = EXCLUDED.last_action,
           last_action_at = EXCLUDED.last_action_at,
           last_action_note = EXCLUDED.last_action_note,
           last_action_by_user_id = EXCLUDED.last_action_by_user_id,
           updated_at = GREATEST(platform_operations_reported_content_queue_pages.updated_at, EXCLUDED.updated_at)
         WHERE platform_operations_reported_content_queue_pages.last_action_at IS NULL
           OR platform_operations_reported_content_queue_pages.last_action_at <= EXCLUDED.last_action_at`,
        [
          data.targetType,
          data.targetId,
          REPORTED_CONTENT_STATUS_BY_ACTION[data.action],
          data.action,
          data.recordedAt,
          data.note,
          data.operatorUserId,
        ],
      );
    },
  };
}

export function buildReportedContentProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  const marketplaceHandlers = buildMarketplaceReportedContentProjectionHandlers(db);
  return {
    // Keep the existing local action projection's inferred membership unchanged.
    // Operator removal is consumed by the declared Marketplace-source subscription.
    "marketplace.report.submitted": marketplaceHandlers["marketplace.report.submitted"]!,
    "marketplace.listing.auto-unlisted": marketplaceHandlers["marketplace.listing.auto-unlisted"]!,
    ...buildPlatformOperationsReportedContentProjectionHandlers(db),
  };
}
