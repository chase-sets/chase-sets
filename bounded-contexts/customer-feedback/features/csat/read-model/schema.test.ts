import { describe, expect, it } from "vitest";
import { csatAdminExportSchemaMigrations, csatAdminExportSchemaSql } from "./schema";

describe("CSAT admin export schema convergence", () => {
  it("widens the deployed export lifecycle to the fresh-boot contract", () => {
    const migration = csatAdminExportSchemaMigrations.find(
      (entry) => entry.migrationId === "20260718_customer_feedback_csat_export_audit_lifecycle",
    );
    const migrationSql = migration?.statements.join("\n") ?? "";

    expect(csatAdminExportSchemaSql).toContain("completed_at timestamptz NULL");
    expect(csatAdminExportSchemaSql).toContain("result IN ('pending', 'completed', 'failed', 'expired')");
    expect(migrationSql).toContain("ALTER COLUMN completed_at DROP NOT NULL");
    expect(migrationSql).toContain("DROP CONSTRAINT IF EXISTS customer_feedback_csat_export_audits_result_check");
    expect(migrationSql).toContain("CHECK (result IN ('pending', 'completed', 'failed', 'expired')) NOT VALID");
    expect(migrationSql).toContain("VALIDATE CONSTRAINT customer_feedback_csat_export_audits_result_check");
  });
});
