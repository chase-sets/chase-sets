import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  feedbackAttentionRule,
  feedbackCaseSlaState,
  type FeedbackAttentionItem,
  type FeedbackSlaState,
} from "../domain/attention";

export type FeedbackAttentionQueueFilters = Readonly<{
  ownerId?: string | null;
  limit?: number;
  now?: string;
  overdueOnly?: boolean;
}>;

export type FeedbackAttentionQueueItem = FeedbackAttentionItem & Readonly<{ sla: FeedbackSlaState }>;

export type FeedbackSlaColumns = Readonly<{
  openedAt: string;
  priority: string;
  triagedAt: string;
  dueAt: string;
}>;

export function feedbackTriageDeadlineSql(columns: Pick<FeedbackSlaColumns, "openedAt" | "priority">): string {
  const minutes = feedbackAttentionRule.triageSlaMinutes;
  return `(${columns.openedAt} + CASE ${columns.priority}
    WHEN 'urgent' THEN interval '${minutes.urgent} minutes'
    WHEN 'high' THEN interval '${minutes.high} minutes'
    WHEN 'normal' THEN interval '${minutes.normal} minutes'
    ELSE interval '${minutes.low} minutes'
  END)`;
}

export function feedbackOverdueSql(columns: FeedbackSlaColumns, now: string): string {
  return `((${columns.triagedAt} IS NULL AND ${feedbackTriageDeadlineSql(columns)} < ${now}) OR (${columns.dueAt} IS NOT NULL AND ${columns.dueAt} < ${now}))`;
}

const derivedSlaColumns: FeedbackSlaColumns = {
  openedAt: 'derived_sla_attention."openedAt"',
  priority: "derived_sla_attention.priority",
  triagedAt: 'derived_sla_attention."triagedAt"',
  dueAt: 'derived_sla_attention."dueAt"',
};

const queueSlaColumns: FeedbackSlaColumns = {
  openedAt: 'attention_queue."openedAt"',
  priority: "attention_queue.priority",
  triagedAt: 'attention_queue."triagedAt"',
  dueAt: 'attention_queue."dueAt"',
};

export async function listFeedbackAttention(
  db: PgQueryable,
  filters: FeedbackAttentionQueueFilters = {},
): Promise<readonly FeedbackAttentionQueueItem[]> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const now = filters.now ?? new Date().toISOString();
  const values: unknown[] = [now];
  const ownerClause = filters.ownerId === undefined ? "" : 'AND attention_queue."ownerId" = $2';
  if (filters.ownerId !== undefined) values.push(filters.ownerId);
  const overdueClause = filters.overdueOnly ? `AND ${feedbackOverdueSql(queueSlaColumns, "$1::timestamptz")}` : "";
  values.push(limit);
  const result = await db.query<FeedbackAttentionItem>(
    `WITH derived_sla_attention AS (
       SELECT case_id AS "caseId", rating, priority, owner_id AS "ownerId", opened_at AS "openedAt",
              triaged_at AS "triagedAt", due_at AS "dueAt", closed_at AS "closedAt",
              ${feedbackTriageDeadlineSql({ openedAt: "cases.opened_at", priority: "cases.priority" })} AS "triageDueAt"
       FROM customer_feedback_feedback_cases AS cases
       WHERE status <> 'closed'
         AND NOT EXISTS (
           SELECT 1
           FROM customer_feedback_case_attention AS existing
           WHERE existing.case_id = cases.case_id AND existing.state = 'active'
         )
     ), attention_queue AS (
      SELECT attention_id AS "attentionId", case_id AS "caseId", state, reason,
              rule_version AS "ruleVersion", rating, priority, owner_id AS "ownerId",
              opened_at AS "openedAt", triaged_at AS "triagedAt", due_at AS "dueAt",
              triage_due_at AS "triageDueAt", closed_at AS "closedAt",
              delivery_status AS "deliveryStatus", delivery_reference AS "deliveryReference",
              delivery_reported_at AS "deliveryReportedAt"
       FROM customer_feedback_case_attention
       WHERE state = 'active'
       UNION ALL
       SELECT 'sla:' || "caseId", "caseId", 'active', 'sla-breach', 'triage-sla-v1', rating, priority, "ownerId",
              "openedAt", "triagedAt", "dueAt", "triageDueAt", "closedAt", 'pending', NULL, NULL
       FROM derived_sla_attention
       WHERE ${feedbackOverdueSql(derivedSlaColumns, "$1::timestamptz")}
     )
     SELECT attention_queue.*,
            cases.follow_up_delivery_status AS "followUpDeliveryStatus",
            cases.follow_up_channel AS "followUpChannel"
     FROM attention_queue
     JOIN customer_feedback_feedback_cases AS cases ON cases.case_id = attention_queue."caseId"
     WHERE attention_queue.state = 'active'
       ${overdueClause}
       ${ownerClause}
     ORDER BY CASE attention_queue.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC,
              COALESCE(attention_queue."dueAt", attention_queue."triageDueAt"), attention_queue."attentionId"
     LIMIT $${values.length}`,
    values,
  );
  return result.rows.map((row) => ({ ...row, sla: attentionSlaState(row, now) }));
}

// node-postgres returns timestamptz columns as Date; the helper parses strings, so normalize first.
function isoTimestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function optionalIsoTimestamp(value: Date | string | null): string | null {
  return value === null ? null : isoTimestamp(value);
}

function attentionSlaState(row: FeedbackAttentionItem, now: string): FeedbackSlaState {
  const closedAt = optionalIsoTimestamp(row.closedAt);
  return feedbackCaseSlaState(
    {
      openedAt: isoTimestamp(row.openedAt),
      priority: row.priority,
      triagedAt: optionalIsoTimestamp(row.triagedAt),
      dueAt: optionalIsoTimestamp(row.dueAt),
      status: closedAt ? "closed" : "new",
      closedAt,
    },
    now,
  );
}
