import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  PlatformFeedbackRelatedEntity,
  PlatformFeedbackStatus,
  PlatformFeedbackTopic,
  PlatformFeedbackWorkflow,
} from "../domain/common";

export type PlatformFeedbackRow = Readonly<{
  feedback_id: string;
  user_id: string;
  account_id: string;
  rating: number;
  topic: PlatformFeedbackTopic;
  comment: string | null;
  follow_up_consent: boolean;
  workflow: PlatformFeedbackWorkflow;
  source_route_path: string;
  related_entities: readonly PlatformFeedbackRelatedEntity[];
  related_entity_key: string | null;
  status: PlatformFeedbackStatus;
  submitted_at: string;
  updated_at: string;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  archived_by_user_id: string | null;
  archived_at: string | null;
}>;

export type PlatformFeedbackMetricsRow = Readonly<{
  total_count: number;
  new_count: number;
  reviewed_count: number;
  archived_count: number;
  average_rating: string | null;
  by_topic: readonly { topic: string; count: number; averageRating: string | null }[];
  by_workflow: readonly { workflow: string; count: number; averageRating: string | null }[];
}>;

function normalizePageParams(params: Readonly<{ limit?: number; offset?: number }>) {
  return {
    limit: Math.max(1, Math.min(params.limit ?? 50, 250)),
    offset: Math.max(0, params.offset ?? 0),
  };
}

