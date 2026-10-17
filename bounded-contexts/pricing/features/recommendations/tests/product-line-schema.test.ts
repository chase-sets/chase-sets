import { describe, expect, it } from "vitest";
import {
  pricingRecommendationSourceSchemaMigrations,
  pricingRecommendationSourceSchemaSql,
} from "../integrations/source/source-schema";

describe("Product Line schema migration", () => {
  it("keeps boot indexes out of the tables migration", () => {
    const migration = pricingRecommendationSourceSchemaMigrations[0]!;
    expect(migration.migrationId).toBe("20261016_pricing_product_line_inputs");
    expect(migration.statements).toHaveLength(5);
    expect(migration.statements[0]).not.toMatch(/CREATE INDEX/i);
    expect(migration.statements[0]).toContain("CREATE TABLE IF NOT EXISTS pricing_catalog_reference_inputs");
    expect(migration.statements[0]).toContain("CREATE TABLE IF NOT EXISTS pricing_catalog_reference_records");
    expect(migration.statements[1]).toMatch(/CREATE INDEX CONCURRENTLY/i);
    expect(pricingRecommendationSourceSchemaSql).toContain(
      "CREATE INDEX IF NOT EXISTS pricing_catalog_reference_inputs_reference_idx",
    );
  });
});
