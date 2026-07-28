import { t } from "@chase-sets/localization";
import type {
  SourceObservationExternalReferenceImpactSample,
  SourceObservationLifecycleImpactSummary,
  SourceObservationReplayImpactSummary,
} from "../../read-model/queries";
import type {
  CatalogAdminControlPlaneDiagnostic,
  CatalogAdminProfileVersionPointer,
  CatalogAdminReplayReapplyImpactSummaryReadModel,
  CatalogAdminRollbackRetirementImpactSummaryReadModel,
} from "../admin/admin-control-plane-read-model-contracts";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../provider-integration-profiles";
import {
  catalogProviderSourceMappingFingerprint,
  type CatalogProviderSourceObservationMappingContract,
} from "../promotion/provider-source-observation-normalizer";
import { assembleCatalogProviderIngestionUnitProfileSections } from "../providers/provider-profile-sections";
import type { CatalogIntegrationUnitKey } from "./integration-unit";

export type CatalogIntegrationImpactJobSample = Readonly<{
  jobId: string;
  jobKind: "integration" | "bulk-review";
  action: "import" | "reapply" | "promote" | "reject" | "defer";
  status: string;
  providerKey: string | null;
  profileVersion: string | null;
}>;

export function toCatalogAdminProfileVersionPointer(
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogAdminProfileVersionPointer {
  return {
    schemaVersion: "catalog-provider-profile-version-v1",
    compatibilityPolicy: "provider-profile-version",
    providerKey: version.providerKey,
    profileKey: version.profileKey,
    profileVersion: version.profileVersion,
    lifecycle: version.lifecycle,
    active: version.active,
    connectorKind: version.profile.connector.kind,
    connectorSourceVersion:
      version.profile.connector.kind === "tcgplayer-automation-client"
        ? version.profile.connector.sourceRepository.commit
        : null,
    sourceMappingFingerprint: sourceMappingFingerprintForProfileVersion(version),
  };
}

export function unitKeyForCatalogProviderProfileVersion(
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogIntegrationUnitKey {
  return assembleCatalogProviderIngestionUnitProfileSections(version).ingestionUnitIdentity.value.unitKey;
}

export function buildCatalogReplayReapplyImpactReadModel(input: {
  generatedAt?: string;
  unitKey: CatalogIntegrationUnitKey;
  profile: CatalogAdminProfileVersionPointer;
  impact: SourceObservationReplayImpactSummary;
  activeJobs?: readonly CatalogIntegrationImpactJobSample[];
}): CatalogAdminReplayReapplyImpactSummaryReadModel {
  const activeJobs = input.activeJobs ?? [];

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    unitKey: input.unitKey,
    profile: input.profile,
    matchedObservations: input.impact.matchedObservations,
    eligibleObservations: input.impact.eligibleObservations,
    blockedObservations: input.impact.blockedObservations,
    impactedCatalogItemCount: input.impact.impactedCatalogItemCount,
    impactedCatalogItemIds: input.impact.impactedCatalogItemIds,
    externalReferenceCount: input.impact.externalReferenceCount,
    externalReferenceSamples: input.impact.externalReferenceSamples.map(toReferenceSample),
    sampleObservationIds: input.impact.sampleObservationIds,
    activeJobCount: activeJobs.length,
    activeJobSamples: activeJobs.slice(0, 10),
    diagnostics: reapplyDiagnostics(input.profile.providerKey, input.unitKey, input.impact, activeJobs),
  };
}

export function buildCatalogLifecycleImpactReadModel(input: {
  generatedAt?: string;
  unitKey: CatalogIntegrationUnitKey;
  profile: CatalogAdminProfileVersionPointer;
  operation: CatalogAdminRollbackRetirementImpactSummaryReadModel["operation"];
  impact: SourceObservationLifecycleImpactSummary;
  activeJobs?: readonly CatalogIntegrationImpactJobSample[];
}): CatalogAdminRollbackRetirementImpactSummaryReadModel {
  const activeJobs = input.activeJobs ?? [];
  const blockers = lifecycleBlockers(
    input.profile.providerKey,
    input.unitKey,
    input.operation,
    input.impact,
    activeJobs,
  );

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    unitKey: input.unitKey,
    profile: input.profile,
    operation: input.operation,
    referencedObservationCount: input.impact.referencedObservationCount,
    sourceProfileReferenceCount: input.impact.sourceProfileReferenceCount,
    promotionProfileReferenceCount: input.impact.promotionProfileReferenceCount,
    impactedCatalogItemCount: input.impact.impactedCatalogItemCount,
    impactedCatalogItemIds: input.impact.impactedCatalogItemIds,
    externalReferenceCount: input.impact.externalReferenceCount,
    externalReferenceSamples: input.impact.externalReferenceSamples.map(toReferenceSample),
    sampleObservationIds: input.impact.sampleObservationIds,
    impactedJobCount: activeJobs.length,
    allowed: blockers.length === 0,
    blockers,
  };
}

