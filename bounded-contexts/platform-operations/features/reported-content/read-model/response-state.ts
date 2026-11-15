import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ReportedContentQueueStatus } from "../api/contracts";
import { reportedContentDueTimes, reportedContentReason, reportedContentSeverity } from "./response-policy";

export type ResponseAction = { actionId: string; action: string; recordedAt: string };
export type ResponseAcknowledgement = { startedAt: string; acknowledgedAt: string; operatorUserId: string | null };
export type ResponseRow = {
  target_type: string;
  target_id: string;
  target_owner_account_id: string | null;
  status: ReportedContentQueueStatus;
  reports: { reason: string; submittedAt: string }[];
  last_action: string | null;
  last_action_at: string | null;
  auto_unlisted_at: string | null;
  response_actions: ResponseAction[];
  response_acknowledgements: ResponseAcknowledgement[];
  response_version: number;
  prior_dispositions: number;
  response_removed_at?: string | null;
};

const reopenable = new Set(["dismiss", "contact-seller", "contact-account", "escalate-account-suspension"]);

export function deriveReportedContentResponse(row: ResponseRow) {
  const reports = [...row.reports].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  const later =
    row.last_action_at && row.last_action && reopenable.has(row.last_action)
      ? reports.filter((report) => Date.parse(report.submittedAt) > Date.parse(row.last_action_at!))
      : [];
  const reopened = later.length > 0;
  const startedAt = (reopened ? later : reports)[0]?.submittedAt;
  const removed =
    row.response_removed_at &&
    (!row.last_action_at || Date.parse(row.response_removed_at) >= Date.parse(row.last_action_at));
  const open = !removed && (row.last_action_at === null || reopened);
  const acknowledgedAt =
    row.response_acknowledgements
      .filter((ack) => startedAt && Date.parse(ack.startedAt) === Date.parse(startedAt))
      .sort((a, b) => Date.parse(a.acknowledgedAt) - Date.parse(b.acknowledgedAt))[0]?.acknowledgedAt ?? null;
  const severity = reportedContentSeverity(
    reports.map((report) => report.reason),
    Number(row.prior_dispositions),
  );
  const due = reportedContentDueTimes(startedAt ?? "", severity);
  if (reports.some((report) => reportedContentReason(report.reason).category === "policy-incomplete")) {
    due.policy_code = "policy-incomplete";
  }
  return {
    ...due,
    response_started_at: startedAt ?? null,
    acknowledged_at: acknowledgedAt,
    response_open: open,
    status: removed ? "manually-unlisted" : reopened ? "needs-review" : row.status,
    acknowledge_due_at: open && !acknowledgedAt ? due.acknowledge_due_at : null,
    disposition_due_at: open ? due.disposition_due_at : null,
  };
}

// A late source fact also refreshes this owner's other targets. CAS prevents a slower
// projection from overwriting a response derived from newer reports or actions.
export async function refreshReportedContentResponses(db: PgQueryable, targetType: string, targetId: string) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const rows = await db.query<ResponseRow>(
      `
      SELECT q.*, q.last_action_at::text AS last_action_at,
        (SELECT COUNT(*)::integer FROM platform_operations_reported_content_queue_pages p,
          jsonb_array_elements(p.response_actions) a
          WHERE p.target_owner_account_id = q.target_owner_account_id
            AND a->>'action' <> 'dismiss'
            AND (a->>'recordedAt')::timestamptz < q.last_reported_at
            AND (a->>'recordedAt')::timestamptz >= q.last_reported_at - interval '180 days') AS prior_dispositions
      FROM platform_operations_reported_content_queue_pages q
      WHERE q.report_count > 0 AND ((q.target_type = $1 AND q.target_id = $2)
        OR q.target_owner_account_id = (SELECT target_owner_account_id
          FROM platform_operations_reported_content_queue_pages WHERE target_type = $1 AND target_id = $2))`,
      [targetType, targetId],
    );
    let conflict = false;
    for (const row of rows.rows) {
      const response = deriveReportedContentResponse(row);
      const result = await db.query(
        `UPDATE platform_operations_reported_content_queue_pages SET
        severity = $4, policy_revision = $5, policy_code = $6, response_started_at = $7,
        acknowledged_at = $8, acknowledge_due_at = $9, disposition_due_at = $10,
        accountable_role = $11, response_open = $12, status = $13,
        response_version = response_version + CASE WHEN
          (severity, policy_revision, policy_code, response_started_at, acknowledged_at,
           acknowledge_due_at, disposition_due_at, accountable_role, response_open, status)
          IS DISTINCT FROM ($4::text, $5::text, $6::text, $7::timestamptz, $8::timestamptz,
            $9::timestamptz, $10::timestamptz, $11::text, $12::boolean, $13::text)
          THEN 1 ELSE 0 END
        WHERE target_type = $1 AND target_id = $2 AND response_version = $3 RETURNING 1`,
        [
          row.target_type,
          row.target_id,
          row.response_version,
          response.severity,
          response.policy_revision,
          response.policy_code,
          response.response_started_at,
          response.acknowledged_at,
          response.acknowledge_due_at,
          response.disposition_due_at,
          response.accountable_role,
          response.response_open,
          response.status,
        ],
      );
      if (!result.rows.length) conflict = true;
    }
    if (!conflict) return;
  }
  throw new Error("reported-content-response-conflict");
}
