import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const platformOperationsUnloggedProjectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_platform_operations_unlogged_projections",
    description: "Store replayable Platform Operations projections as unlogged tables.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE experience_platform_feedback_pages SET UNLOGGED;",
      "ALTER TABLE experience_platform_feedback_prompt_pages SET UNLOGGED;",
      "ALTER TABLE platform_operations_reported_content_queue_pages SET UNLOGGED;",
      "ALTER TABLE platform_operations_risk_alert_account_sources SET UNLOGGED;",
      "ALTER TABLE platform_operations_risk_alert_queue_pages SET UNLOGGED;",
      "ALTER TABLE platform_operations_risk_alert_velocity_sources SET UNLOGGED;",
      "ALTER TABLE support_order_sources SET UNLOGGED;",
      "ALTER TABLE support_request_pages SET UNLOGGED;",
      "ALTER TABLE support_shipment_sources SET UNLOGGED;",
    ],
  },
  {
    migrationId: "20260711_support_request_auto_close_sweep_index",
    description: "Index resolved support requests by auto-close deadline for the deadline sweep.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS support_request_pages_auto_close_sweep_idx
  ON support_request_pages (auto_close_due_at)
  WHERE status = 'resolved'`,
    ],
  },
];
