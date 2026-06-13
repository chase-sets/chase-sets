import { describe, expect, it } from "vitest";
import {
  MARKETPLACE_TAX_READINESS_EVIDENCE_VERSION,
  buildTaxReadinessEvidence,
  parseTaxReadinessEvidenceArgs,
} from "./marketplace-tax-readiness-evidence.mjs";

function noCollectionReport(overrides = {}) {
  return {
    asOf: "2026-05-30T12:00:00.000Z",
    sourceMeasurementReference: "TAX-NEXUS-SOURCE-2026-05-30",
    sourceMeasurementEnvironment: "production",
    sourceMeasurementQueryVersion: "tax-nexus-measurement-query/v1",
    sourceMeasurementCheckedAt: "2026-05-30T11:45:00.000Z",
    sourceMeasurementProjectionFreshnessReference: "ORDERING-PROJECTION-FRESHNESS-2026-05-30",
    sourceMeasurementQueryWindow: {
      previousYearStart: "2025-01-01T00:00:00.000Z",
      currentYearStart: "2026-01-01T00:00:00.000Z",
      nextYearStart: "2027-01-01T00:00:00.000Z",
    },
    sourceMeasurementJurisdictionCount: 51,
    sourceMeasurementMissingJurisdictionOrderCount: 0,
    sourceMeasurementUnknownJurisdictionOrderCount: 0,
    sourceMeasurementRequiresManualReview: false,
    sourceMeasurementPasses: true,
    stateByStateJurisdictionReviewCount: 51,
    providerBackedQuotesRequired: false,
    providerBackedQuotesMissing: false,
    collectionRequiredJurisdictions: [],
    registrationRequiredJurisdictions: [],
    preparationJurisdictions: [],
    manualReviewJurisdictions: ["AK", "CO", "LA"],
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    nexusReport: noCollectionReport(),
    reference: "TAX-READINESS-2026-05-30",
    owner: "Tax",
    checkedAt: "2026-05-30T13:00:00.000Z",
    counselAccountingApprovalReference: "tax-counsel-2026-05-30",
    stateByStateNexusReference: "tax-nexus-2026-05-30",
    providerDecisionReference: "tax-provider-decision-2026-05-30",
    thresholdPolicyReference: "tax-threshold-policy-2026-05-30",
    nexusMonitoringReference: "tax-nexus-monitoring-2026-05-30",
    providerBackedResolverComposed: false,
    now: new Date("2026-05-30T13:00:00.000Z"),
    ...overrides,
  };
}

