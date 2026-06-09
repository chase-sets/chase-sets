import { t } from "@chase-sets/localization";
import type {
  CatalogIntegrationControlPlaneOverview,
  CatalogIntegrationRecentJobSummary,
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationScope,
} from "./contracts";

export function sourceObservationScope(
  overrides: Partial<SourceObservationIntegrationScope> = {},
): SourceObservationIntegrationScope {
  return {
    provider_key: "tcgdex",
    language_code: "en",
    expansion_id: "base1",
    expansion_name: "Base Set",
    series_id: "base",
    series_name: "Base",
    product_line_id: "3",
    product_line_name: "Pokemon",
    total_observations: 100,
    observed_observations: 100,
    changed_observations: 24,
    promoted_observations: 16,
    rejected_observations: 2,
    first_observed_at: "2026-06-09T00:00:00.000Z",
    latest_observed_at: "2026-06-09T01:00:00.000Z",
    latest_source_updated_at: "2026-06-09T00:30:00.000Z",
    ...overrides,
  };
}

export function profileReview(
  overrides: Partial<CatalogProviderProfileVersionReview> = {},
): CatalogProviderProfileVersionReview {
  return {
    providerKey: "tcgdex",
    profileKey: "tcgdex-pokemon-card",
    profileVersion: "2026.06.04",
    displayName: "TCGdex Pokemon cards",
    lifecycle: "test",
    active: false,
    status: "planned",
    connectorKind: "tcgdex-json",
    profile: {
      providerKey: "tcgdex",
      supportedScopes: ["pokemon/card"],
    },
    sourceContract: {
      owner: "chase-sets/catalog",
      repository: "chase-sets/chase-sets",
      commit: null,
      documentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
      fixtureSetVersion: "tcgdex-proof-v1",
    },
    fixtures: {
      fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex",
      coveredFlows: ["normal", "changed", "replay"],
      liveProviderCallsAllowed: false,
    },
    retirementPlan: null,
    executableMappingContract: {},
    referenceCount: 0,
    capabilities: ["source-observation-import", "promotion-command-plan"],
    supportedScopes: ["pokemon/card"],
    languageOptions: ["en"],
    mappingOutputKind: "provider-product",
    hasExecutableMappingContract: true,
    migrationEvidence: null,
    authoringAudit: null,
    validation: {
      status: "valid",
      diagnostics: [],
    },
    ...overrides,
  };
}

export function controlPlaneOverview(
  overrides: Partial<CatalogIntegrationControlPlaneOverview> = {},
): CatalogIntegrationControlPlaneOverview {
  const generatedAt = "2026-06-09T01:05:00.000Z";
  const unitKey = "tcgdex:pokemon:card:import";

  return {
    generatedAt,
    readiness: {
      generatedAt,
      rolloutControls: {
        generatedAt,
        controls: [],
      },
      units: [
        {
          unitKey,
          providerKey: "tcgdex",
          displayName: "TCGdex Pokemon cards",
          productDomain: "pokemon",
          productForm: "card",
          ingestionPurpose: "import",
          profileVersion: "2026.06.04",
          semanticReadiness: "ready",
          credentialReadiness: "not-required",
          credentialReadinessState: "not-required",
          credentialRequirement: "not-required",
          credentialDiagnosticCode: null,
          transportReadiness: "ready",
          fixtureValidationStatus: "ready",
          dryRunStatus: "completed",
          observationFacts: 24,
          diagnosticCounts: {
            info: 0,
            warning: 0,
            error: 0,
          },
          diagnostics: [],
          latestDiagnosticText: null,
          dryRunEvidence: [],
        },
      ],
    },
    unitActivity: {
      generatedAt,
      units: [
        {
          unitKey,
          recentJobs: [integrationJobSummary()],
        },
      ],
    },
    providerReadiness: {
      generatedAt,
      providers: [
        {
          providerKey: "tcgdex",
          adapterKey: "tcgdex",
          readiness: "ready",
          credentialReadiness: "not-required",
          credentialReadinessState: "not-required",
          credentialRequirement: "not-required",
          unitKeys: [unitKey],
          apiReachability: {
            status: "ready",
            diagnosticCodes: [],
            message: null,
          },
          optionQueryHealth: {
            status: "ready",
            diagnosticCodes: [],
            message: null,
          },
          rateLimitStatus: {
            status: "ready",
            diagnosticCodes: [],
            message: null,
          },
          payloadAcquisition: {
            status: "ready",
            diagnosticCodes: [],
            message: null,
          },
          diagnostics: [],
        },
      ],
    },
    auditLifecycle: {
      generatedAt,
      projectionStatus: "partial",
      statusMessage: "audit lifecycle projection is partial",
      entries: [],
    },
    ...overrides,
  };
}

export function integrationJobSummary(
  overrides: Partial<CatalogIntegrationRecentJobSummary> = {},
): CatalogIntegrationRecentJobSummary {
  return {
    jobId: "job_001",
    action: "import",
    operatorStatus: "running",
    phase: "processing",
    completed: 7,
    total: 24,
    providerKey: "tcgdex",
    profileVersion: "2026.06.04",
    startedAt: "2026-06-09T01:00:00.000Z",
    createdAt: "2026-06-09T00:59:00.000Z",
    summary: t("catalog.features.sourceObservations.api.adminControlPlaneOverview.job.summary", {
      action: "import",
      jobId: "job_001",
      operatorStatus: "running",
      completed: 7,
      total: 24,
    }),
    ...overrides,
  };
}