function feedbackFilters(
  params: Readonly<{
    status?: string | null;
    topic?: string | null;
    workflow?: string | null;
  }>,
) {
  const clauses: string[] = [];
  const values: unknown[] = [];

  for (const [column, value] of [
    ["status", params.status],
    ["topic", params.topic],
    ["workflow", params.workflow],
  ] as const) {
    if (value && value !== "all") {
      values.push(value);
      clauses.push(`${column} = $${values.length}`);
    }
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

export async function listPlatformFeedback(
  db: PgQueryable,
  params: Readonly<{
    limit?: number;
    offset?: number;
    status?: string | null;
    topic?: string | null;
    workflow?: string | null;
  }>,
): Promise<{ items: PlatformFeedbackRow[]; total: number }> {
  const { limit, offset } = normalizePageParams(params);
  const filters = feedbackFilters(params);
  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM experience_platform_feedback_pages
     ${filters.where}`,
    filters.values,
  );
  const itemsResult = await db.query<PlatformFeedbackRow>(
    `SELECT
       feedback_id,
       user_id,
       account_id,
       rating,
       topic,
       comment,
       follow_up_consent,
       workflow,
       source_route_path,
       related_entities,
       related_entity_key,
       status,
       submitted_at::text AS submitted_at,
       updated_at::text AS updated_at,
       reviewed_by_user_id,
       reviewed_at::text AS reviewed_at,
       archived_by_user_id,
       archived_at::text AS archived_at
     FROM experience_platform_feedback_pages
     ${filters.where}
     ORDER BY submitted_at DESC, feedback_id DESC
     LIMIT $${filters.values.length + 1} OFFSET $${filters.values.length + 2}`,
    [...filters.values, limit, offset],
  );

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getPlatformFeedback(db: PgQueryable, feedbackId: string): Promise<PlatformFeedbackRow | null> {
  const result = await db.query<PlatformFeedbackRow>(
    `SELECT
       feedback_id,
       user_id,
       account_id,
       rating,
       topic,
       comment,
       follow_up_consent,
       workflow,
       source_route_path,
       related_entities,
       related_entity_key,
       status,
       submitted_at::text AS submitted_at,
       updated_at::text AS updated_at,
       reviewed_by_user_id,
       reviewed_at::text AS reviewed_at,
       archived_by_user_id,
       archived_at::text AS archived_at
     FROM experience_platform_feedback_pages
     WHERE feedback_id = $1`,
    [feedbackId],
  );

  return result.rows[0] ?? null;
}

export async function hasRecentPlatformFeedbackSubmission(
  db: PgQueryable,
  params: Readonly<{
    accountId: string;
    workflow: string;
    relatedEntityKey: string | null;
    submittedAfter: string;
  }>,
) {
  const result = params.relatedEntityKey
    ? await db.query<{ feedback_id: string }>(
        `SELECT feedback_id
         FROM experience_platform_feedback_pages
         WHERE account_id = $1
           AND workflow = $2
           AND related_entity_key = $3
         LIMIT 1`,
        [params.accountId, params.workflow, params.relatedEntityKey],
      )
    : await db.query<{ feedback_id: string }>(
        `SELECT feedback_id
         FROM experience_platform_feedback_pages
         WHERE account_id = $1
           AND workflow = $2
           AND related_entity_key IS NULL
           AND submitted_at >= $3
         LIMIT 1`,
        [params.accountId, params.workflow, params.submittedAfter],
      );

  return Boolean(result.rows[0]);
}

export async function hasActivePromptSnooze(
  db: PgQueryable,
  params: Readonly<{
    accountId: string;
    workflow: string;
    relatedEntityKey: string | null;
    now: string;
  }>,
) {
  const result = params.relatedEntityKey
    ? await db.query<{ prompt_id: string }>(
        `SELECT prompt_id
         FROM experience_platform_feedback_prompt_pages
         WHERE account_id = $1
           AND workflow = $2
           AND related_entity_key = $3
           AND snoozed_until > $4
         LIMIT 1`,
        [params.accountId, params.workflow, params.relatedEntityKey, params.now],
      )
    : await db.query<{ prompt_id: string }>(
        `SELECT prompt_id
         FROM experience_platform_feedback_prompt_pages
         WHERE account_id = $1
           AND workflow = $2
           AND related_entity_key IS NULL
           AND snoozed_until > $3
         LIMIT 1`,
        [params.accountId, params.workflow, params.now],
      );

  return Boolean(result.rows[0]);
}

async function groupedMetric(db: PgQueryable, column: "topic"): Promise<PlatformFeedbackMetricsRow["by_topic"]>;
async function groupedMetric(db: PgQueryable, column: "workflow"): Promise<PlatformFeedbackMetricsRow["by_workflow"]>;
async function groupedMetric(
  db: PgQueryable,
  column: "topic" | "workflow",
): Promise<PlatformFeedbackMetricsRow["by_topic"] | PlatformFeedbackMetricsRow["by_workflow"]> {
  const result = await db.query<{
    key: string;
    count: string;
    average_rating: string | null;
  }>(
    `SELECT
       ${column} AS key,
       COUNT(*) AS count,
       ROUND(AVG(rating)::numeric, 2)::text AS average_rating
     FROM experience_platform_feedback_pages
     GROUP BY ${column}
     ORDER BY count DESC, key ASC`,
  );

  if (column === "topic") {
    return result.rows.map((row) => ({
      topic: row.key,
      count: Number(row.count),
      averageRating: row.average_rating,
    }));
  }

  return result.rows.map((row) => ({
    workflow: row.key,
    count: Number(row.count),
    averageRating: row.average_rating,
  }));
}

export async function getPlatformFeedbackMetrics(db: PgQueryable): Promise<PlatformFeedbackMetricsRow> {
  const [summaryResult, byTopic, byWorkflow] = await Promise.all([
    db.query<{
      total_count: string;
      new_count: string;
      reviewed_count: string;
      archived_count: string;
      average_rating: string | null;
    }>(
      `SELECT
         COUNT(*) AS total_count,
         COUNT(*) FILTER (WHERE status = 'new') AS new_count,
         COUNT(*) FILTER (WHERE status = 'reviewed') AS reviewed_count,
         COUNT(*) FILTER (WHERE status = 'archived') AS archived_count,
         CASE
           WHEN COUNT(*) = 0 THEN NULL
           ELSE ROUND(AVG(rating)::numeric, 2)::text
         END AS average_rating
       FROM experience_platform_feedback_pages`,
    ),
    groupedMetric(db, "topic"),
    groupedMetric(db, "workflow"),
  ]);
  const summary = summaryResult.rows[0];

  return {
    total_count: Number(summary?.total_count ?? 0),
    new_count: Number(summary?.new_count ?? 0),
    reviewed_count: Number(summary?.reviewed_count ?? 0),
    archived_count: Number(summary?.archived_count ?? 0),
    average_rating: summary?.average_rating ?? null,
    by_topic: byTopic,
    by_workflow: byWorkflow,
  };
}
