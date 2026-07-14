import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { FeedbackAttentionItem } from "../domain/attention";

export type FeedbackAttentionQueueFilters = Readonly<{
  ownerId?: string | null;
  limit?: number;
  now?: string;
  overdueOnly?: boolean;
}>;

export async function listFeedbackAttention(
  db: PgQueryable,
  filters: FeedbackAttentionQueueFilters = {},
): Promise<readonly FeedbackAttentionItem[]> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const values: unknown[] = [filters.now ?? new Date().toISOString()];
  const ownerClause = filters.ownerId === undefined ? "" : 'AND "ownerId" = $2';
  if (filters.ownerId !== undefined) values.push(filters.ownerId);
  const overdueClause = filters.overdueOnly
    ? 'AND (("triagedAt" IS NULL AND "triageDueAt" < $1) OR ("dueAt" IS NOT NULL AND "dueAt" < $1))'
    : "";
  values.push(limit);
  const result = await db.query<FeedbackAttentionItem>(
    `WITH derived_sla_attention AS (
       SELECT case_id AS "caseId", rating, priority, owner_id AS "ownerId", opened_at AS "openedAt",
              triaged_at AS "triagedAt", due_at AS "dueAt", closed_at AS "closedAt",
              opened_at + CASE priority
                WHEN 'urgent' THEN interval '60 minutes'
                WHEN 'high' THEN interval '240 minutes'
                WHEN 'normal' THEN interval '1440 minutes'
                ELSE interval '2880 minutes'
              END AS "triageDueAt"
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
              triage_due_at AS "triageDueAt", closed_at AS "closedAt"
       FROM customer_feedback_case_attention
       WHERE state = 'active'
       UNION ALL
       SELECT 'sla:' || "caseId", "caseId", 'active', 'sla-breach', 'triage-sla-v1', rating, priority, "ownerId",
              "openedAt", "triagedAt", "dueAt", "triageDueAt", "closedAt"
       FROM derived_sla_attention
       WHERE ("triagedAt" IS NULL AND "triageDueAt" < $1) OR ("dueAt" IS NOT NULL AND "dueAt" < $1)
     )
     SELECT *
     FROM attention_queue
     WHERE state = 'active'
       ${overdueClause}
       ${ownerClause}
     ORDER BY priority DESC, COALESCE("dueAt", "triageDueAt"), "attentionId"
     LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}
