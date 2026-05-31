import { describe, expect, it } from "vitest";
import {
  TAX_NEXUS_INCLUDED_ORDER_STATUSES,
  TAX_NEXUS_JURISDICTION_CODES,
  TAX_NEXUS_MEASUREMENT_QUERY_VERSION,
  buildTaxNexusMeasurementEvidence,
  buildTaxNexusQueryWindow,
  normalizeTaxNexusMeasurementRow,
  parseTaxNexusMeasurementArgs,
  taxNexusMeasurementSql,
} from "./marketplace-tax-nexus-measurement.mjs";

describe("marketplace tax nexus measurement", () => {
  it("uses ordering order tax snapshots and excludes cancelled orders", () => {
    expect(taxNexusMeasurementSql).toContain("FROM ordering_order_pages");
    expect(taxNexusMeasurementSql).toContain("tax_jurisdiction_country = 'US'");
    expect(taxNexusMeasurementSql).toContain("tax_jurisdiction_state");
    expect(taxNexusMeasurementSql).toContain("shipping_destination_snapshot ->> 'state'");
    expect(taxNexusMeasurementSql).toContain("status = ANY($4::text[])");
    expect(TAX_NEXUS_INCLUDED_ORDER_STATUSES).toEqual([
      "pending-reservation",
      "pending-payment",
      "ready-for-fulfillment",
    ]);
  });

  it("builds previous, current, and next-year query windows from the launch as-of date", () => {
    expect(buildTaxNexusQueryWindow({ asOf: "2026-05-30T12:00:00.000Z" })).toEqual({
      asOf: "2026-05-30T12:00:00.000Z",
      previousYearStart: "2025-01-01T00:00:00.000Z",
      currentYearStart: "2026-01-01T00:00:00.000Z",
      nextYearStart: "2027-01-01T00:00:00.000Z",
    });
  });

  it("normalizes database rows into Tax nexus activity fields", () => {
    expect(
      normalizeTaxNexusMeasurementRow({
        jurisdiction_code: " tx ",
        current_year_gross_sales_amount: "1234.5",
        previous_year_gross_sales_amount: "99",
        current_year_transaction_count: "3",
        previous_year_transaction_count: "1",
      }),
    ).toEqual({
      jurisdictionCode: "TX",
      currentYearGrossSalesAmount: "1234.50",
      previousYearGrossSalesAmount: "99.00",
      currentYearTransactionCount: 3,
      previousYearTransactionCount: 1,
    });
  });

  it("emits one activity row per Tax jurisdiction and flags unresolved jurisdiction coverage", () => {
    const evidence = buildTaxNexusMeasurementEvidence({
      checkedAt: "2026-05-30T12:30:00.000Z",
      environment: "production",
      reference: "TAX-NEXUS-SOURCE-2026-05-30",
      operator: "ops@chasesets.com",
      projectionFreshnessReference: "ORDERING-PROJECTION-2026-05-30",
      queryWindow: buildTaxNexusQueryWindow({ asOf: "2026-05-30T12:00:00.000Z" }),
      rows: [
        {
          jurisdiction_code: "TX",
          current_year_gross_sales_amount: "250.00",
          current_year_transaction_count: 2,
          previous_year_gross_sales_amount: "50.00",
          previous_year_transaction_count: 1,
        },
        {
          jurisdiction_code: null,
          current_year_gross_sales_amount: "10.00",
          current_year_transaction_count: 1,
          previous_year_gross_sales_amount: "0.00",
          previous_year_transaction_count: 0,
        },
        {
          jurisdiction_code: "ZZ",
          current_year_gross_sales_amount: "5.00",
          current_year_transaction_count: 1,
          previous_year_gross_sales_amount: "0.00",
          previous_year_transaction_count: 0,
        },
      ],
    });

    expect(evidence.activity).toHaveLength(TAX_NEXUS_JURISDICTION_CODES.length);
    expect(evidence.activity.find((row) => row.jurisdictionCode === "TX")).toMatchObject({
      currentYearGrossSalesAmount: "250.00",
      previousYearGrossSalesAmount: "50.00",
      currentYearTransactionCount: 2,
      previousYearTransactionCount: 1,
      registrationStatus: "not-registered",
      collectionStatus: "not-collecting",
      providerBackedQuotesReady: false,
    });
    expect(evidence.jurisdictionCoverage).toEqual({
      missingJurisdictionOrderCount: 1,
      unknownJurisdictionOrderCount: 1,
      unknownJurisdictionCodes: ["ZZ"],
      requiresManualReview: true,
    });
    expect(evidence.passesSourceMeasurementGate).toBe(false);
    expect(evidence.errors).toContain(
      "Tax nexus source measurement must resolve missing or unknown jurisdiction coverage before launch.",
    );
  });

  it("passes the source measurement gate when every measured order has a known jurisdiction", () => {
    const evidence = buildTaxNexusMeasurementEvidence({
      checkedAt: "2026-05-30T12:30:00.000Z",
      environment: "production",
      reference: "TAX-NEXUS-SOURCE-2026-05-30",
      operator: "ops@chasesets.com",
      projectionFreshnessReference: "ORDERING-PROJECTION-2026-05-30",
      queryWindow: buildTaxNexusQueryWindow({ asOf: "2026-05-30T12:00:00.000Z" }),
      rows: [
        {
          jurisdiction_code: "WA",
          current_year_gross_sales_amount: "50.00",
          current_year_transaction_count: 1,
          previous_year_gross_sales_amount: "0.00",
          previous_year_transaction_count: 0,
        },
      ],
    });

    expect(evidence.schemaVersion).toBe("marketplace-tax-nexus-measurement/v1");
    expect(evidence.queryVersion).toBe(TAX_NEXUS_MEASUREMENT_QUERY_VERSION);
    expect(evidence.jurisdictionCoverage.requiresManualReview).toBe(false);
    expect(evidence.passesSourceMeasurementGate).toBe(true);
    expect(evidence.errors).toBeUndefined();
  });

  it("fails direct evidence building when production metadata or evidence references are missing", () => {
    const evidence = buildTaxNexusMeasurementEvidence({
      checkedAt: "not-a-date",
      environment: "staging",
      reference: "todo",
      operator: "",
      projectionFreshnessReference: "record",
      queryWindow: {
        asOf: "bad-date",
        previousYearStart: "2026-01-01T00:00:00.000Z",
        currentYearStart: "2025-01-01T00:00:00.000Z",
        nextYearStart: "2024-01-01T00:00:00.000Z",
      },
      rows: [
        {
          jurisdiction_code: "WA",
          current_year_gross_sales_amount: "50.00",
          current_year_transaction_count: 1,
          previous_year_gross_sales_amount: "0.00",
          previous_year_transaction_count: 0,
        },
      ],
    });

    expect(evidence.passesSourceMeasurementGate).toBe(false);
    expect(evidence.errors).toContain(
      "Tax nexus source measurement must run against production before marketplace launch.",
    );
    expect(evidence.errors).toContain("Tax nexus source measurement checkedAt must be an ISO timestamp.");
    expect(evidence.errors).toContain("Tax nexus source measurement must include the operator who ran the sweep.");
    expect(evidence.errors).toContain(
      "Tax nexus source measurement reference must point to a real external evidence record, not a placeholder.",
    );
    expect(evidence.errors).toContain(
      "Tax nexus source measurement projectionFreshnessReference must point to a real external evidence record, not a placeholder.",
    );
    expect(evidence.errors).toContain("Tax nexus source measurement queryWindow asOf must be an ISO timestamp.");
    expect(evidence.errors).toContain(
      "Tax nexus source measurement queryWindow previousYearStart must be before currentYearStart.",
    );
    expect(evidence.errors).toContain(
      "Tax nexus source measurement queryWindow currentYearStart must be before nextYearStart.",
    );
  });

  it("fails direct evidence building when output timestamps are date-only values", () => {
    const evidence = buildTaxNexusMeasurementEvidence({
      checkedAt: "2026-05-30",
      environment: "production",
      reference: "TAX-NEXUS-SOURCE-2026-05-30",
      operator: "ops@chasesets.com",
      projectionFreshnessReference: "ORDERING-PROJECTION-2026-05-30",
      queryWindow: {
        asOf: "2026-05-30",
        previousYearStart: "2025-01-01",
        currentYearStart: "2026-01-01",
        nextYearStart: "2027-01-01",
      },
      rows: [
        {
          jurisdiction_code: "WA",
          current_year_gross_sales_amount: "50.00",
          current_year_transaction_count: 1,
          previous_year_gross_sales_amount: "0.00",
          previous_year_transaction_count: 0,
        },
      ],
    });

    expect(evidence.passesSourceMeasurementGate).toBe(false);
    expect(evidence.errors).toContain("Tax nexus source measurement checkedAt must be an ISO timestamp.");
    expect(evidence.errors).toContain("Tax nexus source measurement queryWindow asOf must be an ISO timestamp.");
    expect(evidence.errors).toContain(
      "Tax nexus source measurement queryWindow previousYearStart must be an ISO timestamp.",
    );
    expect(evidence.errors).toContain(
      "Tax nexus source measurement queryWindow currentYearStart must be an ISO timestamp.",
    );
    expect(evidence.errors).toContain(
      "Tax nexus source measurement queryWindow nextYearStart must be an ISO timestamp.",
    );
  });

  it("resolves database, operator, and evidence references from flags or environment", () => {
    expect(
      parseTaxNexusMeasurementArgs(
        [
          "--database-url",
          "postgresql://explicit",
          "--environment",
          "production",
          "--operator",
          "Ops",
          "--projection-freshness-reference",
          "ORDERING-PROJECTION-2026-05-30",
          "--reference",
          "TAX-NEXUS-SOURCE-2026-05-30",
          "--as-of",
          "2026-05-30T12:00:00.000Z",
        ],
        {},
      ),
    ).toMatchObject({
      databaseUrl: "postgresql://explicit",
      environment: "production",
      operator: "Ops",
      projectionFreshnessReference: "ORDERING-PROJECTION-2026-05-30",
      reference: "TAX-NEXUS-SOURCE-2026-05-30",
      asOf: "2026-05-30T12:00:00.000Z",
    });

    expect(
      parseTaxNexusMeasurementArgs([], {
        TAX_NEXUS_MEASUREMENT_DATABASE_URL: "postgresql://tax",
        DEPLOYMENT_ENVIRONMENT: "production",
        TAX_NEXUS_MEASUREMENT_OPERATOR: "ops@chasesets.com",
        TAX_NEXUS_PROJECTION_FRESHNESS_REFERENCE: "ORDERING-PROJECTION-2026-05-30",
        TAX_NEXUS_MEASUREMENT_REFERENCE: "TAX-NEXUS-SOURCE-2026-05-30",
      }),
    ).toMatchObject({
      databaseUrl: "postgresql://tax",
      environment: "production",
      operator: "ops@chasesets.com",
      projectionFreshnessReference: "ORDERING-PROJECTION-2026-05-30",
      reference: "TAX-NEXUS-SOURCE-2026-05-30",
    });
  });
});
