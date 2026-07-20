import { describe, expect, it } from "vitest";
import { buildCatalogIntegrationControlPlaneOverview } from "./admin-control-plane-overview";
import { SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY } from "./provider-adapters/scrydex-one-piece";
import type {
  CatalogIntegrationControlPlaneReadiness,
  SourceObservationIntegrationJob,
  SourceObservationIntegrationProfileSnapshot,
} from "./runtime";

const generatedAt = "2026-06-25T12:00:00.000Z";

describe("Catalog integration control-plane overview", () => {
  it("summarizes failed import outcome reasons with redacted provider evidence", () => {
    const overview = buildCatalogIntegrationControlPlaneOverview({
      generatedAt,
      readiness: readinessFixture(),
      profiles: [],
      activeJobs: [
        integrationJobFixture({
          result: {
            requested: 1,
            imported: 0,
            observed: 0,
            reapplied: 0,
            skipped: 0,
            failed: 1,
            outcomes: [
              {
                providerKey: "scrydex",
                languageCode: "en",
                expansionId: "OP16",
                status: "failed",
                observed: 0,
                reapplied: 0,
                reason:
                  "Scrydex request failed at https://api.scrydex.com/onepiece/v1/expansions/OP16/sealed?page=1&api_key=secret with X-Api-Key=secret-token; provider response body is redacted.",
                providerUsageEvidence: {
                  unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
                  requestStrategy: "bulk-first",
                  estimateState: "estimated",
                  estimatedRequestCount: 1,
                  estimateReason: null,
                  actualRequestCount: 2,
                  pageCount: 2,
                  cacheHitCount: null,
                  cacheMissCount: null,
                  usageCheckState: "checked",
                  creditDiagnostic: "credit status is available",
                  degradedDiagnostic: null,
                  bulkFirstConfirmed: true,
                  perRecordFallbackReason: null,
                  selectedFields: [],
                  pageSize: 100,
                },
              },
            ],
          },
        }),
      ],
    });

    const result = overview.unitActivity.units[0]?.recentJobs[0]?.result;

    expect(result?.redactedFailureReasons).toEqual([
      "Scrydex request failed at https://api.scrydex.com/onepiece/v1/expansions/OP16/sealed with X-Api-Key=[redacted]; provider response body is redacted.",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("api_key=secret");
    expect(result?.usage).toEqual({ actualRequestCount: 2, pageCount: 2, cacheHitCount: null, cacheMissCount: null });
    expect(JSON.stringify(result)).not.toContain("credit status is available");
  });

  it("does not report partial usage totals when an outcome has no evidence", () => {
    const overview = buildCatalogIntegrationControlPlaneOverview({
      generatedAt,
      readiness: readinessFixture(),
      profiles: [],
      activeJobs: [
        integrationJobFixture({
          result: {
            requested: 2,
            imported: 1,
            observed: 1,
            reapplied: 0,
            skipped: 0,
            failed: 1,
            outcomes: [
              {
                providerKey: "scrydex",
                languageCode: "en",
                expansionId: "OP16",
                status: "imported",
                observed: 1,
                reapplied: 0,
                reason: null,
                providerUsageEvidence: {
                  unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
                  requestStrategy: "bulk-first",
                  estimateState: "estimated",
                  estimatedRequestCount: 1,
                  estimateReason: null,
                  actualRequestCount: 2,
                  pageCount: 2,
                  cacheHitCount: null,
                  cacheMissCount: null,
                  usageCheckState: "checked",
                  creditDiagnostic: null,
                  degradedDiagnostic: null,
                  bulkFirstConfirmed: true,
                  perRecordFallbackReason: null,
                  selectedFields: [],
                  pageSize: 100,
                },
              },
              {
                providerKey: "scrydex",
                languageCode: "en",
                expansionId: "OP17",
                status: "failed",
                observed: 0,
                reapplied: 0,
                reason: "Provider usage evidence was unavailable.",
              },
            ],
          },
        }),
      ],
    });

    expect(overview.unitActivity.units[0]?.recentJobs[0]?.result?.usage).toEqual({
      actualRequestCount: null,
      pageCount: null,
      cacheHitCount: null,
      cacheMissCount: null,
    });
  });
});

function readinessFixture(): CatalogIntegrationControlPlaneReadiness {
  return {
    generatedAt,
    rolloutControls: {
      generatedAt,
      controls: [],
    },
    units: [
      {
        unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        providerKey: "scrydex",
        displayName: "Scrydex One Piece sealed products",
        productDomain: "one-piece",
        productForm: "sealed-product",
        ingestionPurpose: "source-observation-import",
        profileVersion: "2026.06.22",
        semanticReadiness: "ready",
        credentialReadiness: "ready",
        credentialReadinessState: "configured",
        credentialRequirement: "required",
        credentialDiagnosticCode: null,
        transportReadiness: "ready",
        fixtureValidationStatus: "ready",
        dryRunStatus: "completed",
        observationFacts: 1,
        diagnosticCounts: { info: 0, warning: 0, error: 0 },
        diagnostics: [],
        latestDiagnosticText: null,
        dryRunEvidence: [],
      },
    ],
  };
}

function integrationJobFixture(
  overrides: Partial<SourceObservationIntegrationJob> = {},
): SourceObservationIntegrationJob {
  const profileSnapshot = scrydexSealedProfileSnapshot();
  return {
    jobId: "job_failed",
    syncRunId: null,
    action: "import",
    scope: {
      provider: "scrydex",
      ingestionUnitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      language: "en",
      setId: "OP16",
    },
    profileSnapshot,
    reapplyProfileMode: null,
    status: "completed",
    operatorStatus: "partial",
    consistency: {
      duplicateSubmissionPolicy: "reuse-active-job",
      profileSnapshotPolicy: "snapshotted-at-enqueue",
      retryResumePolicy: "skip-completed-outcomes",
      partialFailurePolicy: "mixed-outcomes",
      workUnitClaimPolicy: "leased-job-turns",
    },
    progress: {
      phase: "completed",
      completed: 1,
      total: 1,
      currentName: null,
      status: "failed",
    },
    result: null,
    errorMessage: null,
    createdAt: generatedAt,
    startedAt: generatedAt,
    completedAt: generatedAt,
    updatedAt: generatedAt,
    ...overrides,
  };
}

function scrydexSealedProfileSnapshot(): SourceObservationIntegrationProfileSnapshot {
  return {
    providerKey: "scrydex",
    profileKey: "one-piece-sealed-product-source-observation",
    profileVersion: "2026.06.22",
    ingestionUnitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    lifecycle: "active",
    connectorKind: "scrydex",
    connectorSourceVersion: null,
    sourceMappingFingerprint: "fingerprint:scrydex:one-piece-sealed:2026.06.22",
  };
}