describe("marketplace tax readiness evidence", () => {
  it("builds a public launch gate for approved no-collection posture", () => {
    expect(buildTaxReadinessEvidence(input())).toEqual({
      schemaVersion: MARKETPLACE_TAX_READINESS_EVIDENCE_VERSION,
      approved: true,
      reference: "TAX-READINESS-2026-05-30",
      owner: "Tax",
      checkedAt: "2026-05-30T13:00:00.000Z",
      posture: "no_collection_required",
      collectionRequiredJurisdictions: [],
      taxProviderBackedQuotesRequired: false,
      providerBackedResolverComposed: false,
      counselAccountingApprovalReference: "tax-counsel-2026-05-30",
      stateByStateNexusReference: "tax-nexus-2026-05-30",
      providerDecisionReference: "tax-provider-decision-2026-05-30",
      thresholdPolicyReference: "tax-threshold-policy-2026-05-30",
      nexusMonitoringReference: "tax-nexus-monitoring-2026-05-30",
      nexusReportAsOf: "2026-05-30T12:00:00.000Z",
      sourceMeasurementReference: "TAX-NEXUS-SOURCE-2026-05-30",
      sourceMeasurementEnvironment: "production",
      sourceMeasurementQueryVersion: "tax-nexus-measurement-query/v1",
      sourceMeasurementCheckedAt: "2026-05-30T11:45:00.000Z",
      sourceMeasurementProjectionFreshnessReference: "ORDERING-PROJECTION-FRESHNESS-2026-05-30",
      sourceMeasurementQueryWindow: {
        previousYearStart: "2025-01-01T00:00:00.000Z",
        currentYearStart: "2026-01-01T00:00:00.000Z",
        nextYearStart: "2027-01-01T00:00:00.000Z",
      },
      sourceMeasurementJurisdictionCount: 51,
      sourceMeasurementMissingJurisdictionOrderCount: 0,
      sourceMeasurementUnknownJurisdictionOrderCount: 0,
      sourceMeasurementRequiresManualReview: false,
      sourceMeasurementPasses: true,
      stateByStateJurisdictionReviewCount: 51,
      providerBackedQuotesMissing: false,
      registrationRequiredJurisdictions: [],
      preparationJurisdictions: [],
      manualReviewJurisdictions: ["AK", "CO", "LA"],
      passesTaxReadinessGate: true,
    });
  });

  it("requires provider-backed resolver proof when collection is required", () => {
    const evidence = buildTaxReadinessEvidence(
      input({
        nexusReport: noCollectionReport({
          providerBackedQuotesRequired: true,
          providerBackedQuotesMissing: true,
          collectionRequiredJurisdictions: ["MN"],
        }),
        providerBackedResolverComposed: false,
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.posture).toBe("provider_backed_quotes_required");
    expect(evidence.errors).toContain(
      "Tax readiness provider-backed posture cannot have providerBackedQuotesMissing=true.",
    );
    expect(evidence.errors).toContain(
      "Tax readiness provider-backed posture requires providerBackedResolverComposed=true.",
    );
    expect(evidence.errors).toContain(
      "Tax readiness provider-backed posture requires providerBackedResolverReference.",
    );
  });

  it("accepts provider-backed posture once resolver and provider readiness are proven", () => {
    const evidence = buildTaxReadinessEvidence(
      input({
        nexusReport: noCollectionReport({
          providerBackedQuotesRequired: true,
          providerBackedQuotesMissing: false,
          collectionRequiredJurisdictions: ["MN"],
        }),
        providerBackedResolverComposed: true,
        providerBackedResolverReference: "TAX-PROVIDER-RESOLVER-2026-05-30",
      }),
    );

    expect(evidence.approved).toBe(true);
    expect(evidence.posture).toBe("provider_backed_quotes_required");
    expect(evidence.taxProviderBackedQuotesRequired).toBe(true);
    expect(evidence.providerBackedResolverComposed).toBe(true);
    expect(evidence.providerBackedResolverReference).toBe("TAX-PROVIDER-RESOLVER-2026-05-30");
    expect(evidence.collectionRequiredJurisdictions).toEqual(["MN"]);
  });

  it("rejects placeholder provider-backed resolver references", () => {
    const evidence = buildTaxReadinessEvidence(
      input({
        nexusReport: noCollectionReport({
          providerBackedQuotesRequired: true,
          providerBackedQuotesMissing: false,
          collectionRequiredJurisdictions: ["MN"],
        }),
        providerBackedResolverComposed: true,
        providerBackedResolverReference: "todo",
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Tax readiness providerBackedResolverReference must point to a real external evidence record, not a placeholder.",
    );
  });

  it("rejects contradictory no-provider reports with collection-required jurisdictions", () => {
    const evidence = buildTaxReadinessEvidence(
      input({
        nexusReport: noCollectionReport({
          providerBackedQuotesRequired: false,
          collectionRequiredJurisdictions: ["MN"],
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Tax readiness cannot use no_collection_required while collectionRequiredJurisdictions is non-empty.",
    );
  });

  it("rejects stale nexus reports", () => {
    const evidence = buildTaxReadinessEvidence(
      input({
        nexusReport: noCollectionReport({ asOf: "2026-04-01T00:00:00.000Z" }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Tax nexus readiness report asOf cannot be older than 30 days.");
  });

  it("rejects date-only Tax evidence timestamps", () => {
    const asOfOnly = buildTaxReadinessEvidence(
      input({
        nexusReport: noCollectionReport({ asOf: "2026-05-30" }),
      }),
    );
    const checkedOnly = buildTaxReadinessEvidence(input({ checkedAt: "2026-05-30" }));

    expect(asOfOnly.approved).toBe(false);
    expect(asOfOnly.errors).toContain("Tax nexus readiness report asOf must be an ISO timestamp.");
    expect(checkedOnly.approved).toBe(false);
    expect(checkedOnly.errors).toContain("Tax readiness evidence checkedAt must be an ISO timestamp.");
  });

  it("rejects non-production or stale-query source measurements", () => {
    const evidence = buildTaxReadinessEvidence(
      input({
        nexusReport: noCollectionReport({
          sourceMeasurementEnvironment: "staging",
          sourceMeasurementQueryVersion: "tax-nexus-measurement-query/v0",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Tax nexus readiness report sourceMeasurementEnvironment must be production.");
    expect(evidence.errors).toContain(
      "Tax nexus readiness report sourceMeasurementQueryVersion must be tax-nexus-measurement-query/v1.",
    );
  });

  it("rejects source measurements that did not pass coverage and freshness requirements", () => {
    const evidence = buildTaxReadinessEvidence(
      input({
        nexusReport: noCollectionReport({
          sourceMeasurementCheckedAt: "2026-05-30",
          sourceMeasurementProjectionFreshnessReference: "todo",
          sourceMeasurementQueryWindow: {
            previousYearStart: "2026-01-01T00:00:00.000Z",
            currentYearStart: "2025-01-01T00:00:00.000Z",
            nextYearStart: "2024-01-01T00:00:00.000Z",
          },
          sourceMeasurementJurisdictionCount: 50,
          sourceMeasurementMissingJurisdictionOrderCount: 1,
          sourceMeasurementUnknownJurisdictionOrderCount: 1,
          sourceMeasurementRequiresManualReview: true,
          sourceMeasurementPasses: false,
          stateByStateJurisdictionReviewCount: 50,
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Tax nexus readiness report sourceMeasurementProjectionFreshnessReference must point to a real external evidence record, not a placeholder.",
    );
    expect(evidence.errors).toContain(
      "Tax nexus readiness report sourceMeasurementCheckedAt must be an ISO timestamp.",
    );
    expect(evidence.errors).toContain(
      "Tax nexus readiness report sourceMeasurementQueryWindow.previousYearStart must be before currentYearStart.",
    );
    expect(evidence.errors).toContain(
      "Tax nexus readiness report sourceMeasurementQueryWindow.currentYearStart must be before nextYearStart.",
    );
    expect(evidence.errors).toContain("Tax nexus readiness report sourceMeasurementJurisdictionCount must be 51.");
    expect(evidence.errors).toContain(
      "Tax nexus readiness report sourceMeasurementMissingJurisdictionOrderCount must be 0.",
    );
    expect(evidence.errors).toContain(
      "Tax nexus readiness report sourceMeasurementUnknownJurisdictionOrderCount must be 0.",
    );
    expect(evidence.errors).toContain(
      "Tax nexus readiness report sourceMeasurementRequiresManualReview must be false.",
    );
    expect(evidence.errors).toContain("Tax nexus readiness report sourceMeasurementPasses must be true.");
    expect(evidence.errors).toContain(
      "Tax nexus readiness report stateByStateJurisdictionReviewCount must be at least 51.",
    );
  });

  it("rejects sourceMeasurementReference when it only names the query version", () => {
    const evidence = buildTaxReadinessEvidence(
      input({
        nexusReport: noCollectionReport({
          sourceMeasurementReference: "tax-nexus-measurement-query/v1",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Tax nexus readiness report sourceMeasurementReference must point to the production source measurement record.",
    );
  });

  it("rejects placeholder Tax approval and source references", () => {
    const evidence = buildTaxReadinessEvidence(
      input({
        counselAccountingApprovalReference: "placeholder",
        nexusReport: noCollectionReport({
          sourceMeasurementReference: "sample",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Tax readiness counselAccountingApprovalReference must point to a real external evidence record, not a placeholder.",
    );
    expect(evidence.errors).toContain(
      "Tax nexus readiness report sourceMeasurementReference must point to a real external evidence record, not a placeholder.",
    );
  });

  it("requires threshold policy and nexus monitoring evidence", () => {
    const evidence = buildTaxReadinessEvidence(
      input({
        thresholdPolicyReference: "",
        nexusMonitoringReference: "todo",
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Tax readiness evidence requires thresholdPolicyReference.");
    expect(evidence.errors).toContain(
      "Tax readiness nexusMonitoringReference must point to a real external evidence record, not a placeholder.",
    );
  });

  it("parses operator arguments from flags and environment", () => {
    expect(
      parseTaxReadinessEvidenceArgs(
        [
          "--nexus-report",
          "secure/tax-nexus.json",
          "--reference",
          "TAX-READINESS-2026-05-30",
          "--counsel-accounting-approval-reference",
          "tax-counsel",
          "--state-by-state-nexus-reference",
          "tax-nexus",
          "--provider-decision-reference",
          "tax-provider",
          "--threshold-policy-reference",
          "tax-threshold-policy",
          "--nexus-monitoring-reference",
          "tax-monitoring",
          "--provider-backed-resolver-reference",
          "tax-provider-resolver",
          "--provider-backed-resolver-composed",
          "true",
        ],
        {},
      ),
    ).toMatchObject({
      nexusReportPath: "secure/tax-nexus.json",
      reference: "TAX-READINESS-2026-05-30",
      counselAccountingApprovalReference: "tax-counsel",
      stateByStateNexusReference: "tax-nexus",
      providerDecisionReference: "tax-provider",
      thresholdPolicyReference: "tax-threshold-policy",
      nexusMonitoringReference: "tax-monitoring",
      providerBackedResolverReference: "tax-provider-resolver",
      providerBackedResolverComposed: true,
    });

    expect(
      parseTaxReadinessEvidenceArgs([], {
        TAX_NEXUS_READINESS_REPORT: "secure/tax-nexus.json",
        PRODUCTION_TAX_READINESS_REFERENCE: "TAX-READINESS-2026-05-30",
        TAX_READINESS_OWNER: "Tax Ops",
        TAX_COUNSEL_ACCOUNTING_APPROVAL_REFERENCE: "tax-counsel",
        TAX_STATE_BY_STATE_NEXUS_REFERENCE: "tax-nexus",
        TAX_PROVIDER_DECISION_REFERENCE: "tax-provider",
        TAX_THRESHOLD_POLICY_REFERENCE: "tax-threshold-policy",
        TAX_NEXUS_MONITORING_REFERENCE: "tax-monitoring",
        TAX_PROVIDER_BACKED_RESOLVER_REFERENCE: "tax-provider-resolver",
      }),
    ).toMatchObject({
      nexusReportPath: "secure/tax-nexus.json",
      owner: "Tax Ops",
      providerBackedResolverReference: "tax-provider-resolver",
      providerBackedResolverComposed: false,
    });
  });
});
