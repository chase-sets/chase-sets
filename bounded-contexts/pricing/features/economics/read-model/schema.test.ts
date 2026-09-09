import { describe, expect, it } from "vitest";
import { pricingEconomicsSchemaMigrations, pricingEconomicsSchemaSql } from "./schema";

describe("Pricing Economics schema", () => {
  it("constructs every boot table through the ordered migration ledger", () => {
    const migrationSql = pricingEconomicsSchemaMigrations.flatMap((migration) => migration.statements).join("\n");
    for (const table of ["pricing_inventory_acquisition_lots", "pricing_economics_overrides"]) {
      expect(pricingEconomicsSchemaSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(migrationSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(pricingEconomicsSchemaMigrations.map((migration) => migration.migrationId)).toEqual([
      "20260907_pricing_economics_acquisition_lots",
      "20260907_pricing_economics_overrides",
    ]);
  });

  it("keeps unknown acquisitions timestamp-free and active null-cap overrides distinguishable from clears", () => {
    expect(pricingEconomicsSchemaSql).toContain(
      "occurrence_kind = 'unknown' AND acquired_at IS NULL AND occurrence_source IS NULL",
    );
    expect(pricingEconomicsSchemaSql).toContain("override_state text NOT NULL");
    expect(pricingEconomicsSchemaSql).toContain("scope_key text NOT NULL");
    expect(pricingEconomicsSchemaSql).not.toContain("connection_id text NOT NULL");
    expect(pricingEconomicsSchemaSql).toContain(
      "override_state = 'cleared' AND override_value IS NULL AND set_at IS NULL AND cleared_at IS NOT NULL",
    );
    expect(pricingEconomicsSchemaSql).not.toContain("override_state = 'active' AND override_value IS NOT NULL");
  });
});
