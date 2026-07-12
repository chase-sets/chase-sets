import { describe, expect, it } from "vitest";
import { settlementPayoutReadinessSchemaMigrations, settlementPayoutReadinessSchemaSql } from "./schema";

describe("settlement payout readiness schema", () => {
  it("keeps provider posture index with the migration-added posture columns", () => {
    const migrationSql = settlementPayoutReadinessSchemaMigrations
      .flatMap((migration) => migration.statements)
      .join("\n");

    expect(settlementPayoutReadinessSchemaSql).toContain("ADD COLUMN IF NOT EXISTS payout_account_dashboard");
    expect(settlementPayoutReadinessSchemaSql).toContain("ADD COLUMN IF NOT EXISTS requirements_collector");
    expect(settlementPayoutReadinessSchemaSql).toContain("advisory_requirements jsonb NOT NULL");
    expect(settlementPayoutReadinessSchemaSql).toContain("requirements_deadline timestamptz NULL");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS disabled_reason");
    expect(settlementPayoutReadinessSchemaSql).not.toContain("settlement_payout_readiness_pages_provider_posture_idx");
    expect(migrationSql).toContain("settlement_payout_readiness_pages_provider_posture_idx");
  });
});
