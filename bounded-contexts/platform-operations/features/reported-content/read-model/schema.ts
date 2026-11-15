import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { refreshReportedContentResponses } from "./response-state";

export const reportedContentSchemaSql = `
CREATE TABLE IF NOT EXISTS platform_operations_reported_content_queue_pages (
  target_type text NOT NULL,
  target_id text NOT NULL,
  target_owner_account_id text NULL,
  status text NOT NULL,
  report_count integer NOT NULL DEFAULT 0,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  reports jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_reported_at timestamptz NOT NULL,
  last_reported_at timestamptz NOT NULL,
  auto_unlisted_at timestamptz NULL,
  auto_unlist_report_id text NULL,
  auto_unlist_threshold integer NULL,
  last_action text NULL,
  last_action_at timestamptz NULL,
  last_action_note text NULL,
  last_action_by_user_id text NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (target_type, target_id)
);

CREATE INDEX IF NOT EXISTS platform_operations_reported_content_status_idx
  ON platform_operations_reported_content_queue_pages (status, last_reported_at DESC);

ALTER TABLE platform_operations_reported_content_queue_pages
  ADD COLUMN IF NOT EXISTS severity text NULL,
  ADD COLUMN IF NOT EXISTS policy_revision text NULL,
  ADD COLUMN IF NOT EXISTS policy_code text NULL,
  ADD COLUMN IF NOT EXISTS response_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS response_removed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS acknowledge_due_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS disposition_due_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS accountable_role text NULL,
  ADD COLUMN IF NOT EXISTS response_open boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS response_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS response_acknowledgements jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS response_version integer NOT NULL DEFAULT 0;

`;

export const reportedContentResponseSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261115_reported_content_owner_index",
    description: "Index report owners concurrently before deriving historical response state.",
    statements: [
      `DROP INDEX CONCURRENTLY IF EXISTS platform_operations_reported_content_owner_idx`,
      `CREATE INDEX CONCURRENTLY platform_operations_reported_content_owner_idx
      ON platform_operations_reported_content_queue_pages (target_owner_account_id, status)`,
    ],
  },
  {
    migrationId: "20261115_reported_content_response",
    description: "Backfill effective response policy and prior dispositions without appending events.",
    statements: [],
    dataStep: async (db: PgQueryable) => {
      await db.query(`UPDATE platform_operations_reported_content_queue_pages q SET response_actions = COALESCE((
      SELECT jsonb_agg(jsonb_build_object('actionId', e.payload->>'actionId', 'action', e.payload->>'action',
        'recordedAt', e.payload->>'recordedAt') ORDER BY e.payload->>'recordedAt', e.payload->>'actionId')
      FROM event_store_events e
      WHERE e.stream_id = 'platform-operations.reported-content-' || q.target_type || '-' || q.target_id
        AND e.event_type = 'platform-operations.reported-content.action-recorded'), '[]'::jsonb)
      WHERE q.policy_revision IS NULL`);
      await db.query(`UPDATE platform_operations_reported_content_queue_pages SET response_removed_at = updated_at
        WHERE policy_revision IS NULL AND status = 'manually-unlisted'`);
      let after = "";
      for (;;) {
        const page = await db.query<{ owner_key: string; target_type: string; target_id: string }>(
          `
          SELECT DISTINCT ON (COALESCE(target_owner_account_id, target_type || ':' || target_id))
            COALESCE(target_owner_account_id, target_type || ':' || target_id) AS owner_key, target_type, target_id
          FROM platform_operations_reported_content_queue_pages WHERE report_count > 0
            AND COALESCE(target_owner_account_id, target_type || ':' || target_id) > $1
          ORDER BY COALESCE(target_owner_account_id, target_type || ':' || target_id), target_type, target_id LIMIT 200`,
          [after],
        );
        for (const target of page.rows) await refreshReportedContentResponses(db, target.target_type, target.target_id);
        if (page.rows.length < 200) break;
        after = page.rows.at(-1)!.owner_key;
      }
    },
  },
  {
    migrationId: "20261115_reported_content_response_index",
    description: "Index open moderation response severity and due time without blocking writes.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS platform_operations_reported_content_response_open_idx
      ON platform_operations_reported_content_queue_pages (
        (CASE WHEN policy_revision IS NULL OR policy_code = 'policy-incomplete' THEN 0
          ELSE CASE COALESCE(severity, 'critical') WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END END),
        (LEAST(acknowledge_due_at, disposition_due_at))) WHERE response_open`,
    ],
  },
];