function reapplyDiagnostics(
  providerKey: string,
  unitKey: CatalogIntegrationUnitKey,
  impact: SourceObservationReplayImpactSummary,
  activeJobs: readonly CatalogIntegrationImpactJobSample[],
): readonly CatalogAdminControlPlaneDiagnostic[] {
  const diagnostics: CatalogAdminControlPlaneDiagnostic[] = [];

  if (impact.blockedObservations > 0) {
    diagnostics.push(
      diagnostic({
        code: "reapply-scope-ineligible-observations",
        severity: "warning",
        diagnosticText: t(
          "catalog.features.sourceObservations.api.catalogIntegrationImpactAnalysis.reapply.ineligible",
          { count: String(impact.blockedObservations) },
        ),
        path: "scope.status",
        providerKey,
        unitKey,
      }),
    );
  }

  if (activeJobs.length > 0) {
    diagnostics.push(
      diagnostic({
        code: "reapply-scope-active-jobs",
        severity: "warning",
        diagnosticText: t("catalog.features.sourceObservations.api.catalogIntegrationImpactAnalysis.reapply.jobs", {
          count: String(activeJobs.length),
        }),
        path: "jobs.active",
        providerKey,
        unitKey,
      }),
    );
  }

  return diagnostics;
}

function lifecycleBlockers(
  providerKey: string,
  unitKey: CatalogIntegrationUnitKey,
  operation: CatalogAdminRollbackRetirementImpactSummaryReadModel["operation"],
  impact: SourceObservationLifecycleImpactSummary,
  activeJobs: readonly CatalogIntegrationImpactJobSample[],
): readonly CatalogAdminControlPlaneDiagnostic[] {
  const blockers: CatalogAdminControlPlaneDiagnostic[] = [];

  if (activeJobs.length > 0) {
    blockers.push(
      diagnostic({
        code: "profile-lifecycle-active-jobs",
        severity: "error",
        diagnosticText: t("catalog.features.sourceObservations.api.catalogIntegrationImpactAnalysis.lifecycle.jobs", {
          count: String(activeJobs.length),
        }),
        path: "jobs.active",
        providerKey,
        unitKey,
      }),
    );
  }

  if (operation === "retire" && impact.referencedObservationCount > 0) {
    blockers.push(
      diagnostic({
        code: "profile-retirement-referenced-observations",
        severity: "error",
        diagnosticText: t(
          "catalog.features.sourceObservations.api.catalogIntegrationImpactAnalysis.lifecycle.retirement.references",
          { count: String(impact.referencedObservationCount) },
        ),
        path: "profileVersion.references",
        providerKey,
        unitKey,
      }),
    );
  }

  return blockers;
}

function diagnostic(input: {
  code: string;
  severity: "warning" | "error";
  diagnosticText: string;
  path: string;
  providerKey: string;
  unitKey: CatalogIntegrationUnitKey;
}): CatalogAdminControlPlaneDiagnostic {
  return {
    code: input.code,
    severity: input.severity,
    diagnosticText: input.diagnosticText,
    path: input.path,
    providerKey: input.providerKey,
    adapterKey: null,
    unitKey: input.unitKey,
    source: "catalog",
  };
}

function toReferenceSample(sample: SourceObservationExternalReferenceImpactSample) {
  return {
    observationId: sample.observationId,
    referenceKind: sample.referenceKind,
    providerKey: sample.providerKey,
    externalKey: sample.externalKey,
    catalogItemId: sample.catalogItemId,
  };
}

function sourceMappingFingerprintForProfileVersion(
  version: CatalogProviderIntegrationProfileVersionRecord,
): string | null {
  const contract = sourceObservationMappingContract(version.executableMappingContract);
  return contract ? catalogProviderSourceMappingFingerprint(contract) : null;
}

function sourceObservationMappingContract(
  contract: CatalogProviderIntegrationProfileVersionRecord["executableMappingContract"],
): CatalogProviderSourceObservationMappingContract | null {
  if (!contract || !("sourceObservation" in contract) || !("normalizedObservation" in contract)) {
    return null;
  }

  return contract as CatalogProviderSourceObservationMappingContract;
}
