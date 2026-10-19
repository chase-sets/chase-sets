import type { JsonValue } from "@chase-sets/primitives/json";
import type { CatalogMergeCandidateReviewCommandPreview } from "../promotion/catalog-merge-candidate-review-command-payloads";
import type {
  CatalogAdminControlPlaneQueryKey,
  CatalogAdminControlPlaneDiagnostic,
  CatalogAdminRollbackRetirementImpactSummaryReadModel,
  CatalogAdminJobConsistency,
  CatalogAdminProfileVersionPointer,
} from "./admin-control-plane-read-model-contracts";
import type {
  CatalogAdminControlPlaneFreshnessState,
  CatalogAdminControlPlanePaginationMode,
} from "./admin-control-plane-read-model-slos";
import type {
  CatalogIntegrationAuditEvidenceCategory,
  CatalogIntegrationAuditEvidenceEventName,
  CatalogIntegrationAuditEvidenceRedactionState,
} from "../governance/catalog-integration-audit-evidence";
import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import type { CatalogIntegrationProviderUsageBudget } from "./admin-control-plane-overview";
import type { CatalogProviderProfileEditableSectionKey } from "../providers/provider-profile-section-registry";
import type { CatalogControlPlaneActionId } from "../../ui/admin-control-plane/information-architecture-v2";
import type {
  CatalogPrimaryWorkbenchContractVersion,
  CatalogPrimaryWorkbenchSectionKey,
  CatalogPrimaryWorkbenchCommandKey,
  CatalogPrimaryWorkbenchSourceObservationRowActionKey,
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchProviderTransportCategory,
  CatalogPrimaryWorkbenchPromotionDisposition,
  CatalogPrimaryWorkbenchPromotionScopeKind,
  CatalogPrimaryWorkbenchPromotionOutcomeCountKey,
  CatalogPrimaryWorkbenchPromotionStaleProtectionKey,
  CatalogPrimaryWorkbenchPromotionProfileSemantics,
  CatalogPrimaryWorkbenchRouteContextKey,
  CatalogPrimaryWorkbenchCopyKey,
  CatalogPrimaryWorkbenchInstrumentationDimension,
  CatalogPrimaryWorkbenchDeploySkewMode,
  CatalogPrimaryWorkbenchDeploySkewPolicy,
  CatalogPrimaryWorkbenchRetirementPolicy,
  CatalogPrimaryWorkbenchBlockerContract,
  CatalogPrimaryWorkbenchSectionContract,
  CatalogPrimaryWorkbenchActionContract,
  CatalogPrimaryWorkbenchDownstreamIssueKey,
  CatalogPrimaryWorkbenchDownstreamContract,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
  CatalogPrimaryWorkbenchScopeContext,
  CatalogPrimaryWorkbenchProviderScopeReadModel,
  CatalogPrimaryWorkbenchSourceOptionsStatus,
  CatalogPrimaryWorkbenchSourceOptionPageState,
  CatalogPrimaryWorkbenchSourceOptionKindReadModel,
  CatalogPrimaryWorkbenchSourceOptionPageReadModel,
  CatalogPrimaryWorkbenchSourceOptionsReadModel,
} from "./primary-workbench-selection-contracts";
import type {
  CatalogPrimaryWorkbenchReadinessReadModel,
  CatalogPrimaryWorkbenchHealthTriageStatus,
  CatalogPrimaryWorkbenchValidationFixtureFlowStatus,
  CatalogPrimaryWorkbenchValidationReadinessReadModel,
  CatalogPrimaryWorkbenchValidationEvidenceRow,
  CatalogPrimaryWorkbenchProfileAuthoringStatus,
  CatalogPrimaryWorkbenchProfileLifecycleRestrictionCode,
  CatalogPrimaryWorkbenchProfileImmutableFactKey,
  CatalogPrimaryWorkbenchProfileImmutableFact,
  CatalogPrimaryWorkbenchProfileLifecycleRestriction,
  CatalogPrimaryWorkbenchProfileOption,
  CatalogPrimaryWorkbenchProfileOverview,
  CatalogPrimaryWorkbenchProfileSectionGroupKey,
  CatalogPrimaryWorkbenchProfileSectionSaveOutcome,
  CatalogPrimaryWorkbenchProfileSectionFieldControl,
  CatalogPrimaryWorkbenchProfileSectionField,
  CatalogPrimaryWorkbenchProfileOptionQueryDetail,
  CatalogPrimaryWorkbenchProfileImportScopeControl,
  CatalogPrimaryWorkbenchProfileMappingRow,
  CatalogPrimaryWorkbenchProfileSectionWorkspace,
  CatalogPrimaryWorkbenchProfileCloneDraftReadModel,
  CatalogPrimaryWorkbenchProfileAuthoringReadModel,
  CatalogPrimaryWorkbenchImportJobsReadModel,
} from "./primary-workbench-profile-readiness-contracts";
import type {
  CatalogPrimaryWorkbenchHealthTriageReadModel,
  CatalogPrimaryWorkbenchHealthTriageReadModelState,
  CatalogPrimaryWorkbenchHealthTriageUnit,
  CatalogPrimaryWorkbenchHealthTriageProvider,
  CatalogPrimaryWorkbenchValidationReadinessStatus,
  CatalogPrimaryWorkbenchLifecycleOperation,
  CatalogPrimaryWorkbenchLifecycleRecoveryStatus,
  CatalogPrimaryWorkbenchLifecycleRecoveryReadModel,
  CatalogPrimaryWorkbenchLifecycleOperationReadModel,
  CatalogPrimaryWorkbenchGovernanceControlsStatus,
  CatalogPrimaryWorkbenchGovernanceControlKind,
  CatalogPrimaryWorkbenchGovernanceObservabilitySignalKey,
  CatalogPrimaryWorkbenchGovernanceControlsReadModel,
  CatalogPrimaryWorkbenchAuditEvidenceStatus,
  CatalogPrimaryWorkbenchAuditEvidenceFilterKey,
  CatalogPrimaryWorkbenchAuditEvidenceTargetType,
  CatalogPrimaryWorkbenchAuditEvidenceReadModel,
  CatalogPrimaryWorkbenchAuditEvidenceLink,
  CatalogPrimaryWorkbenchHealthTriageRolloutControl,
  CatalogPrimaryWorkbenchHealthTriageJob,
  CatalogPrimaryWorkbenchHealthTriageAuditPreview,
} from "./primary-workbench-lifecycle-governance-contracts";
import type {
  CatalogPrimaryWorkbenchSourceObservationReviewReadModel,
  CatalogPrimaryWorkbenchSourceObservationReviewRow,
  CatalogPrimaryWorkbenchSourceObservationEvidenceDetail,
  CatalogPrimaryWorkbenchProductContentsEvidenceState,
  CatalogPrimaryWorkbenchProductContentsEvidenceReview,
  CatalogPrimaryWorkbenchProductContentsEvidenceLine,
  CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData,
  CatalogPrimaryWorkbenchMergeCandidateActionKey,
  CatalogPrimaryWorkbenchMergeCandidateReviewReadModel,
  CatalogPrimaryWorkbenchMergeCandidateReviewRow,
  CatalogPrimaryWorkbenchMergeCandidateEditFieldOverride,
  CatalogPrimaryWorkbenchMergeCandidateEditReference,
  CatalogPrimaryWorkbenchMergeCandidateEditFormReadModel,
  CatalogPrimaryWorkbenchConflictResolutionStatus,
  CatalogPrimaryWorkbenchConflictResolutionState,
  CatalogPrimaryWorkbenchConflictResolutionReadModel,
  CatalogPrimaryWorkbenchConflictResolutionRow,
  CatalogPrimaryWorkbenchPromotionValidationReadModel,
  CatalogPrimaryWorkbenchPromotionIdentityDiagnostic,
  CatalogPrimaryWorkbenchPromotionPreviewReadModel,
  CatalogPrimaryWorkbenchPromotionResultReadModel,
  CatalogPrimaryWorkbenchActionReadModel,
  CatalogPrimaryWorkbenchSecurityPrivacyReadModel,
  CatalogPrimaryWorkbenchInstrumentationReadModel,
} from "./primary-workbench-promotion-review-contracts";

