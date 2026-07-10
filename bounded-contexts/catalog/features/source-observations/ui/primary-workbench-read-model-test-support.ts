import { describe, expect, it } from "vitest";
import { tcgdexPokemonCardSourceObservationMappingContract } from "../api/tcgdex-executable-mapping-contract";
import type { CatalogAdminRollbackRetirementImpactSummaryReadModel } from "../api/admin-control-plane-read-model-contracts";
import type { CatalogIntegrationDataVerificationReport } from "../api/catalog-integration-data-migration-reset";
import {
  validateCatalogPrimaryWorkbenchReadModelContract,
  type CatalogPrimaryWorkbenchReadModel,
} from "../api/primary-workbench-admin-contracts";
import {
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
  type CatalogProviderIntegrationProfile,
} from "../api/provider-integration-profiles";
import { catalogProviderProfileEditableSectionKeys } from "../api/provider-profile-section-registry";
import {
  buildCatalogPrimaryWorkbenchReadModelForSurface,
  buildCatalogPrimaryWorkbenchSourceObservationReviewQuery,
  type CatalogPrimaryWorkbenchInput,
} from "./primary-workbench-read-model";
import {
  controlPlaneOverview,
  integrationJobSummary,
  profileAuthoringModel,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
} from "./primary-workbench-test-fixtures";

// Test-only convenience: the health surface renders every supporting slice
// (see buildCatalogPrimaryWorkbenchReadModelForSurface), so building it is the
// complete read model. No production route needs the unconditional build, but
// fixture setup across this feature's tests reads more clearly asking for "the
// read model" than pinning every call site to a specific surface.
export function buildCatalogPrimaryWorkbenchReadModel(
  input: CatalogPrimaryWorkbenchInput,
): CatalogPrimaryWorkbenchReadModel {
  return buildCatalogPrimaryWorkbenchReadModelForSurface("health", input);
}

export {
  buildCatalogPrimaryWorkbenchReadModelForSurface,
  buildCatalogPrimaryWorkbenchSourceObservationReviewQuery,
  catalogProviderProfileEditableSectionKeys,
  controlPlaneOverview,
  describe,
  expect,
  integrationJobSummary,
  it,
  profileAuthoringModel,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
  tcgdexPokemonCardSourceObservationMappingContract,
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
  validateCatalogPrimaryWorkbenchReadModelContract,
};
export type {
  CatalogAdminRollbackRetirementImpactSummaryReadModel,
  CatalogIntegrationDataVerificationReport,
  CatalogProviderIntegrationProfile,
};

export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function lifecycleImpact(
  operation: CatalogAdminRollbackRetirementImpactSummaryReadModel["operation"],
  overrides: Partial<CatalogAdminRollbackRetirementImpactSummaryReadModel> = {},
): CatalogAdminRollbackRetirementImpactSummaryReadModel {
  return {
    generatedAt: "2026-06-09T01:05:00.000Z",
    unitKey: "tcgdex:pokemon:card:import",
    profile: {
      schemaVersion: "catalog-provider-profile-version-v1",
      compatibilityPolicy: "provider-profile-version",
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04",
      lifecycle: "active",
      active: true,
      connectorKind: "tcgdex-json",
      connectorSourceVersion: null,
      sourceMappingFingerprint: "sha256:mapping",
    },
    operation,
    referencedObservationCount: 0,
    sourceProfileReferenceCount: 0,
    promotionProfileReferenceCount: 0,
    impactedCatalogItemCount: 0,
    impactedCatalogItemIds: [],
    externalReferenceCount: 0,
    externalReferenceSamples: [],
    sampleObservationIds: [],
    impactedJobCount: 0,
    allowed: true,
    blockers: [],
    ...overrides,
  };
}

export function cleanVerificationReport(
  overrides: Partial<CatalogIntegrationDataVerificationReport> = {},
): CatalogIntegrationDataVerificationReport {
  return {
    providerProfileVersions: 3,
    adminAuthoredProfileVersions: 1,
    referencedProfileVersions: 0,
    activeProviderProfiles: 3,
    sourceObservations: 0,
    legacySourceObservationReferences: 0,
    integrationDurableJobs: 0,
    activeIntegrationDurableJobs: 0,
    integrationWorkUnits: 0,
    bulkReviewJobs: 0,
    activeBulkReviewJobs: 0,
    bulkReviewWorkUnits: 0,
    profileSections: 24,
    profileSectionDiagnostics: 0,
    providerOptionQueryCacheEntries: 0,
    providerOptionRateLimits: 0,
    ...overrides,
  };
}
