import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pricingProviderObservationsSchemaSql } from "../read-model/provider-observations-schema";

describe("provider observation durability contract", () => {
  it("boots every typed table and keeps only the replayable Catalog input unlogged", () => {
    for (const table of [
      "pricing_external_market_captures",
      "pricing_external_sale_observations",
      "pricing_external_weekly_sale_buckets",
      "pricing_external_listing_snapshots",
      "pricing_external_listing_ask_depth",
    ]) {
      expect(pricingProviderObservationsSchemaSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    const migration = readFileSync(
      new URL("../../../support/runtime-support/unlogged-projection-migrations.ts", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("ALTER TABLE pricing_external_catalog_item_reference_inputs SET UNLOGGED");
    expect(migration).not.toMatch(
      /ALTER TABLE pricing_external_(?:market_captures|sale_observations|weekly_sale_buckets|listing_snapshots|listing_ask_depth) SET UNLOGGED/,
    );
  });
});