type CatalogPrimaryWorkbenchCatalogSyncStatus = "scope-required" | "ready" | "blocked" | "degraded";

type CatalogPrimaryWorkbenchCatalogSyncReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchCatalogSyncStatus;
  generatedAt: string;
  scope: Readonly<{
    scopeVersion: "catalog-sync-scope-v2";
    productDomain: string | null;
    productForm: string | null;
    languageCode: string | null;
    reference: Readonly<{
      kind: "product-line" | "series" | "expansion" | "set" | "catalog-item" | null;
      scopeRecordId: string | null;
    }>;
    label: string;
    hasConcreteScope: boolean;
  }>;
  preview: Readonly<{
    previewVersion: "catalog-sync-provider-participation-preview-v1";
    status: "ready" | "degraded" | "blocked";
    startAllowed: boolean;
    explanation: string;
    estimate: Readonly<{
      totalEstimatedRequestCount: number | null;
      estimateState: "estimated" | "estimate-unavailable";
      estimateReason: string | null;
      creditConsumingProviders: readonly Readonly<{
        providerKey: string;
        displayName: string;
        unitKeys: readonly string[];
      }>[];
    }>;
    blockers: readonly Readonly<{
      code: string;
      severity: "info" | "warning" | "error";
      message: string;
      providerKey: string;
      unitKey: string | null;
    }>[];
    units: readonly CatalogPrimaryWorkbenchCatalogSyncUnitReadModel[];
  }>;
  action: CatalogPrimaryWorkbenchActionReadModel;
}>;

