import { describe, expect, it } from "vitest";
import {
  marketplaceListingSchemaMigrations,
  marketplaceListingSchemaSql,
} from "../features/listings/read-model/schema";
import {
  marketplaceSellerMetricsSourceSchemaMigrations,
  marketplaceSellerMetricsSourceSchemaSql,
} from "../features/seller-metrics/integrations/source/source-schema";
import {
  marketplaceSellerMetricsSummarySchemaMigrations,
  marketplaceSellerMetricsSummarySchemaSql,
} from "../features/seller-metrics/read-model/schema";

describe("marketplace fresh schema cleanup", () => {
  it("pins the generic evidence container and requirement snapshot on fresh and existing databases", () => {
    const migration = marketplaceListingSchemaMigrations.find(
      (entry) => entry.migrationId === "20260713_marketplace_listing_evidence_requirements_and_container",
    );
    const statements = migration?.statements.join("\n") ?? "";

    expect(marketplaceListingSchemaSql).toContain("evidence_requirements jsonb NULL");
    expect(marketplaceListingSchemaSql).toContain("evidence jsonb NOT NULL DEFAULT '[]'::jsonb");
    expect(marketplaceListingSchemaSql).not.toContain("listing_photos jsonb");
    expect(statements).toContain("RENAME COLUMN listing_photos TO evidence");
    expect(statements).toContain("ADD COLUMN IF NOT EXISTS evidence_requirements jsonb NULL");
  });

  it("converges seller metrics responsibility inputs on existing databases", () => {
    const sourceMigrationSql = marketplaceSellerMetricsSourceSchemaMigrations
      .flatMap((migration) => migration.statements)
      .join("\n");
    const summaryMigrationSql = marketplaceSellerMetricsSummarySchemaMigrations
      .flatMap((migration) => migration.statements)
      .join("\n");

    expect(marketplaceSellerMetricsSourceSchemaSql).toContain("responsibility text NULL");
    expect(sourceMigrationSql).toContain("ADD COLUMN IF NOT EXISTS responsibility text NULL");
    expect(marketplaceSellerMetricsSummarySchemaSql).toContain(
      "missing_responsibility_count integer NOT NULL DEFAULT 0",
    );
    expect(summaryMigrationSql).toContain(
      "ADD COLUMN IF NOT EXISTS missing_responsibility_count integer NOT NULL DEFAULT 0",
    );
  });
});
