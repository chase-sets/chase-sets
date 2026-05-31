import { describe, expect, it } from "vitest";
import {
  LAUNCH_SUPPLY_MEASUREMENT_QUERY_VERSION,
  buildLaunchSupplyMeasurementEvidence,
  launchSupplyMeasurementSql,
  normalizeLaunchSupplyMeasurementRow,
  parseLaunchSupplyMeasurementArgs,
} from "./marketplace-launch-supply-measurement.mjs";

describe("marketplace launch supply measurement", () => {
  it("uses the same checkout-eligible listing filters as marketplace listing reads", () => {
    expect(launchSupplyMeasurementSql).toContain("FROM marketplace_listing_pages AS listing");
    expect(launchSupplyMeasurementSql).toContain("INNER JOIN marketplace_supply_items AS item");
    expect(launchSupplyMeasurementSql).toContain("FROM marketplace_supply_holds");
    expect(launchSupplyMeasurementSql).toContain("LEFT JOIN marketplace_seller_listing_availability_pages");
    expect(launchSupplyMeasurementSql).toContain("listing.status = 'active'");
    expect(launchSupplyMeasurementSql).toContain("COALESCE(availability.status, 'available') = 'available'");
    expect(launchSupplyMeasurementSql).toContain("COUNT(DISTINCT account_id)::integer");
    expect(launchSupplyMeasurementSql).toContain("sampled_active_launch_listing_ids");
    expect(launchSupplyMeasurementSql).toContain("product_measure_snapshot IS NULL");
    expect(launchSupplyMeasurementSql).toContain(") > 0");
  });

  it("normalizes database rows into packet field names", () => {
    expect(
      normalizeLaunchSupplyMeasurementRow({
        active_launch_listing_count: "42",
        active_launch_seller_account_count: "7",
        sampled_active_launch_listing_ids: [" lst_1 ", "lst_2"],
        active_launch_listings_missing_resolved_product_measures: "0",
        resolved_product_measure_coverage_percent: "100.00",
      }),
    ).toEqual({
      activeLaunchListingCount: 42,
      activeLaunchSellerAccountCount: 7,
      sampledActiveLaunchListingIds: ["lst_1", "lst_2"],
      activeLaunchListingsMissingResolvedProductMeasures: 0,
      resolvedProductMeasureCoveragePercent: 100,
    });
  });

  it("marks only non-empty perfect-coverage measurements as launch-ready", () => {
    const readyEvidence = buildLaunchSupplyMeasurementEvidence({
      row: {
        active_launch_listing_count: 42,
        active_launch_seller_account_count: 7,
        sampled_active_launch_listing_ids: ["lst_1", "lst_2"],
        active_launch_listings_missing_resolved_product_measures: 0,
        resolved_product_measure_coverage_percent: 100,
      },
      checkedAt: "2026-05-30T12:00:00.000Z",
      environment: "production",
      queryReference: "launch-supply-measurement-query-2026-05-30",
      operator: "ops@chasesets.com",
      projectionFreshnessReference: "projection-freshness-2026-05-30",
    });
    expect(readyEvidence.passesLaunchSupplyGate).toBe(true);
    expect(readyEvidence.errors).toBeUndefined();

    const emptyEvidence = buildLaunchSupplyMeasurementEvidence({
      row: {
        active_launch_listing_count: 0,
        active_launch_seller_account_count: 0,
        sampled_active_launch_listing_ids: [],
        active_launch_listings_missing_resolved_product_measures: 0,
        resolved_product_measure_coverage_percent: 0,
      },
      checkedAt: "2026-05-30T12:00:00.000Z",
      environment: "production",
      queryReference: "launch-supply-measurement-query-2026-05-30",
      operator: "ops@chasesets.com",
      projectionFreshnessReference: "projection-freshness-2026-05-30",
    });
    expect(emptyEvidence.passesLaunchSupplyGate).toBe(false);
    expect(emptyEvidence.errors).toContain(
      "Launch supply measurement must prove at least one active launch listing is eligible for checkout.",
    );
  });

  it("requires production scope for launch-ready measurements", () => {
    const evidence = buildLaunchSupplyMeasurementEvidence({
      row: {
        active_launch_listing_count: 42,
        active_launch_seller_account_count: 7,
        sampled_active_launch_listing_ids: ["lst_1", "lst_2"],
        active_launch_listings_missing_resolved_product_measures: 0,
        resolved_product_measure_coverage_percent: 100,
      },
      checkedAt: "2026-05-30T12:00:00.000Z",
      environment: "staging",
      queryReference: "launch-supply-measurement-query-2026-05-30",
      operator: "ops@chasesets.com",
      projectionFreshnessReference: "projection-freshness-2026-05-30",
    });

    expect(evidence.passesLaunchSupplyGate).toBe(false);
    expect(evidence.errors).toContain(
      "Launch supply measurement must run against production before marketplace launch.",
    );
  });

  it("fails direct evidence building when required launch evidence metadata is missing or placeholder", () => {
    const evidence = buildLaunchSupplyMeasurementEvidence({
      row: {
        active_launch_listing_count: 42,
        active_launch_seller_account_count: 0,
        sampled_active_launch_listing_ids: ["lst_1", "lst_1"],
        active_launch_listings_missing_resolved_product_measures: 1,
        resolved_product_measure_coverage_percent: 99.5,
      },
      checkedAt: "not-a-date",
      environment: "production",
      queryReference: LAUNCH_SUPPLY_MEASUREMENT_QUERY_VERSION,
      operator: "",
      projectionFreshnessReference: "todo",
    });

    expect(evidence.passesLaunchSupplyGate).toBe(false);
    expect(evidence.errors).toContain(
      "Launch supply measurement must include activeLaunchSellerAccountCount between 1 and activeLaunchListingCount.",
    );
    expect(evidence.errors).toContain("Launch supply measurement sampledActiveLaunchListingIds must be distinct.");
    expect(evidence.errors).toContain(
      "Launch supply measurement must have activeLaunchListingsMissingResolvedProductMeasures=0.",
    );
    expect(evidence.errors).toContain("Launch supply measurement must have resolvedProductMeasureCoveragePercent=100.");
    expect(evidence.errors).toContain("Launch supply measurement checkedAt must be an ISO timestamp.");
    expect(evidence.errors).toContain("Launch supply measurement must include the operator who ran the sweep.");
    expect(evidence.errors).toContain(
      "Launch supply measurement projectionFreshnessReference must point to a real external evidence record, not a placeholder.",
    );
    expect(evidence.errors).toContain(
      "Launch supply measurement queryReference must point to the production query evidence record.",
    );
  });

  it("rejects date-only launch supply measurement timestamps", () => {
    const evidence = buildLaunchSupplyMeasurementEvidence({
      row: {
        active_launch_listing_count: 42,
        active_launch_seller_account_count: 7,
        sampled_active_launch_listing_ids: ["lst_1", "lst_2"],
        active_launch_listings_missing_resolved_product_measures: 0,
        resolved_product_measure_coverage_percent: 100,
      },
      checkedAt: "2026-05-30",
      environment: "production",
      queryReference: "launch-supply-measurement-query-2026-05-30",
      operator: "ops@chasesets.com",
      projectionFreshnessReference: "projection-freshness-2026-05-30",
    });

    expect(evidence.passesLaunchSupplyGate).toBe(false);
    expect(evidence.errors).toContain("Launch supply measurement checkedAt must be an ISO timestamp.");
  });

  it("resolves environment, operator, projection freshness, and database arguments from flags or environment", () => {
    expect(
      parseLaunchSupplyMeasurementArgs(
        [
          "--database-url",
          "postgresql://explicit",
          "--environment",
          "production",
          "--operator",
          "Ops",
          "--projection-freshness-reference",
          "projection-freshness-2026-05-30",
          "--query-reference",
          "CATALOG-LAUNCH-SUPPLY-QUERY-2026-05-30",
        ],
        {},
      ),
    ).toMatchObject({
      databaseUrl: "postgresql://explicit",
      environment: "production",
      operator: "Ops",
      projectionFreshnessReference: "projection-freshness-2026-05-30",
      queryReference: "CATALOG-LAUNCH-SUPPLY-QUERY-2026-05-30",
    });

    expect(
      parseLaunchSupplyMeasurementArgs([], {
        MARKETPLACE_DATABASE_URL: "postgresql://marketplace",
        DEPLOYMENT_ENVIRONMENT: "production",
        LAUNCH_SUPPLY_OPERATOR: "ops@chasesets.com",
        LAUNCH_SUPPLY_PROJECTION_FRESHNESS_REFERENCE: "projection-freshness-2026-05-30",
        LAUNCH_SUPPLY_QUERY_REFERENCE: "CATALOG-LAUNCH-SUPPLY-QUERY-2026-05-30",
      }),
    ).toMatchObject({
      databaseUrl: "postgresql://marketplace",
      environment: "production",
      operator: "ops@chasesets.com",
      projectionFreshnessReference: "projection-freshness-2026-05-30",
      queryReference: "CATALOG-LAUNCH-SUPPLY-QUERY-2026-05-30",
    });
  });
});
