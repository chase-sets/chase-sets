import { describe, expect, it } from "vitest";
import {
  defaultTaxNexusThresholdPolicies,
  evaluateTaxNexusReadiness,
  type TaxNexusThresholdPolicy,
} from "../features/nexus/domain/nexus-tracking";

const ohioPolicy = defaultTaxNexusThresholdPolicies.find((policy) => policy.jurisdictionCode === "OH")!;

describe("tax nexus tracking", () => {
  it("does not require provider-backed quotes when no collecting jurisdiction exists", () => {
    const report = evaluateTaxNexusReadiness(
      [
        {
          jurisdictionCode: "OH",
          currentYearGrossSalesAmount: "1000.00",
          previousYearGrossSalesAmount: "0.00",
          currentYearTransactionCount: 10,
          previousYearTransactionCount: 0,
          registrationStatus: "not-registered",
          collectionStatus: "not-collecting",
        },
      ],
      { asOf: "2026-05-30T00:00:00.000Z" },
    );

    expect(report.providerBackedQuotesRequired).toBe(false);
    expect(report.jurisdictions.find((row) => row.jurisdictionCode === "OH")).toMatchObject({
      status: "monitoring",
      thresholdBasis: "sales",
      thresholdProgressRatio: 0.01,
    });
  });

  it("warns before registration is required", () => {
    const report = evaluateTaxNexusReadiness([
      {
        jurisdictionCode: "OH",
        currentYearGrossSalesAmount: "95500.00",
        previousYearGrossSalesAmount: "0.00",
        currentYearTransactionCount: 200,
        previousYearTransactionCount: 0,
        registrationStatus: "not-registered",
        collectionStatus: "not-collecting",
      },
    ]);

    expect(report.preparationJurisdictions).toContain("OH");
    expect(report.jurisdictions.find((row) => row.jurisdictionCode === "OH")).toMatchObject({
      status: "prepare-registration",
    });
  });

  it("marks registration required after the threshold is crossed", () => {
    const report = evaluateTaxNexusReadiness([
      {
        jurisdictionCode: "OH",
        currentYearGrossSalesAmount: "100000.00",
        previousYearGrossSalesAmount: "0.00",
        currentYearTransactionCount: 1200,
        previousYearTransactionCount: 0,
        registrationStatus: "not-registered",
        collectionStatus: "not-collecting",
      },
    ]);

    expect(report.registrationRequiredJurisdictions).toContain("OH");
    expect(report.providerBackedQuotesRequired).toBe(false);
  });

  it("requires provider-backed quotes after a threshold-crossed state is registered for collection", () => {
    const report = evaluateTaxNexusReadiness([
      {
        jurisdictionCode: "OH",
        currentYearGrossSalesAmount: "100000.00",
        previousYearGrossSalesAmount: "0.00",
        currentYearTransactionCount: 1200,
        previousYearTransactionCount: 0,
        registrationStatus: "registered",
        collectionStatus: "not-collecting",
        providerBackedQuotesReady: false,
      },
    ]);

    expect(report.collectionRequiredJurisdictions).toEqual(["OH"]);
    expect(report.providerBackedQuotesRequired).toBe(true);
    expect(report.providerBackedQuotesMissing).toBe(true);
  });

  it("still marks provider-backed quotes required when collection is active and provider readiness is recorded", () => {
    const report = evaluateTaxNexusReadiness([
      {
        jurisdictionCode: "OH",
        currentYearGrossSalesAmount: "100000.00",
        previousYearGrossSalesAmount: "0.00",
        currentYearTransactionCount: 1200,
        previousYearTransactionCount: 0,
        registrationStatus: "registered",
        collectionStatus: "collecting",
        providerBackedQuotesReady: true,
      },
    ]);

    expect(report.collectionRequiredJurisdictions).toEqual(["OH"]);
    expect(report.providerBackedQuotesRequired).toBe(true);
    expect(report.providerBackedQuotesMissing).toBe(false);
  });

  it("supports transaction-count thresholds for jurisdictions that still use them", () => {
    const policies: readonly TaxNexusThresholdPolicy[] = [
      {
        ...ohioPolicy,
        transactionThreshold: 200,
      },
    ];
    const report = evaluateTaxNexusReadiness(
      [
        {
          jurisdictionCode: "OH",
          currentYearGrossSalesAmount: "4000.00",
          previousYearGrossSalesAmount: "0.00",
          currentYearTransactionCount: 200,
          previousYearTransactionCount: 0,
          registrationStatus: "not-registered",
          collectionStatus: "not-collecting",
        },
      ],
      { policies },
    );

    expect(report.jurisdictions[0]).toMatchObject({
      thresholdBasis: "transactions",
      status: "registration-required",
    });
  });

  it("keeps no-statewide-sales-tax states out of provider requirements", () => {
    const report = evaluateTaxNexusReadiness([
      {
        jurisdictionCode: "OR",
        currentYearGrossSalesAmount: "250000.00",
        previousYearGrossSalesAmount: "0.00",
        currentYearTransactionCount: 2500,
        previousYearTransactionCount: 0,
        registrationStatus: "not-registered",
        collectionStatus: "not-collecting",
      },
    ]);

    expect(report.jurisdictions.find((row) => row.jurisdictionCode === "OR")).toMatchObject({
      status: "not-applicable",
      providerBackedQuotesRequired: false,
    });
  });

  it("keeps complex local-admin jurisdictions in manual review", () => {
    const report = evaluateTaxNexusReadiness([
      {
        jurisdictionCode: "AK",
        currentYearGrossSalesAmount: "100000.00",
        previousYearGrossSalesAmount: "0.00",
        currentYearTransactionCount: 1000,
        previousYearTransactionCount: 0,
        registrationStatus: "not-registered",
        collectionStatus: "not-collecting",
      },
    ]);

    expect(report.manualReviewJurisdictions).toContain("AK");
    expect(report.jurisdictions.find((row) => row.jurisdictionCode === "AK")).toMatchObject({
      status: "manual-review",
      thresholdBasis: "manual-review",
    });
  });
});