type CatalogPrimaryWorkbenchCatalogSyncUnitReadModel = Readonly<{
  providerKey: string;
  unitKey: string | null;
  displayName: string;
  profileVersion: string | null;
  productDomain: string | null;
  productForm: string | null;
  role: "primary" | "supplementary" | "reference";
  requirement: "required" | "optional";
  selected: boolean;
  eligibility: "eligible" | "blocked";
  childExecutionScope: Readonly<Record<string, string>> | null;
  estimate: Readonly<{
    estimateState: "estimated" | "estimate-unavailable";
    estimatedRequestCount: number | null;
    estimateReason: string | null;
  }> | null;
  blockers: readonly Readonly<{
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
  }>[];
}>;

type CatalogPrimaryWorkbenchSourceScopeWorksetStatus =
  | "not-configured"
  | "scope-required"
  | "ready"
  | "blocked"
  | "degraded";

type CatalogPrimaryWorkbenchSourceScopeWorksetUnitState =
  | "not-imported"
  | "imported"
  | "changed"
  | "promoted"
  | "blocked";

type CatalogPrimaryWorkbenchSourceScopeWorksetReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchSourceScopeWorksetStatus;
  generatedAt: string;
  selectedScope: Readonly<{
    importScope: string | null;
    label: string;
    hasConcreteScope: boolean;
    scope: CatalogPrimaryWorkbenchScopeContext;
  }>;
  summary: Readonly<{
    unitCount: number;
    readyUnitCount: number;
    blockedUnitCount: number;
    activeImportCount: number;
    changedObservationCount: number;
    promotedObservationCount: number;
  }>;
  units: readonly CatalogPrimaryWorkbenchSourceScopeWorksetUnitReadModel[];
}>;

type CatalogPrimaryWorkbenchSourceScopeWorksetUnitReadModel = Readonly<{
  providerKey: string;
  displayName: string;
  unitKey: CatalogIntegrationUnitKey | null;
  productDomain: string | null;
  productForm: string | null;
  profileVersion: string | null;
  importScope: string | null;
  profileReady: boolean;
  optionQueryState: CatalogPrimaryWorkbenchSourceOptionsStatus;
  state: CatalogPrimaryWorkbenchSourceScopeWorksetUnitState;
  counts: Readonly<{
    observed: number;
    changed: number;
    promoted: number;
    rejected: number;
    eligible: number;
  }>;
  activeJobCount: number;
  lastJobState: CatalogPrimaryWorkbenchImportJobsReadModel["jobs"][number]["state"] | null;
  currentWorkbenchHref: string;
  commandContext: Readonly<{
    providerKey: string;
    productId: string | null;
    unitKey: CatalogIntegrationUnitKey | null;
    importScope: string | null;
    profileVersion: string | null;
    languageCode: string | null;
    productLineId: string | null;
    productLineName: string | null;
    seriesId: string | null;
    seriesName: string | null;
    expansionId: string | null;
    expansionName: string | null;
  }>;
  actions: Readonly<{
    import: CatalogPrimaryWorkbenchActionReadModel;
    previewPromotion: CatalogPrimaryWorkbenchActionReadModel;
    reapply: CatalogPrimaryWorkbenchActionReadModel;
  }>;
}>;

export type {
  CatalogPrimaryWorkbenchCatalogSyncStatus,
  CatalogPrimaryWorkbenchCatalogSyncReadModel,
  CatalogPrimaryWorkbenchCatalogSyncUnitReadModel,
  CatalogPrimaryWorkbenchSourceScopeWorksetStatus,
  CatalogPrimaryWorkbenchSourceScopeWorksetUnitState,
  CatalogPrimaryWorkbenchSourceScopeWorksetReadModel,
  CatalogPrimaryWorkbenchSourceScopeWorksetUnitReadModel,
};

export function assertPrimaryWorkbenchImportJobs(value: CatalogPrimaryWorkbenchImportJobsReadModel | undefined): void {
  if (!value) throw new Error("Primary workbench import jobs contract is required.");
  if (!Array.isArray(value.jobs)) throw new Error("Primary workbench import jobs must expose a list.");
}

export function assertPrimaryWorkbenchSourceScopeWorkset(
  value: CatalogPrimaryWorkbenchSourceScopeWorksetReadModel | undefined,
): void {
  if (!value) throw new Error("Primary workbench source scope workset contract is required.");
  if (!Array.isArray(value.units)) throw new Error("Primary workbench source scope workset must expose units.");
}
