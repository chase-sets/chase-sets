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
import { refreshReportedContentResponses } from "./response-state";
import { parseReportedContentAcknowledgement } from "../api/acknowledgement";

type ReportSummary = {
  reportId: string;
  reporterKind: string;
  reporterKey: string;
  reporterAccountId: string | null;
  reason: string;
  details: string | null;
  submittedAt: string;
};

/**
 * Queues one report against its target. Redelivery of a known report id is a no-op.
 * A row that so far holds
 * only an early-delivered action takes its report times from its first report.
 */
async function projectReport(
  db: PgQueryable,
  target: Readonly<{ targetType: ReportedContentTargetType; targetId: string; ownerAccountId: string | null }>,
  report: ReportSummary,
  recordedAt: string,
) {
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
     ) VALUES ($1, $2, $3, 'needs-review', 1, $4::jsonb, $5::jsonb, $6, $6, $7)
     ON CONFLICT (target_type, target_id) DO UPDATE SET
       response_version = platform_operations_reported_content_queue_pages.response_version + 1,
       target_owner_account_id = COALESCE(EXCLUDED.target_owner_account_id, platform_operations_reported_content_queue_pages.target_owner_account_id),
       report_count = CASE
         WHEN EXISTS (
           SELECT 1
           FROM jsonb_array_elements(platform_operations_reported_content_queue_pages.reports) AS existing_report
           WHERE existing_report->>'reportId' = EXCLUDED.reports->0->>'reportId'
         ) THEN platform_operations_reported_content_queue_pages.report_count
         ELSE platform_operations_reported_content_queue_pages.report_count + 1
       END,
       reasons = CASE
         WHEN EXISTS (
           SELECT 1
           FROM jsonb_array_elements(platform_operations_reported_content_queue_pages.reports) AS existing_report
           WHERE existing_report->>'reportId' = EXCLUDED.reports->0->>'reportId'
         ) THEN platform_operations_reported_content_queue_pages.reasons
         ELSE (
           SELECT jsonb_agg(jsonb_build_object('reason', merged.reason, 'count', merged.count) ORDER BY merged.count DESC, merged.reason)
           FROM (
             SELECT reason, SUM(count)::integer AS count
             FROM (
               SELECT entry->>'reason' AS reason, (entry->>'count')::integer AS count
               FROM jsonb_array_elements(platform_operations_reported_content_queue_pages.reasons) AS existing_reason(entry)
               UNION ALL
               SELECT entry->>'reason' AS reason, (entry->>'count')::integer AS count
               FROM jsonb_array_elements(EXCLUDED.reasons) AS incoming_reason(entry)
             ) AS reason_counts
             GROUP BY reason
           ) AS merged
         )
       END,
       reports = CASE
         WHEN EXISTS (
           SELECT 1
           FROM jsonb_array_elements(platform_operations_reported_content_queue_pages.reports) AS existing_report
           WHERE existing_report->>'reportId' = EXCLUDED.reports->0->>'reportId'
         ) THEN platform_operations_reported_content_queue_pages.reports
         ELSE (
           SELECT jsonb_agg(entry ORDER BY entry->>'submittedAt')
           FROM jsonb_array_elements(platform_operations_reported_content_queue_pages.reports || EXCLUDED.reports) AS report_entries(entry)
         )
       END,
       first_reported_at = CASE
         WHEN platform_operations_reported_content_queue_pages.report_count = 0 THEN EXCLUDED.first_reported_at
         ELSE LEAST(platform_operations_reported_content_queue_pages.first_reported_at, EXCLUDED.first_reported_at)
       END,
       last_reported_at = CASE
         WHEN platform_operations_reported_content_queue_pages.report_count = 0 THEN EXCLUDED.last_reported_at
         ELSE GREATEST(platform_operations_reported_content_queue_pages.last_reported_at, EXCLUDED.last_reported_at)
       END,
       updated_at = GREATEST(platform_operations_reported_content_queue_pages.updated_at, EXCLUDED.updated_at)
       WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(platform_operations_reported_content_queue_pages.reports) r
         WHERE r->>'reportId' = EXCLUDED.reports->0->>'reportId') RETURNING 1`,
    [
      target.targetType,
      target.targetId,
      target.ownerAccountId,
      JSON.stringify([{ reason: report.reason, count: 1 }]),
      JSON.stringify([report]),
      report.submittedAt,
      recordedAt,
    ],
  );
  // Retry derivation even after report redelivery: the previous application may
  // have persisted the report and failed before completing its response state.
  await refreshReportedContentResponses(db, target.targetType, target.targetId);
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
         SET status = CASE WHEN last_action_at IS NULL OR last_action_at <= $2::timestamptz THEN 'manually-unlisted' ELSE status END,
             response_open = CASE WHEN last_action_at IS NULL OR last_action_at <= $2::timestamptz THEN false ELSE response_open END,
             response_removed_at = GREATEST(response_removed_at, $2::timestamptz),
             acknowledge_due_at = CASE WHEN last_action_at IS NULL OR last_action_at <= $2::timestamptz THEN NULL ELSE acknowledge_due_at END,
             disposition_due_at = CASE WHEN last_action_at IS NULL OR last_action_at <= $2::timestamptz THEN NULL ELSE disposition_due_at END,
             response_version = response_version + 1,
             updated_at = GREATEST(updated_at, $2::timestamptz)
         WHERE target_type = 'listing'
           AND target_id = $1`,
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
             response_version = response_version + 1,
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
    "platform-operations.reported-content.acknowledged": async (event) => {
      const data = parseReportedContentAcknowledgement(event.data);
      await db.query(
        `INSERT INTO platform_operations_reported_content_queue_pages
        (target_type, target_id, status, report_count, first_reported_at, last_reported_at, updated_at, response_acknowledgements)
        VALUES ($1, $2, 'needs-review', 0, $3, $3, $3, $4::jsonb)
        ON CONFLICT (target_type, target_id) DO UPDATE SET
          response_acknowledgements = platform_operations_reported_content_queue_pages.response_acknowledgements || EXCLUDED.response_acknowledgements,
          updated_at = GREATEST(platform_operations_reported_content_queue_pages.updated_at, EXCLUDED.updated_at),
          response_version = platform_operations_reported_content_queue_pages.response_version + 1
        WHERE NOT platform_operations_reported_content_queue_pages.response_acknowledgements @> EXCLUDED.response_acknowledgements`,
        [
          data.targetType,
          data.targetId,
          data.acknowledgedAt,
          JSON.stringify([
            { startedAt: data.startedAt, acknowledgedAt: data.acknowledgedAt, operatorUserId: data.operatorUserId },
          ]),
        ],
      );
      await refreshReportedContentResponses(db, data.targetType, data.targetId);
    },
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
           response_version = platform_operations_reported_content_queue_pages.response_version + 1,
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
      await db.query(
        `UPDATE platform_operations_reported_content_queue_pages SET
        response_actions = (SELECT jsonb_agg(a ORDER BY a->>'recordedAt', a->>'actionId')
          FROM jsonb_array_elements(response_actions || $3::jsonb) a), response_version = response_version + 1
        WHERE target_type = $1 AND target_id = $2 AND NOT response_actions @> $3::jsonb`,
        [
          data.targetType,
          data.targetId,
          JSON.stringify([{ actionId: data.actionId, action: data.action, recordedAt: data.recordedAt }]),
        ],
      );
      await refreshReportedContentResponses(db, data.targetType, data.targetId);
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
