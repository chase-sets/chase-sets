import type { ListResponse } from "@chase-sets/http/responses";
import { t } from "@chase-sets/localization";
import type { CatalogAdminRollbackRetirementImpactSummaryReadModel } from "../api/admin-control-plane-read-model-contracts";
import {
  catalogPrimaryWorkbenchActions,
  catalogPrimaryWorkbenchContractVersion,
  catalogPrimaryWorkbenchDeploySkewPolicies,
  catalogPrimaryWorkbenchInstrumentationDimensions,
  catalogPrimaryWorkbenchRetirementPolicy,
  validateCatalogPrimaryWorkbenchReadModelContract,
  type CatalogPrimaryWorkbenchActionReadModel,
  type CatalogPrimaryWorkbenchBlockerCategory,
  type CatalogPrimaryWorkbenchCommandKey,
  type CatalogPrimaryWorkbenchHealthTriageReadModel,
  type CatalogPrimaryWorkbenchLifecycleOperation,
  type CatalogPrimaryWorkbenchProviderTransportCategory,
  type CatalogPrimaryWorkbenchPromotionStaleProtectionKey,
  type CatalogPrimaryWorkbenchReadModel,
  type CatalogPrimaryWorkbenchRouteContext,
  type CatalogPrimaryWorkbenchValidationEvidenceRow,
} from "../api/primary-workbench-admin-contracts";
import {
  catalogIntegrationDataResetEnvironmentPlans,
  catalogIntegrationDataResetTargetTables,
  evaluateCatalogIntegrationDataResetEvidence,
  type CatalogIntegrationDataBackfillDecision,
  type CatalogIntegrationDataResetEvidencePacket,
} from "../api/catalog-integration-data-reset-evidence";
import { defineCatalogIntegrationUnitKey, type CatalogIntegrationUnitKey } from "../api/integration-unit";
import { catalogProviderRequiredFixtureFlows } from "../api/provider-integration-mapping-contract";
import {
  catalogProviderProfileEditableSectionMetadata,
  type CatalogProviderProfileEditableSectionKey,
} from "../api/provider-profile-section-registry";
import type {
  CatalogIntegrationControlPlaneOverview,
  CatalogProviderProfileAuthoringModel,
  CatalogProviderProfileVersionReview,
  SourceObservationListItem,
  SourceObservationIntegrationScope,
} from "./contracts";
import {
  catalogPrimaryWorkbenchHref,
  catalogPrimaryWorkbenchReturnPath,
  catalogPrimaryWorkbenchSupportingHref,
  parseCatalogPrimaryWorkbenchRouteContext,
} from "./primary-workbench-route-context";

export type CatalogPrimaryWorkbenchInput = Readonly<{
  requestUrl: string | URL;
  scopes: ListResponse<SourceObservationIntegrationScope>;
  profileReviews: ListResponse<CatalogProviderProfileVersionReview>;
  profileAuthoringModel?: CatalogProviderProfileAuthoringModel | null;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  cleanResetEvidence?: CatalogIntegrationDataResetEvidencePacket | null;
  temporaryReleaseScaffolding?: readonly CatalogPrimaryWorkbenchTemporaryReleaseScaffoldingInput[] | null;
  lifecycleImpacts?: Partial<
    Record<CatalogPrimaryWorkbenchLifecycleOperation, CatalogAdminRollbackRetirementImpactSummaryReadModel>
  > | null;
  reviewObservations?: ListResponse<SourceObservationListItem> | null;
  reviewPagination?: Readonly<{ limit: number; offset: number }>;
  canManageCatalog: boolean;
}>;

export type CatalogPrimaryWorkbenchTemporaryReleaseScaffoldingInput = Readonly<{
  key: string;
  label: string;
  status: "not-used" | "removal-required" | "removed";
  ownerIssue: "#1054" | "#1061" | "#1090";
  evidenceUrl?: string | null;
  removalEvidence?: string | null;
}>;

type CatalogIntegrationRecentJobReadModel =
  CatalogIntegrationControlPlaneOverview["unitActivity"]["units"][number]["recentJobs"][number];
type ProfileSectionWorkspace = CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["sectionWorkspaces"][number];
type ProfileSectionField = ProfileSectionWorkspace["fields"][number];
type ProfileOptionQueryDetail = ProfileSectionWorkspace["optionQueries"][number];
type ProfileImportScopeControl = ProfileSectionWorkspace["importScopeControls"][number];
type ProfileMappingRow = ProfileSectionWorkspace["mappingRows"][number];
type ValidationReadiness = CatalogPrimaryWorkbenchReadModel["validationReadiness"];
type ValidationFixtureFlow = ValidationReadiness["fixtureFlows"][number];
type ValidationDryRunEvidence = ValidationReadiness["dryRunEvidence"][number];
type ValidationSemanticSection = ValidationReadiness["semanticCompare"]["sections"][number];
type ValidationActivationGroup = ValidationReadiness["activationReadiness"]["groups"][number];
type ValidationActivationDecision = ValidationReadiness["activationDecision"];
type LifecycleRecovery = CatalogPrimaryWorkbenchReadModel["lifecycleRecovery"];
type LifecycleOperationRow = LifecycleRecovery["operations"][number];
type ConflictResolution = CatalogPrimaryWorkbenchReadModel["conflictResolution"];
type ConflictResolutionRow = ConflictResolution["rows"][number];
type GovernanceControls = CatalogPrimaryWorkbenchReadModel["governanceControls"];
type GovernanceControlRow = GovernanceControls["controls"][number];
type GovernanceRbacRow = GovernanceControls["rbacMatrix"][number];
type GovernanceObservabilitySignal = GovernanceControls["observability"]["signals"][number];
type AuditEvidence = CatalogPrimaryWorkbenchReadModel["auditEvidence"];
type AuditEvidenceLink = AuditEvidence["evidenceLinks"][number];
type AuditTimelineRow = AuditEvidence["timeline"][number];
type ReleaseEvidenceChecklistRow = AuditEvidence["releaseChecklist"][number];
type CleanResetRelease = CatalogPrimaryWorkbenchReadModel["cleanResetRelease"];
type CleanResetDecisionRow = CleanResetRelease["decisions"][number];
type CleanResetBackfillRow = CleanResetRelease["backfill"][number];
type CleanResetScaffoldingRow = CleanResetRelease["temporaryScaffolding"][number];

const defaultReviewPageSize = 25;
const providerOptionQueryFreshTtlMinutes = 15;
const providerOptionQueryStaleTtlHours = 24;
const catalogIntegrationGrafanaDashboardHref =
  "https://grafana.chasesets.com/d/chase-sets-catalog-integration-control-plane/catalog-integration-control-plane";
const catalogIntegrationOperationsRunbookHref =
  "https://github.com/chase-sets/chase-sets/blob/main/docs/runbooks/catalog-integration-operations.md";

export function buildCatalogPrimaryWorkbenchReadModel(
  input: CatalogPrimaryWorkbenchInput,
): CatalogPrimaryWorkbenchReadModel {
  const parsedContext = parseCatalogPrimaryWorkbenchRouteContext(input.requestUrl);
  const providerKey = parsedContext.providerKey ?? inferProviderKey(input);
  const activeProfile = findActiveProfile(input.profileReviews.items, providerKey);
  const selectedProfile = findSelectedProfile(
    input.profileReviews.items,
    providerKey,
    parsedContext.profileVersion,
    activeProfile,
  );
  const unitKey = parsedContext.unitKey ?? inferUnitKey(input, providerKey, activeProfile);
  const importScope = parsedContext.importScope ?? inferImportScope(input.scopes.items, providerKey);
  const profileVersion = parsedContext.profileVersion ?? activeProfile?.profileVersion ?? null;
  const routeContext: CatalogPrimaryWorkbenchRouteContext = {
    ...parsedContext,
    providerKey,
    unitKey,
    importScope,
    profileVersion,
    sourceObservationFilters: {
      ...parsedContext.sourceObservationFilters,
      ...(providerKey ? { providerKey } : {}),
      ...(importScope ? { importScope } : {}),
    },
  };
  const scopeRows = providerKey
    ? input.scopes.items.filter((scope) => scope.provider_key === providerKey)
    : input.scopes.items;
  const observed = sum(scopeRows, (scope) => scope.observed_observations);
  const changed = sum(scopeRows, (scope) => scope.changed_observations);
  const promoted = sum(scopeRows, (scope) => scope.promoted_observations);
  const rejected = sum(scopeRows, (scope) => scope.rejected_observations);
  const eligible = Math.max(observed + changed, 0);
  const providerTransport = providerTransportFor(input.controlPlaneOverview, providerKey);
  const readinessBlockers = readinessBlockersFor(input, providerKey, activeProfile);
  const rolloutEnabled =
    input.controlPlaneOverview?.readiness.rolloutControls.controls.every((control) => control.status !== "blocked") ??
    true;
  const importJobRows = importJobsFor(input.controlPlaneOverview, routeContext);
  const activeJobCount = importJobRows.filter((job) => job.state === "queued" || job.state === "running").length;
  const failedJobCount = importJobRows.filter((job) => job.state === "failed").length;
  const canManage = input.canManageCatalog;
  const generatedAt = input.controlPlaneOverview?.generatedAt ?? new Date().toISOString();
  const healthTriage = healthTriageFor({
    overview: input.controlPlaneOverview,
    routeContext,
    importJobs: importJobRows,
  });
  const profileAuthoring = profileAuthoringFor({
    activeJobCount,
    activeProfile,
    canManage,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt,
    profiles: input.profileReviews.items,
    providerKey,
    requestedProfileVersion: parsedContext.profileVersion,
    requestUrl: input.requestUrl,
    routeContext,
    selectedProfile,
    scopes: input.scopes.items,
  });
  const validationReadiness = validationReadinessFor({
    activeJobCount,
    authoringModel: input.profileAuthoringModel ?? null,
    canManage,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt,
    profileAuthoring,
    routeContext,
    selectedProfile,
  });
  const lifecycleRecovery = lifecycleRecoveryFor({
    activeJobCount,
    activeProfile,
    canManage,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt,
    lifecycleImpacts: input.lifecycleImpacts ?? null,
    profiles: input.profileReviews.items,
    providerKey,
    routeContext,
    selectedProfile,
    validationReadiness,
  });
  const sourceObservationReview = sourceObservationReviewFor({
    canManage,
    changed,
    eligible,
    observed,
    promoted,
    readinessBlockers,
    rejected,
    reviewObservations: input.reviewObservations ?? null,
    reviewPagination: input.reviewPagination,
    routeContext,
    scopeRows,
  });
  const promotionPreview = promotionPreviewFor({
    activeJobCount,
    activeProfileVersion: activeProfile?.profileVersion ?? null,
    canManage,
    failedJobCount,
    readinessBlockers,
    routeContext,
    sourceObservationReview,
  });
  const conflictResolution = conflictResolutionFor({
    canManage,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt,
    promotionPreview,
    routeContext,
    sourceObservationReview,
  });
  const actions = buildActions({
    canManage,
    providerSelected: Boolean(providerKey && unitKey && importScope),
    activeProfileReady: Boolean(activeProfile),
    eligible: promotionPreview.outcomeCounts.eligible,
    reviewable: sourceObservationReview.counts.observed + sourceObservationReview.counts.changed,
    activeJobCount,
    blockers: readinessBlockers,
    activationBlockers: validationReadiness.activationDecision.blockers,
    cloneProfileBlockers: profileAuthoring.cloneDraft.blockers,
    lifecycleOperations: lifecycleRecovery.operations,
    promotionBlockers: promotionPreview.blockers,
  });
  const governanceControls = governanceControlsFor({
    actions,
    canManage,
    conflictResolution,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt,
    healthTriage,
    importJobs: importJobRows,
    readinessBlockers,
    rolloutEnabled,
    routeContext,
    sourceObservationReview,
  });
  const securityPrivacy = {
    redactionApplied: true,
    governedDataClasses: ["provider payload", "operator identity", "external source URLs"],
    unsafeEvidenceBlocked: false,
    missingSecurityFieldsBlocker: "security-privacy-blocked",
  } satisfies CatalogPrimaryWorkbenchReadModel["securityPrivacy"];
  const auditEvidence = auditEvidenceFor({
    conflictResolution,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt,
    governanceControls,
    healthTriage,
    importJobs: importJobRows,
    lifecycleRecovery,
    promotionPreview,
    routeContext,
    securityPrivacy,
    sourceObservationReview,
    validationReadiness,
  });
  const cleanResetRelease = cleanResetReleaseFor({
    auditEvidence,
    cleanResetEvidence: input.cleanResetEvidence ?? null,
    generatedAt,
    importJobs: importJobRows,
    routeContext,
    sourceObservationReview,
    temporaryReleaseScaffolding: input.temporaryReleaseScaffolding ?? null,
  });

  const readModel: CatalogPrimaryWorkbenchReadModel = {
    schemaVersion: catalogPrimaryWorkbenchContractVersion,
    generatedAt,
    routeContext,
    providerScope: {
      providers: providerScopeProviders(input, providerKey, activeProfile),
    },
    readiness: {
      freshness: input.controlPlaneOverview ? "fresh" : "partial",
      blockers: readinessBlockers,
      providerTransport,
      rolloutEnabled,
      rbacAllowed: input.canManageCatalog,
      auditEvidenceUrl: catalogPrimaryWorkbenchSupportingHref(routeContext, "audit-evidence"),
    },
    healthTriage,
    profileAuthoring,
    validationReadiness,
    lifecycleRecovery,
    governanceControls,
    cleanResetRelease,
    auditEvidence,
    importJobs: {
      freshness: input.controlPlaneOverview ? "fresh" : "partial",
      activeJobCount,
      failedJobCount,
      selectedScope: selectedImportScopeFor({
        activeProfile,
        activeJobCount,
        blockers: readinessBlockers,
        input,
        importScope,
        providerKey,
        providerTransport,
        rolloutEnabled,
        unitKey,
      }),
      jobs: importJobRows,
    },
    sourceObservationReview,
    conflictResolution,
    promotionPreview,
    promotionResult: null,
    actions,
    deploySkew: catalogPrimaryWorkbenchDeploySkewPolicies[0],
    securityPrivacy,
    instrumentation: {
      dimensions: catalogPrimaryWorkbenchInstrumentationDimensions,
      redactionSafe: true,
    },
  };

  validateCatalogPrimaryWorkbenchReadModelContract(readModel);

  return readModel;
}

export function buildCatalogPrimaryWorkbenchSourceObservationReviewQuery(
  context: CatalogPrimaryWorkbenchRouteContext,
  pagination: Readonly<{ limit?: number; offset?: number }> = {},
): string | null {
  if (!context.providerKey) {
    return null;
  }

  const params = new URLSearchParams();
  params.set("provider", context.providerKey);
  params.set("limit", String(pagination.limit ?? defaultReviewPageSize));
  params.set("offset", String(pagination.offset ?? 0));
  setQueryParam(params, "status", context.sourceObservationFilters.status);
  setQueryParam(
    params,
    "language",
    context.sourceObservationFilters.language ?? importScopeSegment(context.importScope, 0),
  );
  setQueryParam(params, "setId", context.sourceObservationFilters.setId ?? importScopeSegment(context.importScope, 3));
  setQueryParam(params, "search", context.sourceObservationFilters.search);

  return params.toString();
}

function inferProviderKey(input: CatalogPrimaryWorkbenchInput): string | null {
  return (
    input.scopes.items[0]?.provider_key ??
    input.profileReviews.items.find((profile) => profile.active)?.providerKey ??
    input.profileReviews.items[0]?.providerKey ??
    null
  );
}

function inferUnitKey(
  input: CatalogPrimaryWorkbenchInput,
  providerKey: string | null,
  activeProfile: CatalogProviderProfileVersionReview | null,
): CatalogIntegrationUnitKey | null {
  const overviewUnit = input.controlPlaneOverview?.readiness.units.find((unit) => unit.providerKey === providerKey);
  if (overviewUnit) {
    return overviewUnit.unitKey;
  }
  if (!providerKey) {
    return null;
  }
  const supportedScope = activeProfile?.supportedScopes[0] ?? "catalog/source-observation";
  const [productDomain = "catalog", productForm = "source-observation"] = supportedScope.split("/");

  return defineCatalogIntegrationUnitKey({
    providerKey,
    productDomain: normalizeUnitSegment(productDomain),
    productForm: normalizeUnitSegment(productForm),
    ingestionPurpose: "import",
  });
}

function inferImportScope(
  scopes: readonly SourceObservationIntegrationScope[],
  providerKey: string | null,
): string | null {
  const scope = scopes.find((candidate) => !providerKey || candidate.provider_key === providerKey) ?? scopes[0];
  if (!scope) {
    return null;
  }

  return [scope.language_code, scope.product_line_id, scope.series_id, scope.expansion_id].filter(Boolean).join(":");
}

function findActiveProfile(
  profiles: readonly CatalogProviderProfileVersionReview[],
  providerKey: string | null,
): CatalogProviderProfileVersionReview | null {
  return (
    profiles.find((profile) => profile.providerKey === providerKey && profile.active) ??
    profiles.find((profile) => profile.active) ??
    null
  );
}

function findSelectedProfile(
  profiles: readonly CatalogProviderProfileVersionReview[],
  providerKey: string | null,
  requestedProfileVersion: string | null,
  activeProfile: CatalogProviderProfileVersionReview | null,
): CatalogProviderProfileVersionReview | null {
  const providerProfiles = providerKey ? profiles.filter((profile) => profile.providerKey === providerKey) : profiles;
  if (requestedProfileVersion) {
    return (
      providerProfiles.find((profile) => profile.profileVersion === requestedProfileVersion) ??
      profiles.find((profile) => profile.profileVersion === requestedProfileVersion && !providerKey) ??
      null
    );
  }

  return activeProfile ?? providerProfiles[0] ?? profiles[0] ?? null;
}

function profileAuthoringFor(input: {
  activeJobCount: number;
  activeProfile: CatalogProviderProfileVersionReview | null;
  canManage: boolean;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  generatedAt: string;
  profiles: readonly CatalogProviderProfileVersionReview[];
  providerKey: string | null;
  requestedProfileVersion: string | null;
  requestUrl: string | URL;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  selectedProfile: CatalogProviderProfileVersionReview | null;
  scopes: readonly SourceObservationIntegrationScope[];
}): CatalogPrimaryWorkbenchReadModel["profileAuthoring"] {
  const status =
    input.requestedProfileVersion && !input.selectedProfile
      ? "stale-selection"
      : input.selectedProfile
        ? "ready"
        : "missing-profile";
  const providerProfiles = input.providerKey
    ? input.profiles.filter((profile) => profile.providerKey === input.providerKey)
    : input.profiles;
  const selectedOverview = input.selectedProfile ? profileOverviewFor(input.selectedProfile) : null;
  const activeProfile = input.activeProfile ? profileOptionFor(input.activeProfile, input.routeContext) : null;
  const availableProfiles = providerProfiles.map((profile) => profileOptionFor(profile, input.routeContext));
  const cloneBlockers = cloneProfileBlockersFor({
    activeJobCount: input.activeJobCount,
    canManage: input.canManage,
    status,
  });
  const cloneState = actionStateForBlockers(cloneBlockers, "available");
  const submitHref = catalogPrimaryWorkbenchSupportingHref(input.routeContext, "profile-authoring");
  const sectionGroups = profileSectionGroups();
  const sectionWorkspaces = input.selectedProfile
    ? profileSectionWorkspacesFor({
        activeJobCount: input.activeJobCount,
        canManage: input.canManage,
        requestUrl: input.requestUrl,
        routeContext: input.routeContext,
        status,
        profile: input.selectedProfile,
        controlPlaneOverview: input.controlPlaneOverview,
        scopes: input.scopes,
        submitHref,
      })
    : [];

  return {
    status,
    generatedAt: input.generatedAt,
    selectedProfile: selectedOverview,
    activeProfile,
    availableProfiles,
    returnToPrimaryHref: catalogPrimaryWorkbenchReturnPath(input.routeContext),
    sectionGroups,
    sectionWorkspaces,
    cloneDraft: {
      commandKey: "clone-provider-profile",
      sourceProviderKey: input.selectedProfile?.providerKey ?? null,
      sourceProfileVersion: input.selectedProfile?.profileVersion ?? null,
      targetProfileVersion: input.selectedProfile
        ? nextDraftProfileVersion(input.selectedProfile, input.profiles)
        : null,
      targetLifecycle: "draft",
      state: cloneState,
      blockers: cloneBlockers,
      submitHref,
      lifecycleRestrictions: profileLifecycleRestrictionsFor(status, input.selectedProfile),
      immutableIdentityFacts: selectedOverview?.immutableIdentityFacts ?? [],
    },
  };
}

function profileSectionGroups(): CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["sectionGroups"] {
  return [
    {
      key: "profile-foundation",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.group.foundation"),
      sections: ["basics", "source-contract", "fixtures"],
    },
    {
      key: "provider-acquisition",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.group.provider"),
      sections: ["provider-options", "connector"],
    },
    {
      key: "observation-mapping",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.group.mapping"),
      sections: [
        "catalog-field-mapping",
        "source-observation",
        "normalized-observation",
        "external-references",
        "selected-options",
        "reference-hierarchy",
        "duplicate-prevention",
      ],
    },
    {
      key: "catalog-promotion",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.group.promotion"),
      sections: ["promotion-plan"],
    },
    {
      key: "evidence-lifecycle",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.group.evidence"),
      sections: ["migration-evidence", "retirement-plan"],
    },
  ];
}

function profileSectionWorkspacesFor(input: {
  activeJobCount: number;
  canManage: boolean;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  requestUrl: string | URL;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  status: CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["status"];
  profile: CatalogProviderProfileVersionReview;
  scopes: readonly SourceObservationIntegrationScope[];
  submitHref: string;
}): CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["sectionWorkspaces"] {
  const groups = profileSectionGroups();
  const groupBySection = new Map(groups.flatMap((group) => group.sections.map((section) => [section, group] as const)));
  const diagnosticsBySection = profileDiagnosticsBySection(input.profile);

  return catalogProviderProfileEditableSectionMetadata().map((metadata) => {
    const group = groupBySection.get(metadata.section);
    const saveOutcome = sectionSaveOutcomeFromUrl(input.requestUrl, metadata.section);
    const blockers = sectionBlockersFor({
      activeJobCount: input.activeJobCount,
      canManage: input.canManage,
      profile: input.profile,
      status: input.status,
      saveOutcome,
    });
    const actionState = actionStateForBlockers(blockers, input.canManage ? "available" : "denied");
    const disabled = actionState !== "available" && actionState !== "degraded";
    const diagnostics = diagnosticsBySection.get(metadata.section) ?? [];

    return {
      sectionKey: metadata.section,
      displayName: metadata.displayName,
      group: group?.key ?? "profile-foundation",
      groupLabel:
        group?.label ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.group.foundation"),
      description: profileSectionDescription(metadata.section),
      domainConcept: profileSectionDomainConcept(metadata.section),
      status: profileSectionStatus(input.profile, metadata.section, diagnostics),
      editable: !disabled,
      actionState,
      blockers,
      dirtyState: "clean",
      staleState: saveOutcome === "conflict" ? "conflict" : "fresh",
      saveOutcome,
      submitHref: input.submitHref,
      commandKey: "update-provider-profile-section",
      fields: profileSectionFields(input.profile, metadata.section, disabled),
      optionQueries: profileSectionOptionQueries(input.profile, metadata.section, input.controlPlaneOverview),
      importScopeControls: profileSectionImportScopeControls({
        profile: input.profile,
        routeContext: input.routeContext,
        scopes: input.scopes,
        section: metadata.section,
      }),
      mappingRows: profileSectionMappingRows(input.profile, metadata.section, diagnostics),
      diagnostics,
      semanticChangeCount: sectionChangeCount(input.profile, metadata.section),
      readinessCheckCount: diagnostics.length,
      anchorId: profileSectionAnchorId(metadata.section),
    };
  });
}

function profileSectionFields(
  profile: CatalogProviderProfileVersionReview,
  section: CatalogProviderProfileEditableSectionKey,
  disabled: boolean,
): readonly ProfileSectionField[] {
  const profileRecord = recordValue(profile.profile);
  const contractRecord = recordValue(profile.executableMappingContract);
  const sourceObservation = recordValue(contractRecord?.sourceObservation);
  const normalizedObservation = recordValue(contractRecord?.normalizedObservation);
  const externalReferences = firstRecord(arrayValue(contractRecord?.externalReferences));
  const selectedOptions = recordValue(contractRecord?.selectedOptions);
  const referenceHierarchy = firstRecord(arrayValue(contractRecord?.referenceHierarchy));
  const duplicatePrevention = recordValue(contractRecord?.duplicatePrevention);
  const promotionCommandPlan = recordValue(contractRecord?.promotionCommandPlan);
  const connector = recordValue(profileRecord?.connector);
  const mappingConnector = recordValue(contractRecord?.connector);
  const catalogFieldMapping = recordValue(profileRecord?.catalogFieldMapping);
  const optionQueries = arrayValue(profileRecord?.optionQueries);
  const firstOptionQuery = firstRecord(optionQueries);
  const selectedOptionMapping = recordValue(profileRecord?.selectedOptionMapping);
  const selectedOptionDimension = firstRecord(arrayValue(selectedOptionMapping?.dimensions));
  const referenceHierarchyMapping = recordValue(profileRecord?.referenceHierarchyMapping);
  const duplicatePreventionMapping = recordValue(profileRecord?.duplicatePreventionMapping);
  const retirementPlan = recordValue(profile.retirementPlan);

  switch (section) {
    case "basics":
      return [
        field("displayName", "Display name", profile.displayName, "text", disabled, true),
        field("lifecycle", "Lifecycle", profile.lifecycle, "select", disabled, true, null, [
          option("draft", "Draft"),
          option("test", "Test"),
        ]),
        field("status", "Status", profile.status, "select", disabled, true, null, [
          option("active", "Active"),
          option("planned", "Planned"),
        ]),
        field("capabilities", "Capabilities", profile.capabilities.join(", "), "tags", disabled),
        field("supportedScopes", "Supported scopes", profile.supportedScopes.join(", "), "tags", disabled),
        field("languageOptions", "Languages", profile.languageOptions.join(", "), "tags", disabled),
      ];
    case "provider-options":
      return [
        field("optionQueryIndex", "Option query", "0", "select", disabled || optionQueries.length === 0, true, null, [
          ...optionQueries.map((value, index) => {
            const record = recordValue(value);
            return option(String(index), stringValue(record?.displayName) ?? `Option query ${index + 1}`);
          }),
        ]),
        field(
          "optionQueryDisplayName",
          "Option label",
          stringValue(firstOptionQuery?.displayName) ?? "",
          "text",
          disabled,
        ),
        field("optionQueryScope", "Scope", stringValue(firstOptionQuery?.scope) ?? "", "text", disabled),
        field("optionQueryOperation", "Operation", stringValue(firstOptionQuery?.operation) ?? "", "text", disabled),
      ];
    case "connector":
      return [
        field("connectorKind", "Connector kind", profile.connectorKind, "text", disabled, true),
        field("connectorBaseUrl", "Base URL", stringValue(connector?.baseUrl) ?? "", "text", disabled),
        field(
          "connectorTransportOwns",
          "Transport responsibilities",
          stringArrayValue(mappingConnector?.transportOwns).join(", "),
          "tags",
          disabled,
        ),
        field(
          "connectorMappingOwns",
          "Mapping responsibilities",
          stringArrayValue(mappingConnector?.mappingOwns).join(", "),
          "tags",
          disabled,
        ),
      ];
    case "catalog-field-mapping":
      return [
        field("blueprintKey", "Blueprint key", stringValue(catalogFieldMapping?.blueprintKey) ?? "", "text", disabled),
        field("categoryKey", "Category key", stringValue(catalogFieldMapping?.categoryKey) ?? "", "text", disabled),
        field(
          "fieldKeyCount",
          "Mapped field count",
          String(recordKeys(catalogFieldMapping?.fieldKeys).length),
          "text",
          true,
        ),
      ];
    case "source-contract":
      return [
        field("sourceOwner", "Owner", profile.sourceContract.owner, "text", disabled, true),
        field("sourceRepository", "Repository", profile.sourceContract.repository ?? "", "text", disabled),
        field("sourceCommit", "Commit", profile.sourceContract.commit ?? "", "text", disabled),
        field("sourceDocumentPath", "Document path", profile.sourceContract.documentPath, "text", disabled, true),
        field(
          "fixtureSetVersion",
          "Fixture set version",
          profile.sourceContract.fixtureSetVersion,
          "text",
          disabled,
          true,
        ),
      ];
    case "fixtures":
      return [
        field("fixtureRoot", "Fixture root", profile.fixtures.fixtureRoot, "text", disabled, true),
        field("coveredFlows", "Covered flows", profile.fixtures.coveredFlows.join(", "), "tags", disabled),
        field(
          "liveProviderCallsAllowed",
          "Live provider calls",
          String(profile.fixtures.liveProviderCallsAllowed),
          "checkbox",
          true,
          false,
          "Offline fixture validation is required for launch.",
        ),
      ];
    case "source-observation":
      return [
        field(
          "observationIdPath",
          "Observation id source",
          expressionSummary(sourceObservation?.observationId),
          "text",
          disabled,
        ),
        field(
          "externalKeyPath",
          "External key source",
          expressionSummary(sourceObservation?.externalKey),
          "text",
          disabled,
        ),
        field("sourceUrlPath", "Source URL source", expressionSummary(sourceObservation?.sourceUrl), "text", disabled),
        field(
          "sourceUpdatedAtPath",
          "Source updated source",
          expressionSummary(sourceObservation?.sourceUpdatedAt),
          "text",
          disabled,
        ),
      ];
    case "normalized-observation":
      return [
        field(
          "normalizedOutputKind",
          "Output kind",
          stringValue(normalizedObservation?.outputKind) ?? profile.mappingOutputKind,
          "text",
          disabled,
          true,
        ),
        field(
          "normalizedLanguagePath",
          "Language source",
          expressionSummary(normalizedObservation?.languageCode),
          "text",
          disabled,
        ),
        field(
          "normalizedFieldCount",
          "Normalized field count",
          String(recordKeys(normalizedObservation?.fields).length),
          "text",
          true,
        ),
        field(
          "hashMaterialCount",
          "Hash material count",
          String(arrayValue(normalizedObservation?.hashMaterial).length),
          "text",
          true,
        ),
      ];
    case "external-references":
      return [
        field(
          "externalReferenceProviderKey",
          "Reference provider",
          stringValue(externalReferences?.providerKey) ?? "",
          "text",
          disabled,
        ),
        field(
          "externalReferenceTarget",
          "Reference target",
          stringValue(externalReferences?.target) ?? "",
          "text",
          disabled,
        ),
        field(
          "externalKeyPrefix",
          "External key prefix",
          stringValue(externalReferences?.externalKeyPrefix) ?? "",
          "text",
          disabled,
        ),
        field(
          "externalReferenceCount",
          "Reference contract count",
          String(arrayValue(contractRecord?.externalReferences).length),
          "text",
          true,
        ),
      ];
    case "selected-options":
      return [
        field(
          "selectedOptionDimensionKey",
          "Dimension key",
          stringValue(selectedOptionDimension?.dimensionKey) ?? "",
          "text",
          disabled,
        ),
        field(
          "selectedOptionSource",
          "Option source",
          stringValue(selectedOptions?.missingOrUnknownOptionPolicy) ??
            stringValue(selectedOptionMapping?.source) ??
            "",
          "text",
          disabled,
        ),
        field(
          "selectedOptionDimensionCount",
          "Dimension count",
          String(arrayValue(selectedOptionMapping?.dimensions).length),
          "text",
          true,
        ),
      ];
    case "reference-hierarchy":
      return [
        field(
          "referenceHierarchyType",
          "Reference type",
          stringValue(referenceHierarchy?.targetTypeKey) ?? "",
          "text",
          disabled,
        ),
        field(
          "referenceHierarchyProviderAttribute",
          "Provider attribute",
          stringValue(referenceHierarchy?.providerAttributeKey) ??
            stringValue(referenceHierarchyMapping?.providerAttributeKey) ??
            "",
          "text",
          disabled,
        ),
        field(
          "referenceHierarchyContractCount",
          "Hierarchy contract count",
          String(arrayValue(contractRecord?.referenceHierarchy).length),
          "text",
          true,
        ),
      ];
    case "duplicate-prevention":
      return [
        field(
          "exactExternalCatalogItemReferencesFirst",
          "Check external references first",
          String(booleanValue(duplicatePrevention?.exactExternalCatalogItemReferencesFirst) ?? false),
          "checkbox",
          disabled,
        ),
        field(
          "ambiguousCandidatePolicy",
          "Ambiguous candidate policy",
          stringValue(duplicatePrevention?.ambiguousCandidatePolicy) ?? "",
          "select",
          disabled,
          true,
          null,
          [option("block-promotion", "Block promotion"), option("review-only", "Review only")],
        ),
        field(
          "replayPolicy",
          "Replay policy",
          stringValue(duplicatePrevention?.replayPolicy) ?? "",
          "select",
          disabled,
          true,
          null,
          [
            option("same-profile-version", "Same profile version"),
            option("operator-reapply-active-version", "Operator reapply active version"),
          ],
        ),
        field(
          "duplicatePreventionMappingSource",
          "Mapping source",
          stringValue(duplicatePreventionMapping?.source) ?? "",
          "text",
          disabled,
        ),
      ];
    case "promotion-plan":
      return [
        field(
          "promotionPlanKind",
          "Plan kind",
          stringValue(promotionCommandPlan?.planKind) ?? "",
          "text",
          disabled,
          true,
        ),
        field(
          "promotionRequiresReview",
          "Requires review",
          String(booleanValue(promotionCommandPlan?.requiresReview) ?? true),
          "checkbox",
          true,
        ),
        field(
          "promotionCommandCount",
          "Command count",
          String(arrayValue(promotionCommandPlan?.commands).length),
          "text",
          true,
        ),
      ];
    case "retirement-plan":
      return [
        field(
          "retirementTrackingIssue",
          "Tracking issue",
          numberString(retirementPlan?.trackingIssue),
          "text",
          disabled,
        ),
        field("retirementReason", "Removal reason", stringValue(retirementPlan?.reason) ?? "", "textarea", disabled),
      ];
    case "migration-evidence":
      return [
        field("migrationEvidenceText", "Evidence", profile.migrationEvidence?.evidenceText ?? "", "textarea", disabled),
        field("migrationFixtureRunId", "Fixture run", profile.migrationEvidence?.fixtureRunId ?? "", "text", disabled),
        field(
          "migrationFingerprintBefore",
          "Mapping fingerprint before",
          profile.migrationEvidence?.mappingFingerprintBefore ?? "",
          "text",
          disabled,
        ),
        field(
          "migrationFingerprintAfter",
          "Mapping fingerprint after",
          profile.migrationEvidence?.mappingFingerprintAfter ?? "",
          "text",
          disabled,
        ),
        field("migrationRecordedAt", "Recorded at", profile.migrationEvidence?.recordedAt ?? "", "text", disabled),
      ];
  }
}

function profileSectionOptionQueries(
  profile: CatalogProviderProfileVersionReview,
  section: CatalogProviderProfileEditableSectionKey,
  overview: CatalogIntegrationControlPlaneOverview | null,
): readonly ProfileOptionQueryDetail[] {
  if (section !== "provider-options") {
    return [];
  }

  const profileRecord = recordValue(profile.profile);
  const cacheState = optionQueryCacheState(profile, overview);

  return arrayValue(profileRecord?.optionQueries)
    .map((value): ProfileOptionQueryDetail | null => {
      const record = recordValue(value);
      const output = recordValue(record?.output);
      const queryKind = stringValue(record?.queryKind);
      const displayName = stringValue(record?.displayName);
      const scope = stringValue(record?.scope);
      const operation = stringValue(record?.operation);
      if (!record || !queryKind || !displayName || !scope || !operation || !output) {
        return null;
      }
      const parentValue = recordValue(record.parentValue);

      return {
        queryKind,
        aliases: stringArrayValue(record.aliases),
        displayName,
        scope,
        parentScope: stringValue(record.parentScope),
        parentRequired: booleanValue(parentValue?.required) ?? false,
        parentValueKind: stringValue(parentValue?.valueKind),
        parentDiagnosticText: stringValue(parentValue?.diagnosticText),
        operation,
        outputMappings: optionQueryOutputMappings(output),
        cacheState,
      };
    })
    .filter((query): query is ProfileOptionQueryDetail => query !== null);
}

function optionQueryOutputMappings(output: Record<string, unknown>): ProfileOptionQueryDetail["outputMappings"] {
  const mappings: ProfileOptionQueryDetail["outputMappings"][number][] = [];
  addOutputMapping(mappings, "value", "Value", stringValue(output.valuePath));
  addOutputMapping(mappings, "label", "Label", stringValue(output.labelPath));
  const descriptionPath = optionQueryDescriptionSummary(output.description);
  addOutputMapping(mappings, "description", "Description", descriptionPath);
  addOutputMapping(mappings, "parent", "Parent value", stringValue(output.parentValuePath));
  addOutputMapping(mappings, "image", "Image", stringValue(output.imageUrlPath));
  for (const [index, path] of stringArrayValue(output.imageUrlCoalescePaths).entries()) {
    addOutputMapping(mappings, `image-coalesce-${index + 1}`, `Image fallback ${index + 1}`, path);
  }
  for (const [key, path] of Object.entries(recordValue(output.metadataPaths) ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    addOutputMapping(mappings, `metadata-${key}`, `Metadata: ${key}`, stringValue(path));
  }

  return mappings;
}

function addOutputMapping(
  mappings: ProfileOptionQueryDetail["outputMappings"][number][],
  key: string,
  label: string,
  path: string | null,
): void {
  if (path) {
    mappings.push({ key, label, path });
  }
}

function optionQueryDescriptionSummary(value: unknown): string | null {
  const description = recordValue(value);
  const kind = stringValue(description?.kind);
  if (!kind) {
    return null;
  }
  if (kind === "path") {
    return stringValue(description?.path);
  }

  return kind;
}

function optionQueryCacheState(
  profile: CatalogProviderProfileVersionReview,
  overview: CatalogIntegrationControlPlaneOverview | null,
): ProfileOptionQueryDetail["cacheState"] {
  const health = overview?.providerReadiness.providers.find(
    (provider) => provider.providerKey === profile.providerKey,
  )?.optionQueryHealth;
  const status = health?.status ?? "unknown";
  const diagnosticCodes = health?.diagnosticCodes ?? [];
  const cacheOnly =
    diagnosticCodes.some((code) => /cache-only/i.test(code)) || /cache-only/i.test(health?.message ?? "");
  const policy = `Fresh option-query results expire after ${providerOptionQueryFreshTtlMinutes} minutes; stale fallback expires after ${providerOptionQueryStaleTtlHours} hours.`;

  return {
    status,
    label:
      status === "ready"
        ? "Option queries ready"
        : status === "degraded"
          ? "Option queries degraded"
          : status === "blocked"
            ? "Option queries blocked"
            : "Option query health unknown",
    description: health?.message ? `${health.message} ${policy}` : policy,
    diagnosticCodes,
    freshTtlMinutes: providerOptionQueryFreshTtlMinutes,
    staleTtlHours: providerOptionQueryStaleTtlHours,
    cacheOnly,
  };
}

function profileSectionImportScopeControls(input: {
  profile: CatalogProviderProfileVersionReview;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  scopes: readonly SourceObservationIntegrationScope[];
  section: CatalogProviderProfileEditableSectionKey;
}): readonly ProfileImportScopeControl[] {
  if (input.section !== "basics") {
    return [];
  }

  const providerRows = input.scopes.filter((scope) => scope.provider_key === input.profile.providerKey);

  return input.profile.supportedScopes.map((scope) => {
    const rows = providerRows.filter((row) => scopeRowMatchesProviderScope(scope, row));
    const selectedRows = rows.filter((row) => providerScopeImportKey(scope, row) === input.routeContext.importScope);
    const representative = selectedRows[0] ?? rows[0] ?? null;
    const representativeScopeKey = representative ? providerScopeImportKey(scope, representative) : null;
    const state = selectedRows.length > 0 ? "selected" : representativeScopeKey ? "available" : "unavailable";

    return {
      scope,
      label: providerScopeLabel(scope),
      state,
      reason:
        state === "unavailable"
          ? `No current provider scope rows expose a selectable ${providerScopeLabel(scope)} control.`
          : null,
      href: representativeScopeKey
        ? catalogPrimaryWorkbenchHref(
            {
              ...input.routeContext,
              providerKey: input.profile.providerKey,
              importScope: representativeScopeKey,
              promotionPreviewId: null,
              sourceObservationFilters: {
                ...input.routeContext.sourceObservationFilters,
                providerKey: input.profile.providerKey,
              },
            },
            "import-to-promotion",
          )
        : null,
      importScope: representativeScopeKey,
      expectedObservationCount: sum(rows, (row) => row.total_observations),
      observedCount: sum(rows, (row) => row.observed_observations),
      changedCount: sum(rows, (row) => row.changed_observations),
      promotedCount: sum(rows, (row) => row.promoted_observations),
      rejectedCount: sum(rows, (row) => row.rejected_observations),
    };
  });
}

function providerScopeImportKey(scope: string, row: SourceObservationIntegrationScope): string | null {
  const normalizedScope = normalizeProviderScope(scope);
  switch (normalizedScope) {
    case "language":
      return row.language_code || null;
    case "series":
      return [row.language_code, row.series_id].filter(Boolean).join(":") || null;
    case "product-line/category":
      return [row.language_code, row.product_line_id].filter(Boolean).join(":") || null;
    case "expansion":
    case "set-name":
    case "product/card":
      return scopeKey(row) || null;
    default:
      return null;
  }
}

function scopeRowMatchesProviderScope(scope: string, row: SourceObservationIntegrationScope): boolean {
  const normalizedScope = normalizeProviderScope(scope);
  switch (normalizedScope) {
    case "language":
      return Boolean(row.language_code);
    case "series":
      return Boolean(row.series_id);
    case "expansion":
    case "set-name":
    case "product/card":
      return Boolean(row.expansion_id || row.expansion_name);
    case "product-line/category":
      return Boolean(row.product_line_id || row.product_line_name);
    default:
      return false;
  }
}

function normalizeProviderScope(scope: string): string {
  if (scope === "pokemon/card") {
    return "product/card";
  }

  return scope;
}

function providerScopeLabel(scope: string): string {
  return scope
    .split("/")
    .map((part) =>
      part
        .split("-")
        .map((segment) => segment.replace(/^\w/, (char) => char.toUpperCase()))
        .join(" "),
    )
    .join(" / ");
}

function profileSectionMappingRows(
  profile: CatalogProviderProfileVersionReview,
  section: CatalogProviderProfileEditableSectionKey,
  diagnostics: readonly { path: string; diagnosticText: string; severity: "error" | "warning" }[],
): readonly ProfileMappingRow[] {
  const profileRecord = recordValue(profile.profile);
  const contractRecord = recordValue(profile.executableMappingContract);
  const rows: ProfileMappingRow[] = [];

  switch (section) {
    case "catalog-field-mapping": {
      const catalogFieldMapping = recordValue(profileRecord?.catalogFieldMapping);
      const fieldKeys = recordValue(catalogFieldMapping?.fieldKeys);
      addMappingRecordRow(
        rows,
        "catalog-field-mapping.blueprint",
        "Blueprint key",
        "profile.catalogFieldMapping.blueprintKey",
        catalogFieldMapping?.blueprintKey,
        diagnostics,
      );
      addMappingRecordRow(
        rows,
        "catalog-field-mapping.category",
        "Category key",
        "profile.catalogFieldMapping.categoryKey",
        catalogFieldMapping?.categoryKey,
        diagnostics,
      );
      for (const [fieldKey, expression] of Object.entries(fieldKeys ?? {}).sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        addMappingExpressionRow(
          rows,
          `catalog-field-mapping.field.${fieldKey}`,
          `Catalog field: ${fieldKey}`,
          `profile.catalogFieldMapping.fieldKeys.${fieldKey}`,
          expression,
          diagnostics,
        );
      }
      break;
    }
    case "source-observation": {
      const sourceObservation = recordValue(contractRecord?.sourceObservation);
      for (const key of ["observationId", "externalKey", "sourceUrl", "sourceUpdatedAt", "sourcePayload"]) {
        addMappingExpressionRow(
          rows,
          `source-observation.${key}`,
          sourceObservationLabel(key),
          `executableMappingContract.sourceObservation.${key}`,
          sourceObservation?.[key],
          diagnostics,
        );
      }
      break;
    }
    case "normalized-observation": {
      const normalizedObservation = recordValue(contractRecord?.normalizedObservation);
      addMappingExpressionRow(
        rows,
        "normalized-observation.languageCode",
        "Language code",
        "executableMappingContract.normalizedObservation.languageCode",
        normalizedObservation?.languageCode,
        diagnostics,
      );
      for (const [fieldKey, expression] of Object.entries(recordValue(normalizedObservation?.fields) ?? {}).sort(
        ([left], [right]) => left.localeCompare(right),
      )) {
        addMappingExpressionRow(
          rows,
          `normalized-observation.field.${fieldKey}`,
          `Normalized field: ${fieldKey}`,
          `executableMappingContract.normalizedObservation.fields.${fieldKey}`,
          expression,
          diagnostics,
        );
      }
      for (const [index, expression] of arrayValue(normalizedObservation?.hashMaterial).entries()) {
        addMappingExpressionRow(
          rows,
          `normalized-observation.hashMaterial.${index}`,
          `Hash material ${index + 1}`,
          `executableMappingContract.normalizedObservation.hashMaterial.${index}`,
          expression,
          diagnostics,
          true,
        );
      }
      for (const [index, expression] of arrayValue(normalizedObservation?.mergeIdentity).entries()) {
        addMappingExpressionRow(
          rows,
          `normalized-observation.mergeIdentity.${index}`,
          `Merge identity ${index + 1}`,
          `executableMappingContract.normalizedObservation.mergeIdentity.${index}`,
          expression,
          diagnostics,
          true,
        );
      }
      break;
    }
    case "external-references": {
      for (const [index, reference] of arrayValue(contractRecord?.externalReferences).entries()) {
        const record = recordValue(reference);
        addMappingExpressionRow(
          rows,
          `external-references.${index}.source`,
          `${stringValue(record?.providerKey) ?? "External"} ${stringValue(record?.target) ?? "reference"}`,
          `executableMappingContract.externalReferences.${index}.source`,
          record?.source,
          diagnostics,
          true,
        );
      }
      break;
    }
    case "selected-options": {
      for (const [referenceIndex, reference] of arrayValue(contractRecord?.externalReferences).entries()) {
        const selectedOptions = recordValue(recordValue(reference)?.selectedOptions);
        for (const [dimensionIndex, dimension] of arrayValue(selectedOptions?.dimensions).entries()) {
          const record = recordValue(dimension);
          addMappingExpressionRow(
            rows,
            `selected-options.${referenceIndex}.${dimensionIndex}`,
            `Selected option: ${stringValue(record?.dimensionKey) ?? `dimension ${dimensionIndex + 1}`}`,
            `executableMappingContract.externalReferences.${referenceIndex}.selectedOptions.dimensions.${dimensionIndex}.providerValue`,
            record?.providerValue,
            diagnostics,
            true,
          );
        }
      }
      const selectedOptionMapping = recordValue(profileRecord?.selectedOptionMapping);
      for (const [index, dimension] of arrayValue(selectedOptionMapping?.dimensions).entries()) {
        const record = recordValue(dimension);
        addMappingRecordRow(
          rows,
          `selected-option-mapping.${index}`,
          `Option dimension: ${stringValue(record?.dimensionKey) ?? index + 1}`,
          `profile.selectedOptionMapping.dimensions.${index}`,
          record?.sourcePath ?? record?.providerValuePath ?? record?.optionLookupTableKey,
          diagnostics,
          true,
        );
      }
      break;
    }
    case "reference-hierarchy": {
      for (const [index, hierarchy] of arrayValue(contractRecord?.referenceHierarchy).entries()) {
        addReferenceHierarchyRows(
          rows,
          hierarchy,
          `executableMappingContract.referenceHierarchy.${index}`,
          diagnostics,
        );
      }
      break;
    }
    case "duplicate-prevention": {
      const duplicatePrevention = recordValue(contractRecord?.duplicatePrevention);
      for (const [index, expression] of arrayValue(duplicatePrevention?.mergeCandidateEvidence).entries()) {
        addMappingExpressionRow(
          rows,
          `duplicate-prevention.mergeCandidateEvidence.${index}`,
          `Merge evidence ${index + 1}`,
          `executableMappingContract.duplicatePrevention.mergeCandidateEvidence.${index}`,
          expression,
          diagnostics,
          true,
        );
      }
      for (const [ruleIndex, rule] of arrayValue(duplicatePrevention?.identityRules).entries()) {
        const record = recordValue(rule);
        for (const [evidenceIndex, expression] of arrayValue(record?.evidence).entries()) {
          addMappingExpressionRow(
            rows,
            `duplicate-prevention.identityRules.${ruleIndex}.${evidenceIndex}`,
            `${stringValue(record?.ruleKey) ?? `Rule ${ruleIndex + 1}`} evidence ${evidenceIndex + 1}`,
            `executableMappingContract.duplicatePrevention.identityRules.${ruleIndex}.evidence.${evidenceIndex}`,
            expression,
            diagnostics,
            true,
          );
        }
      }
      for (const [index, rule] of arrayValue(recordValue(profileRecord?.duplicatePreventionMapping)?.rules).entries()) {
        const record = recordValue(rule);
        addMappingRecordRow(
          rows,
          `duplicate-prevention.mapping.${index}`,
          `Duplicate rule: ${stringValue(record?.ruleKey) ?? index + 1}`,
          `profile.duplicatePreventionMapping.rules.${index}`,
          record?.sourcePath ?? record?.matchKind,
          diagnostics,
          true,
        );
      }
      break;
    }
    case "promotion-plan": {
      const promotionCommandPlan = recordValue(contractRecord?.promotionCommandPlan);
      for (const [commandIndex, command] of arrayValue(promotionCommandPlan?.commands).entries()) {
        const commandRecord = recordValue(command);
        for (const [inputKey, expression] of Object.entries(recordValue(commandRecord?.inputs) ?? {}).sort(
          ([left], [right]) => left.localeCompare(right),
        )) {
          addMappingExpressionRow(
            rows,
            `promotion-plan.${commandIndex}.${inputKey}`,
            `${stringValue(commandRecord?.commandName) ?? `Command ${commandIndex + 1}`}: ${inputKey}`,
            `executableMappingContract.promotionCommandPlan.commands.${commandIndex}.inputs.${inputKey}`,
            expression,
            diagnostics,
            true,
          );
        }
      }
      break;
    }
    default:
      break;
  }

  return rows;
}

function addReferenceHierarchyRows(
  rows: ProfileMappingRow[],
  value: unknown,
  path: string,
  diagnostics: readonly { path: string; diagnosticText: string; severity: "error" | "warning" }[],
): void {
  const record = recordValue(value);
  if (!record) {
    return;
  }
  addMappingExpressionRow(
    rows,
    `reference-hierarchy.${path}.key`,
    `Reference hierarchy: ${stringValue(record.targetTypeKey) ?? "record"}`,
    `${path}.referenceRecordKey`,
    record.referenceRecordKey,
    diagnostics,
    true,
  );
  if (record.parent) {
    addReferenceHierarchyRows(rows, record.parent, `${path}.parent`, diagnostics);
  }
}

function addMappingExpressionRow(
  rows: ProfileMappingRow[],
  key: string,
  label: string,
  path: string,
  value: unknown,
  diagnostics: readonly { path: string; diagnosticText: string; severity: "error" | "warning" }[],
  listAffordances = false,
): void {
  const expression = recordValue(value);
  if (!expression) {
    return;
  }

  rows.push({
    key,
    label,
    path,
    summary: compactMappingSummary(expressionSummary(expression)),
    owner: stringValue(expression.owner),
    redaction: stringValue(expression.redaction),
    uses: stringArrayValue(expression.uses),
    diagnostics: diagnosticsForPath(diagnostics, path),
    previewAvailable: Boolean(recordValue(expression.selector)),
    affordances: {
      duplicate: listAffordances,
      reorder: listAffordances,
      remove: listAffordances,
      inlineDiagnostics: true,
      longPathSafe: true,
    },
  });
}

function addMappingRecordRow(
  rows: ProfileMappingRow[],
  key: string,
  label: string,
  path: string,
  value: unknown,
  diagnostics: readonly { path: string; diagnosticText: string; severity: "error" | "warning" }[],
  listAffordances = false,
): void {
  const summary = value === undefined || value === null ? "" : typeof value === "string" ? value : String(value);
  if (!summary) {
    return;
  }

  rows.push({
    key,
    label,
    path,
    summary: compactMappingSummary(summary),
    owner: null,
    redaction: null,
    uses: [],
    diagnostics: diagnosticsForPath(diagnostics, path),
    previewAvailable: false,
    affordances: {
      duplicate: listAffordances,
      reorder: listAffordances,
      remove: listAffordances,
      inlineDiagnostics: true,
      longPathSafe: true,
    },
  });
}

function diagnosticsForPath(
  diagnostics: readonly { path: string; diagnosticText: string; severity: "error" | "warning" }[],
  path: string,
): ProfileMappingRow["diagnostics"] {
  return diagnostics.filter((diagnostic) => diagnostic.path === path || diagnostic.path.startsWith(`${path}.`));
}

function compactMappingSummary(summary: string): string {
  const trimmed = summary.trim() || "Configured mapping expression";
  if (trimmed.length <= 120) {
    return trimmed;
  }

  return `${trimmed.slice(0, 72)}...${trimmed.slice(-36)}`;
}

function sourceObservationLabel(key: string): string {
  switch (key) {
    case "observationId":
      return "Observation id";
    case "externalKey":
      return "External key";
    case "sourceUrl":
      return "Source URL";
    case "sourceUpdatedAt":
      return "Source updated";
    case "sourcePayload":
      return "Source payload";
    default:
      return key;
  }
}

function profileSectionDescription(section: CatalogProviderProfileEditableSectionKey): string {
  switch (section) {
    case "basics":
      return "Name, lifecycle, capability, scope, and language controls for the selected profile version.";
    case "provider-options":
      return "Provider option query metadata used before a provider pull starts.";
    case "connector":
      return "Connector and mapping-boundary controls that define how provider data is acquired.";
    case "catalog-field-mapping":
      return "Catalog blueprint, category, and field mapping targets for promoted facts.";
    case "source-contract":
      return "Source ownership and fixture-set contract evidence.";
    case "fixtures":
      return "Offline fixture coverage required before profile behavior is trusted.";
    case "source-observation":
      return "Source Observation identity, URL, update, and payload mapping controls.";
    case "normalized-observation":
      return "Normalized fact mapping, hash material, and merge evidence controls.";
    case "external-references":
      return "External Catalog Item and Product reference extraction controls.";
    case "selected-options":
      return "Selected option mapping for variants, language, condition, and certification evidence.";
    case "reference-hierarchy":
      return "Reference hierarchy mapping used to connect provider sets, series, and related records.";
    case "duplicate-prevention":
      return "Duplicate candidate and replay policy controls used before Catalog promotion.";
    case "promotion-plan":
      return "Catalog promotion command plan controls and command-count evidence.";
    case "retirement-plan":
      return "Complete removal plan evidence for profiles that will be retired.";
    case "migration-evidence":
      return "Evidence proving profile changes were validated before activation.";
  }
}

function profileSectionDomainConcept(section: CatalogProviderProfileEditableSectionKey): string {
  switch (section) {
    case "basics":
      return "profile identity";
    case "provider-options":
      return "provider option query";
    case "connector":
      return "connector binding";
    case "catalog-field-mapping":
      return "catalog field mapping";
    case "source-contract":
      return "source contract";
    case "fixtures":
      return "fixture contract";
    case "source-observation":
      return "source observation";
    case "normalized-observation":
      return "normalized observation";
    case "external-references":
      return "external references";
    case "selected-options":
      return "selected options";
    case "reference-hierarchy":
      return "reference hierarchy";
    case "duplicate-prevention":
      return "duplicate prevention";
    case "promotion-plan":
      return "promotion plan";
    case "retirement-plan":
      return "retirement plan";
    case "migration-evidence":
      return "migration evidence";
  }
}

function sectionBlockersFor(input: {
  activeJobCount: number;
  canManage: boolean;
  profile: CatalogProviderProfileVersionReview;
  status: CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["status"];
  saveOutcome: CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["sectionWorkspaces"][number]["saveOutcome"];
}): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  if (!input.canManage) {
    blockers.add("permission-denied");
  }
  if (input.status !== "ready") {
    blockers.add("profile-version-missing");
  }
  if (input.profile.lifecycle !== "draft" && input.profile.lifecycle !== "test") {
    blockers.add("profile-section-read-only");
  }
  if (input.activeJobCount > 0) {
    blockers.add("active-job-conflict");
  }
  if (input.activeJobCount > 1) {
    blockers.add("concurrent-job");
  }
  if (input.saveOutcome === "conflict") {
    blockers.add("profile-section-stale");
  }

  return [...blockers];
}

function sectionSaveOutcomeFromUrl(
  requestUrl: string | URL,
  section: CatalogProviderProfileEditableSectionKey,
): CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["sectionWorkspaces"][number]["saveOutcome"] {
  const url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
  if (
    url.searchParams.get("commandIntent") !== "update-provider-profile-section" ||
    url.searchParams.get("commandSection") !== section
  ) {
    return "not-submitted";
  }

  switch (url.searchParams.get("commandResult")) {
    case "section-saved":
      return "saved";
    case "section-conflict":
      return "conflict";
    case "section-invalid":
      return "invalid";
    case "command-failed":
      return "failed";
    default:
      return "not-submitted";
  }
}

function profileSectionStatus(
  profile: CatalogProviderProfileVersionReview,
  section: CatalogProviderProfileEditableSectionKey,
  diagnostics: readonly { severity: "error" | "warning" }[],
): CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["sectionWorkspaces"][number]["status"] {
  if (profile.lifecycle === "retired") {
    return "blocked";
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return "error";
  }
  if (diagnostics.length > 0 || sectionChangeCount(profile, section) > 0) {
    return "warning";
  }

  return "valid";
}

function profileDiagnosticsBySection(
  profile: CatalogProviderProfileVersionReview,
): Map<
  CatalogProviderProfileEditableSectionKey,
  readonly { path: string; diagnosticText: string; severity: "error" | "warning" }[]
> {
  const entries = new Map<
    CatalogProviderProfileEditableSectionKey,
    { path: string; diagnosticText: string; severity: "error" | "warning" }[]
  >();
  for (const diagnostic of profile.validation.diagnostics) {
    const section = sectionForDiagnosticPath(diagnostic.path);
    const current = entries.get(section) ?? [];
    current.push({
      path: diagnostic.path,
      diagnosticText: diagnostic.diagnosticText,
      severity: diagnostic.severity,
    });
    entries.set(section, current);
  }

  return entries;
}

function sectionForDiagnosticPath(path: string): CatalogProviderProfileEditableSectionKey {
  const normalized = path.toLowerCase();
  if (normalized.includes("optionquer")) return "provider-options";
  if (normalized.includes("connector")) return "connector";
  if (normalized.includes("catalogfieldmapping")) return "catalog-field-mapping";
  if (normalized.includes("sourcecontract")) return "source-contract";
  if (normalized.includes("fixture")) return "fixtures";
  if (normalized.includes("sourceobservation")) return "source-observation";
  if (normalized.includes("normalizedobservation")) return "normalized-observation";
  if (normalized.includes("externalreference")) return "external-references";
  if (normalized.includes("selectedoption")) return "selected-options";
  if (normalized.includes("referencehierarchy")) return "reference-hierarchy";
  if (normalized.includes("duplicateprevention") || normalized.includes("ambiguity")) return "duplicate-prevention";
  if (normalized.includes("promotioncommandplan")) return "promotion-plan";
  if (normalized.includes("retirementplan")) return "retirement-plan";
  if (normalized.includes("migrationevidence")) return "migration-evidence";

  return "basics";
}

function sectionChangeCount(
  profile: CatalogProviderProfileVersionReview,
  section: CatalogProviderProfileEditableSectionKey,
): number {
  if (section === "migration-evidence" && profile.migrationEvidence) return 1;
  if (section === "retirement-plan" && profile.retirementPlan) return 1;
  return 0;
}

function profileSectionAnchorId(section: CatalogProviderProfileEditableSectionKey): string {
  return `profile-section-${section}`;
}

function field(
  key: string,
  label: string,
  value: string,
  control: ProfileSectionField["control"],
  disabled: boolean,
  required = false,
  helpText: string | null = null,
  options: readonly ProfileSectionField["options"][number][] = [],
): ProfileSectionField {
  return { key, label, value, control, required, disabled, helpText, options };
}

function option(value: string, label: string): ProfileSectionField["options"][number] {
  return { value, label };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstRecord(values: readonly unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const record = recordValue(value);
    if (record) {
      return record;
    }
  }

  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringArrayValue(value: unknown): readonly string[] {
  return arrayValue(value).filter((entry): entry is string => typeof entry === "string");
}

function recordKeys(value: unknown): readonly string[] {
  return Object.keys(recordValue(value) ?? {});
}

function numberString(value: unknown): string {
  return typeof value === "number" ? String(value) : "";
}

function expressionSummary(value: unknown): string {
  const expression = recordValue(value);
  const selector = recordValue(expression?.selector);
  const selectorKind = stringValue(selector?.kind);
  if (selectorKind === "path") {
    return stringValue(selector?.path) ?? "";
  }
  if (selectorKind === "template") {
    return stringValue(selector?.template) ?? "";
  }
  if (selectorKind === "constant") {
    const constantValue = selector?.value;
    return typeof constantValue === "string" ? constantValue : constantValue === undefined ? "" : String(constantValue);
  }
  if (selectorKind === "named-runtime-selector") {
    return stringValue(selector?.functionKey) ?? "";
  }

  return selectorKind ?? stringValue(expression?.owner) ?? "";
}

function profileOverviewFor(
  profile: CatalogProviderProfileVersionReview,
): NonNullable<CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["selectedProfile"]> {
  const latestDiagnostic = profile.validation.diagnostics.at(-1) ?? null;

  return {
    providerKey: profile.providerKey,
    profileKey: profile.profileKey,
    profileVersion: profile.profileVersion,
    displayName: profile.displayName,
    lifecycle: profile.lifecycle,
    active: profile.active,
    status: profile.status,
    connectorKind: profile.connectorKind,
    capabilities: profile.capabilities,
    supportedScopes: profile.supportedScopes,
    languageOptions: profile.languageOptions,
    mappingOutputKind: profile.mappingOutputKind,
    hasExecutableMappingContract: profile.hasExecutableMappingContract,
    mappingFingerprint:
      profile.migrationEvidence?.mappingFingerprintAfter ?? profile.migrationEvidence?.mappingFingerprintBefore ?? null,
    referenceCount: profile.referenceCount,
    sourceContract: profile.sourceContract,
    fixtures: profile.fixtures,
    validation: {
      status: profile.validation.status,
      diagnosticCount: profile.validation.diagnostics.length,
      latestDiagnosticText: latestDiagnostic?.diagnosticText ?? null,
    },
    migrationEvidence: {
      state: profile.migrationEvidence ? "recorded" : "not-recorded",
      recordedAt: profile.migrationEvidence?.recordedAt ?? null,
      fixtureRunId: profile.migrationEvidence?.fixtureRunId ?? null,
      mappingFingerprintBefore: profile.migrationEvidence?.mappingFingerprintBefore ?? null,
      mappingFingerprintAfter: profile.migrationEvidence?.mappingFingerprintAfter ?? null,
    },
    authoringAudit: {
      createdAt: profile.authoringAudit?.createdAt ?? null,
      createdByUserId: profile.authoringAudit?.createdByUserId ?? null,
      createdForAccountId: profile.authoringAudit?.createdForAccountId ?? null,
      updatedAt: profile.authoringAudit?.updatedAt ?? null,
      updatedByUserId: profile.authoringAudit?.updatedByUserId ?? null,
      updatedForAccountId: profile.authoringAudit?.updatedForAccountId ?? null,
    },
    immutableIdentityFacts: immutableProfileFactsFor(profile),
  };
}

function immutableProfileFactsFor(
  profile: CatalogProviderProfileVersionReview,
): CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["cloneDraft"]["immutableIdentityFacts"] {
  return [
    immutableFact(
      "provider-key",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.fact.provider"),
      profile.providerKey,
    ),
    immutableFact(
      "profile-key",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.fact.profile"),
      profile.profileKey,
    ),
    immutableFact(
      "source-contract-owner",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.fact.contract.owner"),
      profile.sourceContract.owner,
    ),
    immutableFact(
      "source-contract-repository",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.fact.contract.repository"),
      profile.sourceContract.repository ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
    ),
    immutableFact(
      "connector-kind",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.fact.connector"),
      profile.connectorKind,
    ),
    immutableFact(
      "supported-scopes",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.fact.scopes"),
      profile.supportedScopes.join(", ") || t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
    ),
  ];
}

function immutableFact(
  key: CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["cloneDraft"]["immutableIdentityFacts"][number]["key"],
  label: string,
  value: string,
): CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["cloneDraft"]["immutableIdentityFacts"][number] {
  return { key, label, value };
}

function profileOptionFor(
  profile: CatalogProviderProfileVersionReview,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["availableProfiles"][number] {
  return {
    providerKey: profile.providerKey,
    profileKey: profile.profileKey,
    profileVersion: profile.profileVersion,
    displayName: profile.displayName,
    lifecycle: profile.lifecycle,
    active: profile.active,
    status: profile.status,
    href: catalogPrimaryWorkbenchSupportingHref(
      {
        ...routeContext,
        providerKey: profile.providerKey,
        profileVersion: profile.profileVersion,
        promotionPreviewId: null,
      },
      "profile-authoring",
    ),
  };
}

function cloneProfileBlockersFor(input: {
  activeJobCount: number;
  canManage: boolean;
  status: CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["status"];
}): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  if (!input.canManage) {
    blockers.add("permission-denied");
  }
  if (input.status === "missing-profile" || input.status === "stale-selection") {
    blockers.add("profile-version-missing");
  }
  if (input.activeJobCount > 0) {
    blockers.add("active-job-conflict");
  }
  if (input.activeJobCount > 1) {
    blockers.add("concurrent-job");
  }

  return [...blockers];
}

function nextDraftProfileVersion(
  profile: CatalogProviderProfileVersionReview,
  profiles: readonly CatalogProviderProfileVersionReview[],
): string {
  const base = `${profile.profileVersion}-draft`;
  const existingVersions = new Set(
    profiles
      .filter((candidate) => candidate.providerKey === profile.providerKey)
      .map((candidate) => candidate.profileVersion),
  );
  if (!existingVersions.has(base)) {
    return base;
  }
  let index = 2;
  let candidate = `${base}-${index}`;
  while (existingVersions.has(candidate)) {
    index += 1;
    candidate = `${base}-${index}`;
  }

  return candidate;
}

function profileLifecycleRestrictionsFor(
  status: CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["status"],
  profile: CatalogProviderProfileVersionReview | null,
): CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["cloneDraft"]["lifecycleRestrictions"] {
  if (status === "stale-selection") {
    return [
      profileRestriction(
        "stale-selection",
        t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.restriction.stale.title"),
        t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.restriction.stale.description"),
        "blocked",
      ),
    ];
  }
  if (status === "missing-profile" || !profile) {
    return [
      profileRestriction(
        "missing-profile",
        t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.restriction.missing.title"),
        t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.restriction.missing.description"),
        "blocked",
      ),
    ];
  }

  switch (profile.lifecycle.toLowerCase()) {
    case "draft":
      return [
        profileRestriction(
          "draft-editable",
          t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.restriction.draft.title"),
          t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.restriction.draft.description"),
          "info",
        ),
      ];
    case "test":
      return [
        profileRestriction(
          "test-editable",
          t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.restriction.test.title"),
          t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.restriction.test.description"),
          "info",
        ),
      ];
    case "deprecated":
      return [
        profileRestriction(
          "deprecated-clone-required",
          t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.restriction.deprecated.title"),
          t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.restriction.deprecated.description"),
          "warning",
        ),
      ];
    case "retired":
      return [
        profileRestriction(
          "retired-read-only",
          t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.restriction.retired.title"),
          t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.restriction.retired.description"),
          "warning",
        ),
      ];
    case "active":
    default:
      return [
        profileRestriction(
          "active-clone-required",
          t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.restriction.active.title"),
          t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.restriction.active.description"),
          "warning",
        ),
      ];
  }
}

function profileRestriction(
  code: CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["cloneDraft"]["lifecycleRestrictions"][number]["code"],
  label: string,
  description: string,
  severity: CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["cloneDraft"]["lifecycleRestrictions"][number]["severity"],
): CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["cloneDraft"]["lifecycleRestrictions"][number] {
  return { code, label, description, severity };
}

function readinessBlockersFor(
  input: CatalogPrimaryWorkbenchInput,
  providerKey: string | null,
  activeProfile: CatalogProviderProfileVersionReview | null,
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  if (!input.canManageCatalog) {
    blockers.add("permission-denied");
  }
  if (!activeProfile) {
    blockers.add("missing-active-profile");
  }
  for (const control of input.controlPlaneOverview?.readiness.rolloutControls.controls ?? []) {
    const appliesToProvider =
      !providerKey || control.providerKeys.length === 0 || control.providerKeys.includes(providerKey);
    if (appliesToProvider && control.status === "blocked") {
      blockers.add(control.defaultState === "quarantined" ? "kill-switch-active" : "rollout-disabled");
    }
  }
  for (const unit of input.controlPlaneOverview?.readiness.units ?? []) {
    if (providerKey && unit.providerKey !== providerKey) {
      continue;
    }
    if (unit.credentialReadiness === "blocked") {
      blockers.add(credentialBlockerFor(unit.credentialReadinessState));
    }
    if (unit.transportReadiness === "blocked") {
      blockers.add("provider-transport-degraded");
    }
    if (unit.fixtureValidationStatus === "blocked") {
      blockers.add("missing-fixture-coverage");
    }
  }
  for (const category of providerTransportFor(input.controlPlaneOverview, providerKey)) {
    blockers.add(providerTransportBlockerFor(category));
  }

  return [...blockers];
}

function providerTransportFor(
  overview: CatalogIntegrationControlPlaneOverview | null,
  providerKey: string | null,
): readonly CatalogPrimaryWorkbenchProviderTransportCategory[] {
  const categories = new Set<CatalogPrimaryWorkbenchProviderTransportCategory>();
  for (const unit of overview?.readiness.units ?? []) {
    if (providerKey && unit.providerKey !== providerKey) {
      continue;
    }
    for (const diagnostic of unit.diagnostics) {
      if (diagnostic.source === "provider-adapter" && diagnostic.severity !== "info") {
        categories.add(providerTransportCategoryFor(diagnostic.code, diagnostic.message, diagnostic.retryAfterSeconds));
      }
    }
  }
  for (const provider of overview?.providerReadiness.providers ?? []) {
    if (providerKey && provider.providerKey !== providerKey) {
      continue;
    }
    for (const capability of [
      provider.apiReachability,
      provider.optionQueryHealth,
      provider.rateLimitStatus,
      provider.payloadAcquisition,
    ]) {
      if (capability.status === "blocked" || capability.status === "degraded") {
        for (const code of capability.diagnosticCodes) {
          categories.add(providerTransportCategoryFor(code, capability.message, null));
        }
      }
    }
    for (const diagnostic of provider.diagnostics) {
      if (diagnostic.severity !== "info") {
        categories.add(providerTransportCategoryFor(diagnostic.code, diagnostic.message, diagnostic.retryAfterSeconds));
      }
    }
  }

  return [...categories];
}

function healthTriageFor(input: {
  overview: CatalogIntegrationControlPlaneOverview | null;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
}): CatalogPrimaryWorkbenchHealthTriageReadModel {
  const generatedAt = input.overview?.generatedAt ?? new Date().toISOString();
  const units = input.overview?.readiness.units ?? [];
  const providerRows = (input.overview?.providerReadiness.providers ?? []).map((provider) => {
    const latestDiagnostic = provider.diagnostics.filter((diagnostic) => diagnostic.severity !== "info").at(-1) ?? null;

    return {
      providerKey: provider.providerKey,
      adapterKey: provider.adapterKey,
      status: providerStatus(provider.readiness),
      readiness: provider.readiness,
      credentialReadiness: provider.credentialReadiness,
      credentialReadinessState: provider.credentialReadinessState,
      unitKeys: provider.unitKeys as readonly CatalogIntegrationUnitKey[],
      apiReachability: provider.apiReachability.status,
      optionQueryHealth: provider.optionQueryHealth.status,
      rateLimitStatus: provider.rateLimitStatus.status,
      payloadAcquisition: provider.payloadAcquisition.status,
      diagnosticCodes: [
        ...new Set([
          ...provider.apiReachability.diagnosticCodes,
          ...provider.optionQueryHealth.diagnosticCodes,
          ...provider.rateLimitStatus.diagnosticCodes,
          ...provider.payloadAcquisition.diagnosticCodes,
          ...provider.diagnostics.map((diagnostic) => diagnostic.code),
        ]),
      ],
      latestDiagnosticText:
        latestDiagnostic?.message ??
        provider.apiReachability.message ??
        provider.optionQueryHealth.message ??
        provider.rateLimitStatus.message ??
        provider.payloadAcquisition.message ??
        null,
      ownerMetricKey: providerOwnerMetric(provider),
      nextAction: providerNextAction(provider),
    } satisfies CatalogPrimaryWorkbenchHealthTriageReadModel["providers"][number];
  });
  const rolloutControls = (input.overview?.readiness.rolloutControls.controls ?? []).map((control) => ({
    controlId: control.controlId,
    status: control.status,
    severity: control.severity,
    owner: control.owner,
    ownerIssue: control.ownerIssue,
    metricKey: control.metricKey,
    message: control.message,
    providerKeys: control.providerKeys,
    unitKeys: control.unitKeys,
    nextAction:
      control.status === "open"
        ? t("catalog.features.sourceObservations.ui.primaryWorkbench.health.rollout.next.open")
        : t("catalog.features.sourceObservations.ui.primaryWorkbench.health.rollout.next.owner", {
            ownerIssue: String(control.ownerIssue),
          }),
  }));
  const unitRows = units.map((unit) => {
    const status = unitStatus(unit);

    return {
      unitKey: unit.unitKey as CatalogIntegrationUnitKey,
      providerKey: unit.providerKey,
      displayName: unit.displayName,
      productDomain: unit.productDomain,
      productForm: unit.productForm,
      ingestionPurpose: unit.ingestionPurpose,
      profileVersion: unit.profileVersion,
      status,
      semanticReadiness: unit.semanticReadiness,
      credentialReadiness: unit.credentialReadiness,
      credentialReadinessState: unit.credentialReadinessState,
      transportReadiness: unit.transportReadiness,
      fixtureValidationStatus: unit.fixtureValidationStatus,
      dryRunStatus: unit.dryRunStatus,
      observationFacts: unit.observationFacts,
      diagnosticCounts: unit.diagnosticCounts,
      diagnosticCodes: unit.diagnostics.map((diagnostic) => diagnostic.code),
      latestDiagnosticText: unit.latestDiagnosticText ?? unit.diagnostics.at(-1)?.message ?? null,
      affectedPrimaryAction: unitAffectedPrimaryAction(unit),
      ownerMetricKey: unitOwnerMetric(unit),
      nextAction: unitNextAction(unit),
    } satisfies CatalogPrimaryWorkbenchHealthTriageReadModel["units"][number];
  });
  const recentJobs = input.importJobs
    .filter((job) => job.state === "queued" || job.state === "running" || job.state === "failed")
    .slice(0, 8)
    .map((job) => ({
      jobId: job.jobId,
      providerKey: job.providerKey,
      unitKey: job.unitKey,
      operatorStatus: job.operatorStatus,
      phase: job.state,
      progressLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.job.progress", {
        completed: String(job.completed),
        total: String(job.total),
        percent: String(job.progressPercent),
      }),
      summary: job.summary,
      ownerMetricKey: job.state === "failed" ? "catalog.integration.job.failed" : "catalog.integration.job.active",
      nextAction:
        job.state === "failed"
          ? t("catalog.features.sourceObservations.ui.primaryWorkbench.health.job.next.failed")
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.health.job.next.active"),
    }));
  const blockedUnits = unitRows.filter((unit) => unit.status === "blocked").length;
  const readyUnits = unitRows.filter((unit) => unit.status === "ready").length;
  const degradedProviders = providerRows.filter((provider) => provider.status !== "ready").length;
  const rolloutStops = rolloutControls.filter((control) => control.status !== "open").length;
  const activeJobs = recentJobs.filter((job) => job.phase === "queued" || job.phase === "running").length;
  const failedJobs = recentJobs.filter((job) => job.phase === "failed").length;
  const auditFreshness =
    !input.overview || input.overview.auditLifecycle.projectionStatus === "unavailable" ? "unavailable" : "partial";
  const status = !input.overview
    ? "unavailable"
    : blockedUnits > 0 || rolloutControls.some((control) => control.status === "blocked")
      ? "blocked"
      : degradedProviders > 0 ||
          unitRows.some((unit) => unit.status === "degraded") ||
          rolloutControls.some((control) => control.status === "degraded") ||
          failedJobs > 0 ||
          input.overview.auditLifecycle.projectionStatus === "unavailable"
        ? "degraded"
        : "ready";

  return {
    status,
    freshness: input.overview ? "fresh" : "partial",
    generatedAt,
    selectedProviderKey: input.routeContext.providerKey,
    selectedUnitKey: input.routeContext.unitKey,
    returnToPrimaryHref: catalogPrimaryWorkbenchReturnPath(input.routeContext),
    summary: {
      readyUnits,
      totalUnits: unitRows.length,
      blockedUnits,
      degradedProviders,
      activeJobs,
      rolloutStops,
      auditEntries: input.overview?.auditLifecycle.entries.length ?? 0,
    },
    readModels: [
      readModelState(
        "integration-health-summary",
        input.overview ? "fresh" : "partial",
        input.overview?.readiness.generatedAt ?? null,
        input.overview
          ? t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModel.semantic")
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModel.partial"),
        "catalog.integration.health.generated_at",
      ),
      readModelState(
        "provider-transport-readiness-summary",
        input.overview ? "fresh" : "partial",
        input.overview?.providerReadiness.generatedAt ?? null,
        input.overview
          ? t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModel.transport")
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModel.partial"),
        "catalog.integration.provider_transport.generated_at",
      ),
      readModelState(
        "import-job-progress-summary",
        input.overview ? "fresh" : "partial",
        input.overview?.unitActivity.generatedAt ?? null,
        input.overview
          ? t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModel.jobs")
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModel.partial"),
        "catalog.integration.job_progress.generated_at",
      ),
      readModelState(
        "audit-evidence-timeline",
        auditFreshness,
        input.overview?.auditLifecycle.generatedAt ?? null,
        input.overview?.auditLifecycle.statusMessage ??
          t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModel.audit.unavailable"),
        "catalog.integration.audit.generated_at",
      ),
    ],
    units: unitRows,
    providers: providerRows,
    rolloutControls,
    recentJobs,
    auditPreview: {
      generatedAt: input.overview?.auditLifecycle.generatedAt ?? null,
      projectionStatus: input.overview?.auditLifecycle.projectionStatus ?? "unavailable",
      statusMessage:
        input.overview?.auditLifecycle.statusMessage ??
        t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModel.audit.unavailable"),
      entries:
        input.overview?.auditLifecycle.entries.slice(0, 6).map((entry) => ({
          eventId: entry.eventId,
          occurredAt: entry.occurredAt,
          eventName: entry.eventName,
          category: entry.category,
          providerKey: entry.providerKey,
          unitKey: entry.unitKey as CatalogIntegrationUnitKey | null,
          summary: entry.summary,
        })) ?? [],
    },
  };
}

function validationReadinessFor(input: {
  activeJobCount: number;
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  canManage: boolean;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  generatedAt: string;
  profileAuthoring: CatalogPrimaryWorkbenchReadModel["profileAuthoring"];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  selectedProfile: CatalogProviderProfileVersionReview | null;
}): ValidationReadiness {
  const profile = input.selectedProfile;
  const authoringModel = authoringModelForProfile(input.authoringModel, profile);
  const readinessUnit = validationReadinessUnitFor(input.controlPlaneOverview, input.routeContext, profile);
  const fixtureFlows = validationFixtureFlowsFor({
    activeJobCount: input.activeJobCount,
    authoringModel,
    canManage: input.canManage,
    profile,
    readinessUnit,
  });
  const dryRunEvidence = validationDryRunEvidenceFor({
    authoringModel,
    profile,
    readinessUnit,
    routeContext: input.routeContext,
  });
  const semanticCompare = validationSemanticCompareFor({
    authoringModel,
    fixtureFlows,
    profile,
    profileAuthoring: input.profileAuthoring,
  });
  const activationReadiness = validationActivationReadinessFor({
    authoringModel,
    fixtureFlows,
    profile,
    readinessUnit,
    semanticCompare,
  });
  const activationDecision = validationActivationDecisionFor({
    activationReadiness,
    activeJobCount: input.activeJobCount,
    canManage: input.canManage,
    profile,
    routeContext: input.routeContext,
    semanticCompare,
  });
  const blockedFixtureFlows = fixtureFlows.filter(
    (flow) => flow.status === "blocked" || flow.status === "not-covered",
  ).length;
  const blockingReadinessChecks = activationReadiness.groups.flatMap((group) =>
    group.checks.filter((check) => check.status === "blocked"),
  ).length;
  const semanticChangeCount = semanticCompare.sections.reduce(
    (count, sectionEntry) => count + sectionEntry.changeCount,
    0,
  );
  const auditEvidenceCount = dryRunEvidence.reduce((count, evidence) => count + evidence.auditEvidence.length, 0);
  const status: ValidationReadiness["status"] = !profile
    ? "unavailable"
    : blockedFixtureFlows > 0 || blockingReadinessChecks > 0 || readinessUnit?.dryRunStatus === "blocked"
      ? "blocked"
      : fixtureFlows.some((flow) => flow.status === "warning") || semanticChangeCount > 0
        ? "degraded"
        : "ready";

  return {
    status,
    freshness: authoringModel && input.controlPlaneOverview ? "fresh" : profile ? "partial" : "unavailable",
    generatedAt: authoringModel ? authoringModel.dryRunInputTemplate.observedAt : input.generatedAt,
    selectedProviderKey: input.routeContext.providerKey ?? profile?.providerKey ?? null,
    selectedUnitKey: input.routeContext.unitKey,
    selectedProfileVersion: profile?.profileVersion ?? null,
    selectedFixtureFlow:
      authoringModel?.dryRunInputTemplate.defaultFlow ??
      fixtureFlows.find((flow) => flow.status === "ready")?.flow ??
      null,
    returnToPrimaryHref: catalogPrimaryWorkbenchReturnPath(input.routeContext),
    summary: {
      readyFixtureFlows: fixtureFlows.filter((flow) => flow.status === "ready").length,
      totalFixtureFlows: fixtureFlows.length,
      blockedFixtureFlows,
      dryRunEvidenceCount: dryRunEvidence.length,
      semanticChangeCount,
      unchangedSectionCount: semanticCompare.unchangedSections.length,
      blockingReadinessChecks,
      auditEvidenceCount,
    },
    fixtureFlows,
    dryRunEvidence,
    semanticCompare,
    activationReadiness,
    activationDecision,
  };
}

function authoringModelForProfile(
  authoringModel: CatalogProviderProfileAuthoringModel | null,
  profile: CatalogProviderProfileVersionReview | null,
): CatalogProviderProfileAuthoringModel | null {
  if (!authoringModel || !profile) {
    return null;
  }

  return authoringModel.review.providerKey === profile.providerKey &&
    authoringModel.review.profileVersion === profile.profileVersion
    ? authoringModel
    : null;
}

function validationReadinessUnitFor(
  overview: CatalogIntegrationControlPlaneOverview | null,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
  profile: CatalogProviderProfileVersionReview | null,
): CatalogIntegrationControlPlaneOverview["readiness"]["units"][number] | null {
  const units = overview?.readiness.units ?? [];
  return (
    units.find((unit) => routeContext.unitKey && unit.unitKey === routeContext.unitKey) ??
    units.find(
      (unit) =>
        profile &&
        unit.providerKey === profile.providerKey &&
        (!unit.profileVersion || unit.profileVersion === profile.profileVersion),
    ) ??
    units.find((unit) => routeContext.providerKey && unit.providerKey === routeContext.providerKey) ??
    null
  );
}

function validationFixtureFlowsFor(input: {
  activeJobCount: number;
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  canManage: boolean;
  profile: CatalogProviderProfileVersionReview | null;
  readinessUnit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number] | null;
}): readonly ValidationFixtureFlow[] {
  if (!input.profile) {
    return [];
  }
  const profile = input.profile;
  const requiredFlows = new Set<string>(catalogProviderRequiredFixtureFlows);
  const fixtureCasesByFlow = new Map(
    (input.authoringModel?.fixtureCases ?? []).map((fixtureCase) => [fixtureCase.flow, fixtureCase]),
  );
  for (const flow of profile.fixtures.coveredFlows) {
    requiredFlows.add(flow);
  }
  for (const fixtureCase of fixtureCasesByFlow.values()) {
    requiredFlows.add(fixtureCase.flow);
  }

  return [...requiredFlows].sort().map((flow) => {
    const fixtureCase = fixtureCasesByFlow.get(flow) ?? null;
    const diagnostics = validationDiagnosticsForFixtureFlow(profile, flow);
    const blockers = validationFixtureFlowBlockers({
      activeJobCount: input.activeJobCount,
      canManage: input.canManage,
      covered: profile.fixtures.coveredFlows.includes(flow),
      diagnostics,
      readinessUnit: input.readinessUnit,
    });
    const status = validationFixtureFlowStatus({
      blockers,
      covered: profile.fixtures.coveredFlows.includes(flow),
      diagnostics,
    });

    return {
      flow,
      label: flowLabel(flow),
      status,
      payloadFile: fixtureCase?.payloadFile ?? null,
      payloadPath: fixtureCase?.payloadPath ?? null,
      expectedStatus: fixtureCase?.expectedStatus ?? null,
      expectedDiagnosticPaths: fixtureCase?.expectedDiagnosticPaths ?? [],
      expectedHashEvidencePaths: fixtureCase?.expectedHashEvidencePaths ?? [],
      expectedMergeEvidencePaths: fixtureCase?.expectedMergeEvidencePaths ?? [],
      expectedPromotionCommands: fixtureCase?.expectedPromotionCommands ?? [],
      samplePayloadAvailable: fixtureCase?.samplePayloadAvailable ?? false,
      diagnostics,
      actionState: actionStateForBlockers(blockers, input.canManage ? "available" : "denied"),
      blockers,
    };
  });
}

function validationFixtureFlowBlockers(input: {
  activeJobCount: number;
  canManage: boolean;
  covered: boolean;
  diagnostics: readonly { severity: "error" | "warning" }[];
  readinessUnit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number] | null;
}): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  if (!input.canManage) {
    blockers.add("permission-denied");
  }
  if (!input.covered) {
    blockers.add("missing-fixture-coverage");
  }
  if (
    input.diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
    input.readinessUnit?.fixtureValidationStatus === "blocked"
  ) {
    blockers.add("fixture-validation-blocked");
  }
  if (input.activeJobCount > 0) {
    blockers.add("active-job-conflict");
  }
  if (input.activeJobCount > 1) {
    blockers.add("concurrent-job");
  }

  return [...blockers];
}

function validationFixtureFlowStatus(input: {
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  covered: boolean;
  diagnostics: readonly { severity: "error" | "warning" }[];
}): ValidationFixtureFlow["status"] {
  if (!input.covered) {
    return "not-covered";
  }
  if (input.blockers.includes("fixture-validation-blocked")) {
    return "blocked";
  }
  if (input.diagnostics.length > 0) {
    return "warning";
  }

  return "ready";
}

function validationDiagnosticsForFixtureFlow(
  profile: CatalogProviderProfileVersionReview,
  flow: string,
): readonly { path: string; diagnosticText: string; severity: "error" | "warning" }[] {
  return profile.validation.diagnostics
    .filter((diagnostic) => {
      const normalizedPath = diagnostic.path.toLowerCase();
      const normalizedFlow = flow.toLowerCase();
      return (
        normalizedPath.includes("fixture") &&
        (normalizedPath.includes(normalizedFlow) || normalizedPath.endsWith("coveredflows"))
      );
    })
    .map((diagnostic) => ({
      path: diagnostic.path,
      diagnosticText: diagnostic.diagnosticText,
      severity: diagnostic.severity,
    }));
}

function validationDryRunEvidenceFor(input: {
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  profile: CatalogProviderProfileVersionReview | null;
  readinessUnit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number] | null;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
}): readonly ValidationDryRunEvidence[] {
  if (!input.profile) {
    return [];
  }
  const duplicateCandidates = validationEvidenceRowsForSection(input.profile, "duplicate-prevention");
  const selectedOptions = validationEvidenceRowsForSection(input.profile, "selected-options");
  const promotionCommandPreview = validationPromotionCommandPreviewFor(input.profile);
  const diagnostics = validationDiagnosticLinksFor(input.profile, input.authoringModel);
  const auditEvidence = validationAuditEvidenceFor(input.profile);
  const unitEvidence = input.readinessUnit?.dryRunEvidence ?? [];

  if (unitEvidence.length === 0) {
    return [
      {
        externalKey:
          input.routeContext.providerKey ??
          input.profile.providerKey ??
          t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
        sourceUrl: null,
        sourceHash: null,
        status: input.readinessUnit?.dryRunStatus ?? "not-run",
        normalizedFacts: [],
        redactionSummary: validationRedactionSummary(0, false),
        duplicateCandidates,
        selectedOptions,
        promotionCommandPreview,
        diagnostics,
        auditEvidence,
      },
    ];
  }

  return unitEvidence.map((evidence) => {
    const normalizedFacts = Object.entries(evidence.normalizedFacts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value }));

    return {
      externalKey: evidence.externalKey,
      sourceUrl: evidence.sourceUrl,
      sourceHash: evidence.sourceHash,
      status: input.readinessUnit?.dryRunStatus ?? "completed",
      normalizedFacts,
      redactionSummary: validationRedactionSummary(normalizedFacts.length, Boolean(evidence.sourceHash)),
      duplicateCandidates,
      selectedOptions,
      promotionCommandPreview,
      diagnostics,
      auditEvidence,
    };
  });
}

function validationEvidenceRowsForSection(
  profile: CatalogProviderProfileVersionReview,
  section: CatalogProviderProfileEditableSectionKey,
): readonly CatalogPrimaryWorkbenchValidationEvidenceRow[] {
  const diagnostics = profileDiagnosticsBySection(profile).get(section) ?? [];
  return profileSectionMappingRows(profile, section, diagnostics).map((row) => ({
    key: row.key,
    label: row.label,
    path: row.path,
    summary: row.summary,
    owner: row.owner,
    uses: row.uses,
    diagnostics: row.diagnostics,
  }));
}

function validationPromotionCommandPreviewFor(
  profile: CatalogProviderProfileVersionReview,
): ValidationDryRunEvidence["promotionCommandPreview"] {
  const commandPlan = recordValue(recordValue(profile.executableMappingContract)?.promotionCommandPlan);

  return arrayValue(commandPlan?.commands).map((command, index) => {
    const commandRecord = recordValue(command);
    const inputs = Object.entries(recordValue(commandRecord?.inputs) ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([inputKey, expression]) =>
        validationExpressionEvidenceRow({
          key: `promotion-command.${index}.${inputKey}`,
          label: inputKey,
          path: `executableMappingContract.promotionCommandPlan.commands.${index}.inputs.${inputKey}`,
          expression,
        }),
      );

    return {
      commandName: stringValue(commandRecord?.commandName) ?? `Command ${index + 1}`,
      inputs,
    };
  });
}

function validationExpressionEvidenceRow(input: {
  key: string;
  label: string;
  path: string;
  expression: unknown;
}): CatalogPrimaryWorkbenchValidationEvidenceRow {
  const expression = recordValue(input.expression);

  return {
    key: input.key,
    label: input.label,
    path: input.path,
    summary: compactMappingSummary(expressionSummary(expression)),
    owner: stringValue(expression?.owner),
    uses: stringArrayValue(expression?.uses),
    diagnostics: [],
  };
}

function validationDiagnosticLinksFor(
  profile: CatalogProviderProfileVersionReview,
  authoringModel: CatalogProviderProfileAuthoringModel | null,
): ValidationDryRunEvidence["diagnostics"] {
  const authoringChecks =
    authoringModel?.activationReadiness.checks
      .filter((check) => check.status === "blocked")
      .map((check) => ({
        code: check.code,
        path: check.path,
        sectionKey: check.sectionKey,
        domainConcept: check.domainConcept,
        diagnosticText: check.diagnosticText,
        severity: check.severity,
        fixtureFlow: check.flow ?? null,
      })) ?? [];
  if (authoringChecks.length > 0) {
    return authoringChecks;
  }

  return profile.validation.diagnostics.map((diagnostic, index) => {
    const section = sectionForDiagnosticPath(diagnostic.path);

    return {
      code: `profile-validation-${index + 1}`,
      path: diagnostic.path,
      sectionKey: section,
      domainConcept: profileSectionDomainConcept(section),
      diagnosticText: diagnostic.diagnosticText,
      severity: diagnostic.severity,
      fixtureFlow: fixtureFlowFromPath(diagnostic.path),
    };
  });
}

function validationRedactionSummary(
  normalizedFactCount: number,
  sourceHashAvailable: boolean,
): ValidationDryRunEvidence["redactionSummary"] {
  return [
    {
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.redaction.payload"),
      value: "not retained",
    },
    {
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.redaction.normalizedFacts"),
      value: `${normalizedFactCount} redacted summaries`,
    },
    {
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.redaction.sourceHash"),
      value: sourceHashAvailable ? "captured" : "not captured",
    },
  ];
}

function validationAuditEvidenceFor(profile: CatalogProviderProfileVersionReview): readonly string[] {
  return [
    profile.migrationEvidence?.fixtureRunId ? `fixture-run:${profile.migrationEvidence.fixtureRunId}` : null,
    profile.migrationEvidence?.recordedAt ? `migration-evidence:${profile.migrationEvidence.recordedAt}` : null,
    profile.authoringAudit?.updatedAt ? `profile-authoring:${profile.authoringAudit.updatedAt}` : null,
  ].filter((value): value is string => Boolean(value));
}

function validationSemanticCompareFor(input: {
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  fixtureFlows: readonly ValidationFixtureFlow[];
  profile: CatalogProviderProfileVersionReview | null;
  profileAuthoring: CatalogPrimaryWorkbenchReadModel["profileAuthoring"];
}): ValidationReadiness["semanticCompare"] {
  if (input.authoringModel) {
    const semanticDiff = input.authoringModel.semanticDiff;
    const sections = semanticDiff.sections.map((sectionEntry) => ({
      sectionKey: sectionEntry.sectionKey,
      domainConcept: sectionEntry.domainConcept,
      status: sectionEntry.status,
      changeCount: sectionEntry.changes.filter((change) => change.changed).length,
      changes: sectionEntry.changes.map((change) => ({
        path: change.path,
        label: change.label,
        candidateSummary: summarizeValidationValue(change.candidate),
        activeSummary: summarizeValidationValue(change.active),
        changed: change.changed,
        severity: change.severity,
        activationImpact: change.activationImpact,
      })),
    }));

    return {
      mappingFingerprint: semanticDiff.mappingFingerprint,
      activationImpact: uniqueStrings(
        semanticDiff.changes.filter((change) => change.changed).map((change) => change.activationImpact),
      ),
      fixtureCoverage: input.fixtureFlows.map((flow) => ({ flow: flow.flow, status: flow.status })),
      sections,
      unchangedSections: sections
        .filter((sectionEntry) => sectionEntry.changeCount === 0)
        .map((sectionEntry) => ({
          sectionKey: sectionEntry.sectionKey,
          domainConcept: sectionEntry.domainConcept,
        })),
    };
  }

  const profile = input.profile;
  const sections = input.profileAuthoring.sectionWorkspaces.map((workspace) => {
    const changes = [
      ...workspace.diagnostics.map((diagnostic) => ({
        path: diagnostic.path,
        label: workspace.displayName,
        candidateSummary: diagnostic.diagnosticText,
        activeSummary: "previous validated profile",
        changed: true,
        severity: diagnostic.severity,
        activationImpact: `Blocks or degrades ${workspace.domainConcept}.`,
      })),
      ...(workspace.semanticChangeCount > 0
        ? [
            {
              path: workspace.sectionKey,
              label: workspace.displayName,
              candidateSummary: "updated section evidence",
              activeSummary: "active section evidence",
              changed: true,
              severity: "warning" as const,
              activationImpact: `Review ${workspace.domainConcept} before activation.`,
            },
          ]
        : []),
    ];

    return {
      sectionKey: workspace.sectionKey,
      domainConcept: workspace.domainConcept,
      status: workspace.status === "blocked" ? "error" : workspace.status,
      changeCount: changes.filter((change) => change.changed).length,
      changes,
    } satisfies ValidationSemanticSection;
  });
  const mappingFingerprint = {
    candidate:
      profile?.migrationEvidence?.mappingFingerprintAfter ??
      profile?.migrationEvidence?.mappingFingerprintBefore ??
      null,
    active: profile?.migrationEvidence?.mappingFingerprintBefore ?? null,
    changed: Boolean(
      profile?.migrationEvidence?.mappingFingerprintBefore &&
      profile?.migrationEvidence?.mappingFingerprintAfter &&
      profile.migrationEvidence.mappingFingerprintBefore !== profile.migrationEvidence.mappingFingerprintAfter,
    ),
  };

  return {
    mappingFingerprint,
    activationImpact: uniqueStrings(
      sections.flatMap((sectionEntry) => sectionEntry.changes.map((change) => change.activationImpact)),
    ),
    fixtureCoverage: input.fixtureFlows.map((flow) => ({ flow: flow.flow, status: flow.status })),
    sections,
    unchangedSections: sections
      .filter((sectionEntry) => sectionEntry.changeCount === 0)
      .map((sectionEntry) => ({
        sectionKey: sectionEntry.sectionKey,
        domainConcept: sectionEntry.domainConcept,
      })),
  };
}

function validationActivationReadinessFor(input: {
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  fixtureFlows: readonly ValidationFixtureFlow[];
  profile: CatalogProviderProfileVersionReview | null;
  readinessUnit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number] | null;
  semanticCompare: ValidationReadiness["semanticCompare"];
}): ValidationReadiness["activationReadiness"] {
  if (input.authoringModel) {
    return {
      status: input.authoringModel.activationReadiness.status,
      requiresMigrationEvidence: input.authoringModel.activationReadiness.requiresMigrationEvidence,
      referenceCount: input.authoringModel.activationReadiness.referenceCount,
      groups: input.authoringModel.activationReadiness.groups.map((group) => ({
        domainConcept: group.domainConcept,
        status: group.status,
        checks: group.checks.map((check) => ({
          checkKey: check.checkKey,
          code: check.code,
          sectionKey: check.sectionKey,
          status: check.status,
          path: check.path,
          diagnosticText: check.diagnosticText,
          severity: check.severity,
          remediation: check.remediation,
          blockingBehavior: check.blockingBehavior,
          flow: check.flow ?? null,
        })),
      })),
    };
  }

  const groups = validationActivationGroupsFromProfile(input);
  return {
    status: groups.some((group) => group.status === "blocked") ? "blocked" : "ready",
    requiresMigrationEvidence: Boolean(
      input.profile?.referenceCount && input.semanticCompare.mappingFingerprint.changed,
    ),
    referenceCount: input.profile?.referenceCount ?? 0,
    groups,
  };
}

function validationActivationDecisionFor(input: {
  activationReadiness: ValidationReadiness["activationReadiness"];
  activeJobCount: number;
  canManage: boolean;
  profile: CatalogProviderProfileVersionReview | null;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  semanticCompare: ValidationReadiness["semanticCompare"];
}): ValidationActivationDecision {
  const profile = input.profile;
  const migrationEvidenceRecorded = Boolean(profile?.migrationEvidence?.evidenceText);
  const migrationEvidenceRequired = input.activationReadiness.requiresMigrationEvidence;
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();

  if (!profile) {
    blockers.add("profile-version-missing");
  }
  if (!input.canManage) {
    blockers.add("permission-denied");
  }
  if (input.activeJobCount > 0) {
    blockers.add("active-job-conflict");
  }
  if (input.activeJobCount > 1) {
    blockers.add("concurrent-job");
  }
  if (input.activationReadiness.status === "blocked") {
    blockers.add("activation-readiness-blocked");
  }
  if (migrationEvidenceRequired && !migrationEvidenceRecorded) {
    blockers.add("migration-evidence-missing");
  }
  if (migrationEvidenceRequired && input.activationReadiness.referenceCount > 0 && !migrationEvidenceRecorded) {
    blockers.add("reference-impact-review-required");
  }

  const saveEvidenceBlockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  if (!profile) {
    saveEvidenceBlockers.add("profile-version-missing");
  }
  if (!input.canManage) {
    saveEvidenceBlockers.add("permission-denied");
  }

  const blockerList = [...blockers];
  const saveEvidenceBlockerList = [...saveEvidenceBlockers];
  const status: ValidationActivationDecision["status"] = !profile
    ? "unavailable"
    : blockerList.length > 0
      ? "blocked"
      : "ready";

  return {
    status,
    actionState: actionStateForBlockers(blockerList, input.canManage ? "available" : "denied"),
    blockers: blockerList,
    saveEvidenceState: actionStateForBlockers(saveEvidenceBlockerList, input.canManage ? "available" : "denied"),
    saveEvidenceBlockers: saveEvidenceBlockerList,
    activationCommandKey: "activate-provider-profile",
    evidenceCommandKey: "update-provider-profile-section",
    workspaceHref: catalogPrimaryWorkbenchSupportingHref(input.routeContext, "validation-readiness"),
    providerKey: profile?.providerKey ?? input.routeContext.providerKey ?? null,
    profileVersion: profile?.profileVersion ?? input.routeContext.profileVersion ?? null,
    lifecycle: profile?.lifecycle ?? null,
    importEligibility: !profile
      ? "not-selected"
      : input.activationReadiness.status === "ready"
        ? "eligible"
        : "blocked",
    affectedReferences: {
      referenceCount: input.activationReadiness.referenceCount,
      requiresMigrationEvidence: migrationEvidenceRequired,
      replayImplications: validationReplayImplicationsFor({
        referenceCount: input.activationReadiness.referenceCount,
        mappingFingerprintChanged: input.semanticCompare.mappingFingerprint.changed,
      }),
    },
    migrationEvidence: {
      state: migrationEvidenceRecorded ? "recorded" : migrationEvidenceRequired ? "required" : "not-required",
      evidenceText: profile?.migrationEvidence?.evidenceText ?? "",
      fixtureRunId: profile?.migrationEvidence?.fixtureRunId ?? null,
      mappingFingerprintBefore: profile?.migrationEvidence?.mappingFingerprintBefore ?? null,
      mappingFingerprintAfter: profile?.migrationEvidence?.mappingFingerprintAfter ?? null,
      recordedAt: profile?.migrationEvidence?.recordedAt ?? null,
      recordedByUserId: profile?.migrationEvidence?.recordedByUserId ?? null,
    },
    auditConsequences: {
      auditEvidenceUrl: catalogPrimaryWorkbenchSupportingHref(input.routeContext, "audit-evidence"),
      eventNames: ["activation-readiness-evaluated", "profile-activated"],
      summary:
        status === "ready"
          ? "Activation records readiness evaluation and profile activation audit evidence."
          : "Blocked activation keeps readiness, migration evidence, and remediation visible before activation.",
    },
  };
}

function validationReplayImplicationsFor(input: {
  referenceCount: number;
  mappingFingerprintChanged: boolean;
}): readonly string[] {
  const implications: string[] = [];
  if (input.referenceCount > 0) {
    implications.push(
      `${input.referenceCount} existing references may need replay or reapply review after activation.`,
    );
  }
  implications.push(
    input.mappingFingerprintChanged
      ? "Mapping fingerprint changed; replay and reapply decisions must use this activation evidence."
      : "No mapping fingerprint change detected for replay or reapply decisions.",
  );

  return implications;
}

function lifecycleRecoveryFor(input: {
  activeJobCount: number;
  activeProfile: CatalogProviderProfileVersionReview | null;
  canManage: boolean;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  generatedAt: string;
  lifecycleImpacts: Partial<
    Record<CatalogPrimaryWorkbenchLifecycleOperation, CatalogAdminRollbackRetirementImpactSummaryReadModel>
  > | null;
  profiles: readonly CatalogProviderProfileVersionReview[];
  providerKey: string | null;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  selectedProfile: CatalogProviderProfileVersionReview | null;
  validationReadiness: ValidationReadiness;
}): LifecycleRecovery {
  const providerProfiles = input.providerKey
    ? input.profiles.filter((profile) => profile.providerKey === input.providerKey)
    : input.profiles;
  const selectedProfile = input.selectedProfile;
  const operations: readonly LifecycleOperationRow[] = (["activation", "rollback", "deprecate", "retire"] as const).map(
    (operation) =>
      lifecycleOperationFor({
        activeJobCount: input.activeJobCount,
        activeProfile: input.activeProfile,
        canManage: input.canManage,
        impact: input.lifecycleImpacts?.[operation] ?? null,
        operation,
        routeContext: input.routeContext,
        selectedProfile,
        validationReadiness: input.validationReadiness,
      }),
  );
  const recentAuditEvents =
    input.controlPlaneOverview?.auditLifecycle.entries
      .filter((entry) => {
        if (entry.providerKey !== (selectedProfile?.providerKey ?? input.providerKey ?? entry.providerKey)) {
          return false;
        }
        return (
          entry.eventName === "profile-created" ||
          entry.eventName === "profile-section-edited" ||
          entry.eventName === "profile-activated" ||
          entry.eventName === "profile-deprecated" ||
          entry.eventName === "profile-rolled-back" ||
          entry.eventName === "profile-retired"
        );
      })
      .slice(0, 8)
      .map((entry) => ({
        eventId: entry.eventId,
        occurredAt: entry.occurredAt,
        eventName: entry.eventName,
        category: entry.category,
        providerKey: entry.providerKey,
        unitKey: entry.unitKey as CatalogIntegrationUnitKey | null,
        profileVersion: entry.profileVersion,
        summary: entry.summary,
      })) ?? [];
  const uniqueBlockerCount = new Set(operations.flatMap((operation) => operation.blockers)).size;
  const status: LifecycleRecovery["status"] = !selectedProfile
    ? "unavailable"
    : uniqueBlockerCount > 0
      ? "blocked"
      : "ready";

  return {
    status,
    freshness: input.controlPlaneOverview ? "fresh" : selectedProfile ? "partial" : "unavailable",
    generatedAt: input.generatedAt,
    selectedProviderKey: selectedProfile?.providerKey ?? input.routeContext.providerKey ?? null,
    selectedProfileVersion: selectedProfile?.profileVersion ?? input.routeContext.profileVersion ?? null,
    returnToPrimaryHref: catalogPrimaryWorkbenchReturnPath(input.routeContext),
    auditEvidenceUrl: catalogPrimaryWorkbenchSupportingHref(input.routeContext, "audit-evidence"),
    summary: {
      activeJobs: input.activeJobCount,
      affectedReferences: Math.max(
        selectedProfile?.referenceCount ?? 0,
        ...operations.map((operation) => operation.impact.referencedObservationCount),
      ),
      downstreamProfileReferences: Math.max(
        0,
        ...operations.map(
          (operation) => operation.impact.sourceProfileReferenceCount + operation.impact.promotionProfileReferenceCount,
        ),
      ),
      impactedCatalogItems: Math.max(0, ...operations.map((operation) => operation.impact.impactedCatalogItemCount)),
      blockers: uniqueBlockerCount,
      recentLifecycleEvents: recentAuditEvents.length,
    },
    profiles: providerProfiles.map((profile) => ({
      providerKey: profile.providerKey,
      profileKey: profile.profileKey,
      profileVersion: profile.profileVersion,
      displayName: profile.displayName,
      lifecycle: profile.lifecycle,
      active: profile.active,
      referenceCount: profile.referenceCount,
      href: catalogPrimaryWorkbenchSupportingHref(
        {
          ...input.routeContext,
          providerKey: profile.providerKey,
          profileVersion: profile.profileVersion,
          promotionPreviewId: null,
        },
        "lifecycle-recovery",
      ),
    })),
    operations,
    recentAuditEvents,
    strictRetirement: {
      requiredDisposition: catalogPrimaryWorkbenchRetirementPolicy.requiredDisposition,
      forbiddenSupportPaths: catalogPrimaryWorkbenchRetirementPolicy.forbiddenOutcomes.map((outcome) =>
        outcome === "raw JSON escape hatch" ? "payload escape hatch" : outcome,
      ),
      summary: t("catalog.features.sourceObservations.ui.lifecycleRecovery.strictRetirement.summary"),
    },
  };
}

function lifecycleOperationFor(input: {
  activeJobCount: number;
  activeProfile: CatalogProviderProfileVersionReview | null;
  canManage: boolean;
  impact: CatalogAdminRollbackRetirementImpactSummaryReadModel | null;
  operation: CatalogPrimaryWorkbenchLifecycleOperation;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  selectedProfile: CatalogProviderProfileVersionReview | null;
  validationReadiness: ValidationReadiness;
}): LifecycleOperationRow {
  const profile = input.selectedProfile;
  const impactAllowed = input.impact?.allowed ?? (input.operation !== "retire" || (profile?.referenceCount ?? 0) === 0);
  const impact = lifecycleImpactFor(profile, input.impact, input.activeJobCount);
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  if (!profile) {
    blockers.add("profile-version-missing");
  }
  if (!input.canManage) {
    blockers.add("permission-denied");
  }
  if (input.activeJobCount > 0 || impact.impactedJobCount > 0) {
    blockers.add("active-job-conflict");
  }
  if (input.activeJobCount > 1 || impact.impactedJobCount > 1) {
    blockers.add("concurrent-job");
  }
  for (const impactBlocker of impact.blockers) {
    blockers.add(lifecycleBlockerCategoryForDiagnostic(impactBlocker.code));
  }

  if (input.operation === "activation") {
    for (const blocker of input.validationReadiness.activationDecision.blockers) {
      blockers.add(blocker);
    }
  }
  if (input.operation === "rollback" && profile?.active) {
    blockers.add("profile-lifecycle-conflict");
  }
  if (input.operation === "deprecate" && (!profile?.active || profile.lifecycle !== "active")) {
    blockers.add("profile-lifecycle-conflict");
  }
  if (input.operation === "retire") {
    if (profile?.active || profile?.lifecycle === "retired") {
      blockers.add("profile-lifecycle-conflict");
    }
    if (
      (profile?.referenceCount ?? 0) > 0 ||
      impact.referencedObservationCount > 0 ||
      impact.sourceProfileReferenceCount > 0 ||
      impact.promotionProfileReferenceCount > 0
    ) {
      blockers.add("profile-retirement-references");
    }
  }

  const blockerList = [...blockers];
  const commandKey = lifecycleCommandKey(input.operation);
  const supportHref =
    input.operation === "activation"
      ? catalogPrimaryWorkbenchSupportingHref(input.routeContext, "validation-readiness")
      : null;
  const submitHref =
    input.operation === "activation"
      ? catalogPrimaryWorkbenchSupportingHref(input.routeContext, "validation-readiness")
      : catalogPrimaryWorkbenchSupportingHref(input.routeContext, "lifecycle-recovery");

  return {
    operation: input.operation,
    label: lifecycleOperationLabel(input.operation),
    description: lifecycleOperationDescription(input.operation),
    commandKey,
    providerKey: profile?.providerKey ?? input.routeContext.providerKey ?? null,
    profileVersion: profile?.profileVersion ?? input.routeContext.profileVersion ?? null,
    lifecycle: profile?.lifecycle ?? null,
    active: Boolean(profile?.active),
    state: actionStateForBlockers(blockerList, input.canManage ? "available" : "denied"),
    blockers: blockerList,
    confirmationRequired: input.operation !== "activation",
    allowed: blockerList.length === 0 && impactAllowed,
    submitHref,
    supportHref,
    impact,
    auditConsequences: {
      auditEvidenceUrl: catalogPrimaryWorkbenchSupportingHref(input.routeContext, "audit-evidence"),
      eventName: lifecycleAuditEventName(input.operation),
      summary: lifecycleAuditSummary(input.operation),
    },
    nextSteps: lifecycleNextSteps(input.operation, blockerList),
  };
}

function lifecycleImpactFor(
  profile: CatalogProviderProfileVersionReview | null,
  impact: CatalogAdminRollbackRetirementImpactSummaryReadModel | null,
  activeJobCount: number,
): LifecycleOperationRow["impact"] {
  if (impact) {
    return {
      generatedAt: impact.generatedAt,
      referencedObservationCount: impact.referencedObservationCount,
      sourceProfileReferenceCount: impact.sourceProfileReferenceCount,
      promotionProfileReferenceCount: impact.promotionProfileReferenceCount,
      impactedCatalogItemCount: impact.impactedCatalogItemCount,
      impactedCatalogItemIds: impact.impactedCatalogItemIds,
      externalReferenceCount: impact.externalReferenceCount,
      sampleObservationIds: impact.sampleObservationIds,
      impactedJobCount: impact.impactedJobCount,
      blockers: impact.blockers,
    };
  }

  return {
    generatedAt: null,
    referencedObservationCount: profile?.referenceCount ?? 0,
    sourceProfileReferenceCount: 0,
    promotionProfileReferenceCount: 0,
    impactedCatalogItemCount: 0,
    impactedCatalogItemIds: [],
    externalReferenceCount: 0,
    sampleObservationIds: [],
    impactedJobCount: activeJobCount,
    blockers: [],
  };
}

function lifecycleCommandKey(
  operation: CatalogPrimaryWorkbenchLifecycleOperation,
): LifecycleOperationRow["commandKey"] {
  switch (operation) {
    case "activation":
      return "activate-provider-profile";
    case "rollback":
      return "rollback-provider-profile";
    case "deprecate":
      return "deprecate-provider-profile";
    case "retire":
      return "retire-provider-profile";
  }
}

function lifecycleOperationLabel(operation: CatalogPrimaryWorkbenchLifecycleOperation): string {
  switch (operation) {
    case "activation":
      return "Activation recovery";
    case "rollback":
      return "Rollback profile";
    case "deprecate":
      return "Deprecate profile";
    case "retire":
      return "Retire profile";
  }
}

function lifecycleOperationDescription(operation: CatalogPrimaryWorkbenchLifecycleOperation): string {
  switch (operation) {
    case "activation":
      return "Open validation readiness when a profile needs activation evidence before returning to provider import.";
    case "rollback":
      return "Restore a previous validated profile version after reviewing reference, job, and replay impact.";
    case "deprecate":
      return "Mark the active profile out of normal use while keeping audit and replay readability clear.";
    case "retire":
      return "Remove the profile from supported use only when active references, jobs, and downstream profile links are gone.";
  }
}

function lifecycleAuditEventName(operation: CatalogPrimaryWorkbenchLifecycleOperation): string {
  switch (operation) {
    case "activation":
      return "profile-activated";
    case "rollback":
      return "profile-rolled-back";
    case "deprecate":
      return "profile-deprecated";
    case "retire":
      return "profile-retired";
  }
}

function lifecycleAuditSummary(operation: CatalogPrimaryWorkbenchLifecycleOperation): string {
  switch (operation) {
    case "activation":
      return "Activation audit evidence is recorded from validation readiness.";
    case "rollback":
      return "Rollback records the restored profile version, affected references, and replay implications.";
    case "deprecate":
      return "Deprecation records lifecycle intent without preserving old code paths or old documentation.";
    case "retire":
      return "Retirement records complete-removal evidence and cannot preserve compatibility support paths.";
  }
}

function lifecycleNextSteps(
  operation: CatalogPrimaryWorkbenchLifecycleOperation,
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
): readonly string[] {
  if (blockers.includes("permission-denied")) {
    return ["Resolve catalog.manage permission in governance controls before running profile lifecycle actions."];
  }
  if (blockers.includes("active-job-conflict") || blockers.includes("concurrent-job")) {
    return ["Let active import, reapply, replay, or review jobs finish before changing profile lifecycle state."];
  }
  if (blockers.includes("profile-retirement-references")) {
    return [
      "Remove active Source Observation references and downstream profile references before profile retirement.",
      "Do not keep compatibility routes, shims, fallback branches, old tests, fixtures, screenshots, or documentation.",
    ];
  }
  if (blockers.includes("profile-lifecycle-conflict")) {
    return operation === "rollback"
      ? ["Select a previous inactive validated profile version as the rollback target."]
      : operation === "deprecate"
        ? ["Select the current active profile before deprecation."]
        : ["Select an inactive, referenced-by-nothing profile that has not already been retired."];
  }
  if (operation === "activation") {
    return ["Use validation readiness to resolve activation blockers and record migration evidence."];
  }

  return ["Review impact evidence, confirm the lifecycle action, and verify audit evidence after completion."];
}

function lifecycleBlockerCategoryForDiagnostic(code: string): CatalogPrimaryWorkbenchBlockerCategory {
  if (code === "profile-lifecycle-active-jobs") {
    return "active-job-conflict";
  }
  if (code === "profile-retirement-referenced-observations") {
    return "profile-retirement-references";
  }

  return "profile-lifecycle-conflict";
}

function validationActivationGroupsFromProfile(input: {
  fixtureFlows: readonly ValidationFixtureFlow[];
  profile: CatalogProviderProfileVersionReview | null;
  readinessUnit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number] | null;
}): readonly ValidationActivationGroup[] {
  const groups = new Map<string, ValidationActivationGroup["checks"][number][]>();
  const addCheck = (domainConcept: string, check: ValidationActivationGroup["checks"][number]) => {
    groups.set(domainConcept, [...(groups.get(domainConcept) ?? []), check]);
  };

  for (const diagnostic of input.profile?.validation.diagnostics ?? []) {
    const section = sectionForDiagnosticPath(diagnostic.path);
    const domainConcept = profileSectionDomainConcept(section);
    addCheck(domainConcept, {
      checkKey: `profile-diagnostic:${diagnostic.path}`,
      code: "profile-section-invalid",
      sectionKey: section,
      status: "blocked",
      path: diagnostic.path,
      diagnosticText: diagnostic.diagnosticText,
      severity: diagnostic.severity,
      remediation: `Resolve ${diagnostic.path} before activation.`,
      blockingBehavior: "fail-closed",
      flow: fixtureFlowFromPath(diagnostic.path),
    });
  }

  for (const flow of input.fixtureFlows.filter((fixtureFlow) => fixtureFlow.status !== "ready")) {
    addCheck("Fixture Coverage", {
      checkKey: `fixture:${flow.flow}`,
      code: flow.status === "not-covered" ? "missing-fixture-coverage" : "fixture-validation-blocked",
      sectionKey: "fixtures",
      status: flow.status === "warning" ? "passed" : "blocked",
      path: `fixtures.coveredFlows.${flow.flow}`,
      diagnosticText:
        flow.status === "not-covered"
          ? `Profile fixture contract must cover ${flow.flow}.`
          : `Fixture ${flow.flow} has blocking validation diagnostics.`,
      severity: flow.status === "warning" ? "warning" : "error",
      remediation:
        flow.status === "not-covered"
          ? `Add ${flow.flow} to covered fixture flows and rerun validation.`
          : `Resolve fixture diagnostics for ${flow.flow}.`,
      blockingBehavior: "fail-closed",
      flow: flow.flow,
    });
  }

  if (input.readinessUnit?.dryRunStatus === "blocked") {
    addCheck("Dry Run Evidence", {
      checkKey: "dry-run:evidence",
      code: "fixture-validation-blocked",
      sectionKey: "fixtures",
      status: "blocked",
      path: "dryRunEvidence",
      diagnosticText: input.readinessUnit.latestDiagnosticText ?? "Dry-run evidence is blocked.",
      severity: "error",
      remediation: "Run fixture-backed dry-run proof until it completes without error diagnostics.",
      blockingBehavior: "fail-closed",
      flow: null,
    });
  }

  if (groups.size === 0) {
    groups.set("Activation", [
      {
        checkKey: "activation:ready",
        code: "activation-ready",
        sectionKey: "readiness",
        status: "passed",
        path: "activationReadiness",
        diagnosticText: "Activation readiness has no blocking checks.",
        severity: "warning",
        remediation: "No remediation required.",
        blockingBehavior: "allow",
        flow: null,
      },
    ]);
  }

  return [...groups.entries()].map(([domainConcept, checks]) => ({
    domainConcept,
    status: checks.some((check) => check.severity === "error" && check.blockingBehavior === "fail-closed")
      ? "blocked"
      : "ready",
    checks,
  }));
}

function summarizeValidationValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "not set";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  const keys = Object.keys(recordValue(value) ?? {});
  return keys.length > 0 ? `structured value: ${keys.slice(0, 4).join(", ")}` : "structured value";
}

function fixtureFlowFromPath(pathValue: string): string | null {
  const normalizedPath = pathValue.toLowerCase();
  return catalogProviderRequiredFixtureFlows.find((flow) => normalizedPath.includes(flow.toLowerCase())) ?? null;
}

function flowLabel(flow: string): string {
  return flow
    .split("-")
    .map((segment) => segment.replace(/^\w/, (char) => char.toUpperCase()))
    .join(" ");
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))];
}

function readModelState(
  queryKey: CatalogPrimaryWorkbenchHealthTriageReadModel["readModels"][number]["queryKey"],
  freshness: CatalogPrimaryWorkbenchHealthTriageReadModel["readModels"][number]["freshness"],
  generatedAt: string | null,
  statusMessage: string,
  ownerMetricKey: string,
): CatalogPrimaryWorkbenchHealthTriageReadModel["readModels"][number] {
  return { queryKey, freshness, generatedAt, statusMessage, ownerMetricKey };
}

function unitStatus(
  unit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number],
): CatalogPrimaryWorkbenchHealthTriageReadModel["units"][number]["status"] {
  if (
    unit.semanticReadiness === "blocked" ||
    unit.credentialReadiness === "blocked" ||
    unit.transportReadiness === "blocked" ||
    unit.fixtureValidationStatus === "blocked" ||
    unit.dryRunStatus === "blocked" ||
    unit.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    return "blocked";
  }
  if (unit.diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    return "degraded";
  }

  return "ready";
}

function providerStatus(
  readiness: CatalogIntegrationControlPlaneOverview["providerReadiness"]["providers"][number]["readiness"],
): CatalogPrimaryWorkbenchHealthTriageReadModel["providers"][number]["status"] {
  if (readiness === "blocked") {
    return "blocked";
  }
  if (readiness === "degraded") {
    return "degraded";
  }

  return "ready";
}

function unitAffectedPrimaryAction(
  unit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number],
): CatalogPrimaryWorkbenchHealthTriageReadModel["units"][number]["affectedPrimaryAction"] {
  if (unit.transportReadiness === "blocked" || unit.credentialReadiness === "blocked") {
    return "pull-provider-data";
  }
  if (
    unit.diagnostics.some((diagnostic) => diagnostic.source === "provider-adapter" && diagnostic.severity !== "info")
  ) {
    return "pull-provider-data";
  }
  if (
    unit.semanticReadiness === "blocked" ||
    unit.fixtureValidationStatus === "blocked" ||
    unit.dryRunStatus === "blocked"
  ) {
    return "preview-promotion";
  }

  return "review-source-observations";
}

function unitOwnerMetric(unit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number]): string {
  if (unit.credentialReadiness === "blocked") {
    return `catalog.integration.credential.${unit.credentialReadinessState}`;
  }
  if (unit.transportReadiness === "blocked") {
    return "catalog.integration.provider_transport.blocked";
  }
  if (unit.semanticReadiness === "blocked") {
    return "catalog.integration.semantic_readiness.blocked";
  }
  if (unit.fixtureValidationStatus === "blocked") {
    return "catalog.integration.fixture_validation.blocked";
  }
  if (unit.dryRunStatus === "blocked") {
    return "catalog.integration.dry_run.blocked";
  }
  if (unit.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return unit.diagnostics.some((diagnostic) => diagnostic.source === "provider-adapter")
      ? "catalog.integration.provider_transport.diagnostic.error"
      : "catalog.integration.semantic_readiness.diagnostic.error";
  }
  if (unit.diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    return unit.diagnostics.some((diagnostic) => diagnostic.source === "provider-adapter")
      ? "catalog.integration.provider_transport.diagnostic.warning"
      : "catalog.integration.semantic_readiness.diagnostic.warning";
  }

  return "catalog.integration.unit.ready";
}

function unitNextAction(unit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number]): string {
  if (unit.credentialReadiness === "blocked") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.credentials");
  }
  if (unit.transportReadiness === "blocked") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.transport");
  }
  if (unit.semanticReadiness === "blocked") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.semantic");
  }
  if (unit.fixtureValidationStatus === "blocked") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.fixtures");
  }
  if (unit.dryRunStatus === "blocked") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.dryRun");
  }
  if (unit.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return unit.diagnostics.some((diagnostic) => diagnostic.source === "provider-adapter")
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.transport")
      : t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.semantic");
  }
  if (unit.diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.warning");
  }

  return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.ready");
}

function providerOwnerMetric(
  provider: CatalogIntegrationControlPlaneOverview["providerReadiness"]["providers"][number],
): string {
  if (provider.credentialReadiness === "blocked") {
    return `catalog.integration.provider_credential.${provider.credentialReadinessState}`;
  }
  if (provider.apiReachability.status !== "ready" && provider.apiReachability.status !== "unknown") {
    return "catalog.integration.provider_api.reachability";
  }
  if (provider.optionQueryHealth.status !== "ready" && provider.optionQueryHealth.status !== "unknown") {
    return "catalog.integration.provider_options.health";
  }
  if (provider.rateLimitStatus.status !== "ready" && provider.rateLimitStatus.status !== "unknown") {
    return "catalog.integration.provider_rate_limit.status";
  }
  if (provider.payloadAcquisition.status !== "ready" && provider.payloadAcquisition.status !== "unknown") {
    return "catalog.integration.provider_payload.acquisition";
  }

  return "catalog.integration.provider.ready";
}

function providerNextAction(
  provider: CatalogIntegrationControlPlaneOverview["providerReadiness"]["providers"][number],
): string {
  if (provider.credentialReadiness === "blocked") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.provider.next.credentials");
  }
  if (provider.apiReachability.status === "blocked" || provider.apiReachability.status === "degraded") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.provider.next.api");
  }
  if (provider.optionQueryHealth.status === "blocked" || provider.optionQueryHealth.status === "degraded") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.provider.next.options");
  }
  if (provider.rateLimitStatus.status === "blocked" || provider.rateLimitStatus.status === "degraded") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.provider.next.rateLimit");
  }
  if (provider.payloadAcquisition.status === "blocked" || provider.payloadAcquisition.status === "degraded") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.provider.next.payload");
  }

  return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.provider.next.ready");
}

function selectedImportScopeFor(input: {
  activeProfile: CatalogProviderProfileVersionReview | null;
  activeJobCount: number;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  input: CatalogPrimaryWorkbenchInput;
  importScope: string | null;
  providerKey: string | null;
  providerTransport: readonly CatalogPrimaryWorkbenchProviderTransportCategory[];
  rolloutEnabled: boolean;
  unitKey: CatalogIntegrationUnitKey | null;
}): CatalogPrimaryWorkbenchReadModel["importJobs"]["selectedScope"] {
  if (!input.providerKey || !input.importScope) {
    return null;
  }

  const providerReadiness = input.input.controlPlaneOverview?.providerReadiness.providers.find(
    (provider) => provider.providerKey === input.providerKey,
  );
  const unitReadiness = input.input.controlPlaneOverview?.readiness.units.find(
    (unit) => unit.unitKey === input.unitKey || unit.providerKey === input.providerKey,
  );
  const matchingRows = input.input.scopes.items.filter(
    (scope) => scope.provider_key === input.providerKey && scopeKey(scope) === input.importScope,
  );
  const rows =
    matchingRows.length > 0
      ? matchingRows
      : input.input.scopes.items.filter((scope) => scope.provider_key === input.providerKey);
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>(input.blockers);
  for (const category of input.providerTransport) {
    blockers.add(providerTransportBlockerFor(category));
  }
  if (input.activeJobCount > 0) {
    blockers.add("active-job-conflict");
  }
  if (input.activeJobCount > 1) {
    blockers.add("concurrent-job");
  }

  return {
    providerKey: input.providerKey,
    unitKey: input.unitKey,
    importScope: input.importScope,
    profileVersion: input.activeProfile?.profileVersion ?? null,
    profileSnapshot: profilePointerForProfile(input.activeProfile),
    expectedObservationVolume: sum(rows, (scope) => scope.total_observations),
    observedCount: sum(rows, (scope) => scope.observed_observations),
    changedCount: sum(rows, (scope) => scope.changed_observations),
    promotedCount: sum(rows, (scope) => scope.promoted_observations),
    rejectedCount: sum(rows, (scope) => scope.rejected_observations),
    readiness: {
      adapterReadiness: providerReadiness?.readiness ?? unitReadiness?.semanticReadiness ?? "unknown",
      credentialReadiness: providerReadiness?.credentialReadiness ?? unitReadiness?.credentialReadiness ?? "unknown",
      rolloutEnabled: input.rolloutEnabled,
      providerTransport: input.providerTransport,
      blockers: [...blockers],
    },
  };
}

function importJobsFor(
  overview: CatalogIntegrationControlPlaneOverview | null,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"] {
  const providerTransport = providerTransportFor(overview, routeContext.providerKey);
  const seenJobIds = new Set<string>();
  const rows = (overview?.unitActivity.units ?? [])
    .flatMap((unit) =>
      unit.recentJobs.map((job) => ({
        unitKey: unit.unitKey,
        job,
      })),
    )
    .filter(({ unitKey, job }) => {
      if (routeContext.unitKey && unitKey !== routeContext.unitKey) {
        return false;
      }
      if (routeContext.providerKey && job.providerKey !== routeContext.providerKey) {
        return false;
      }

      return true;
    })
    .filter(({ job }) => {
      if (seenJobIds.has(job.jobId)) {
        return false;
      }
      seenJobIds.add(job.jobId);

      return true;
    })
    .sort((left, right) => {
      const rightMatchesScope = jobMatchesRouteScope(right.job, routeContext) ? 1 : 0;
      const leftMatchesScope = jobMatchesRouteScope(left.job, routeContext) ? 1 : 0;
      if (rightMatchesScope !== leftMatchesScope) {
        return rightMatchesScope - leftMatchesScope;
      }

      return jobOccurredAt(right.job).localeCompare(jobOccurredAt(left.job));
    });

  return rows.map(({ unitKey, job }) => {
    const scopeMatchesRoute = jobMatchesRouteScope(job, routeContext);
    const state = importJobState(job);
    const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
    if (job.operatorStatus === "stale") {
      blockers.add("stale-replay");
    }
    if (!scopeMatchesRoute && (state === "queued" || state === "running")) {
      blockers.add("active-job-conflict");
    }

    return {
      jobId: job.jobId,
      action: job.action === "reapply" ? "start-reapply" : "start-provider-import",
      state,
      operatorStatus: job.operatorStatus,
      summary: job.summary,
      completed: job.completed,
      total: job.total,
      progressPercent: progressPercent(job.completed, job.total),
      unitKey: job.unitKey ?? unitKey,
      providerKey: job.providerKey,
      importScope: job.importScope,
      profileVersion: job.profileVersion,
      profileSnapshot: job.profileSnapshot,
      scopeMatchesRoute,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      consistency: {
        schemaVersion: "catalog-integration-durable-job-v1",
        compatibilityPolicy: "integration-durable-job",
        duplicateSubmissionPolicy: "reuse-active-job",
        profileSnapshotPolicy: "snapshotted-at-enqueue",
        retryResumePolicy: "skip-completed-outcomes",
        partialFailurePolicy: "mixed-outcomes",
        workUnitClaimPolicy: job.action === "reapply" ? "leased-work-units" : "leased-job-turns",
      },
      failureGroups: failureGroupsFor(job, providerTransport),
      retryAvailable:
        job.operatorStatus === "failed" ||
        job.operatorStatus === "partial" ||
        job.operatorStatus === "stale" ||
        job.operatorStatus === "cancelled",
      resumeAvailable: job.operatorStatus === "stale" || job.operatorStatus === "retried",
      cancelAvailable: job.phase === "enqueued" || job.phase === "fetching" || job.phase === "processing",
      sourceObservationReviewHref: sourceObservationReviewHrefFor(routeContext, job),
      auditEvidenceUrl: catalogPrimaryWorkbenchSupportingHref(
        { ...routeContext, jobId: job.jobId, importScope: job.importScope ?? routeContext.importScope },
        "audit-evidence",
      ),
      observationLinks: [sourceObservationReviewHrefFor(routeContext, job)],
      blockers: [...blockers],
    };
  });
}

function sourceObservationReviewFor(input: {
  canManage: boolean;
  changed: number;
  eligible: number;
  observed: number;
  promoted: number;
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  rejected: number;
  reviewObservations: ListResponse<SourceObservationListItem> | null;
  reviewPagination: Readonly<{ limit: number; offset: number }> | undefined;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  scopeRows: readonly SourceObservationIntegrationScope[];
}): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"] {
  const limit = input.reviewPagination?.limit ?? defaultReviewPageSize;
  const offset = input.reviewPagination?.offset ?? 0;
  const total = input.reviewObservations?.total ?? 0;
  const rows = (input.reviewObservations?.items ?? []).map((observation) =>
    sourceObservationReviewRowFor(observation, {
      canManage: input.canManage,
      routeContext: input.routeContext,
    }),
  );
  const duplicateConflictCount = rows.filter((row) => row.duplicateEvidence.length > 0).length;
  const promotionReadyRowCount = rows.filter((row) => row.promotionReadiness.state === "eligible").length;
  const promotionReadyCount = input.reviewObservations ? promotionReadyRowCount : input.eligible;
  const selectedObservationIds = input.routeContext.selectedObservationIds;
  const selectedRows = rows.filter((row) => selectedObservationIds.includes(row.observationId));

  return {
    freshness: input.scopeRows.length > 0 ? "fresh" : "partial",
    counts: {
      observed: input.observed,
      changed: input.changed,
      promoted: input.promoted,
      rejected: input.rejected,
      blocked: input.readinessBlockers.length,
      eligible: input.eligible,
    },
    cursor: offset > 0 ? `offset:${offset}` : null,
    selectedObservationIds,
    evidenceSummariesRedacted: true,
    duplicateConflictCount,
    promotionReadyCount,
    filters: reviewFiltersFor(input.routeContext),
    savedFilters: savedReviewFiltersFor(input.routeContext, {
      eligible: input.eligible,
      changed: input.changed,
      rejected: input.rejected,
    }),
    pagination: {
      mode: "offset",
      limit,
      offset,
      total,
      nextCursor: offset + limit < total ? `offset:${offset + limit}` : null,
      previousCursor: offset > 0 ? `offset:${Math.max(0, offset - limit)}` : null,
    },
    bulkSelection: {
      selectedCount: selectedObservationIds.length,
      eligibleSelectedCount: selectedRows.filter((row) => row.promotionReadiness.state === "eligible").length,
      actions: ["preview-promotion", "reject-source-observations", "defer-source-observations"],
    },
    rows,
  };
}

function promotionPreviewFor(input: {
  activeJobCount: number;
  activeProfileVersion: string | null;
  canManage: boolean;
  failedJobCount: number;
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
}): CatalogPrimaryWorkbenchReadModel["promotionPreview"] {
  const selectedObservationIds = input.routeContext.selectedObservationIds;
  const selectedIdSet = new Set(selectedObservationIds);
  const hasExplicitRows = selectedObservationIds.length > 0;
  const scopedRows = hasExplicitRows
    ? input.sourceObservationReview.rows.filter((row) => selectedIdSet.has(row.observationId))
    : input.sourceObservationReview.rows;
  const eligibleCount = hasExplicitRows
    ? scopedRows.filter((row) => row.promotionReadiness.state === "eligible").length
    : input.sourceObservationReview.promotionReadyCount;
  const requestedCount = hasExplicitRows
    ? selectedObservationIds.length
    : Math.max(input.sourceObservationReview.pagination.total, eligibleCount);
  const blockedCount =
    scopedRows.length > 0
      ? scopedRows.filter((row) => row.promotionReadiness.state === "blocked").length
      : input.readinessBlockers.length;
  const skippedCount =
    scopedRows.length > 0
      ? scopedRows.filter(
          (row) => row.promotionReadiness.state === "already-promoted" || row.promotionReadiness.state === "rejected",
        ).length
      : hasExplicitRows
        ? Math.max(requestedCount - eligibleCount - blockedCount, 0)
        : input.sourceObservationReview.counts.rejected;
  const conflictingCount =
    scopedRows.length > 0
      ? scopedRows.filter((row) => row.duplicateEvidence.length > 0 || row.conflictEvidence.length > 0).length
      : input.sourceObservationReview.duplicateConflictCount;
  const scope: CatalogPrimaryWorkbenchReadModel["promotionPreview"]["scope"] = {
    kind: hasExplicitRows ? "explicit-rows" : "matching-filter",
    label: hasExplicitRows
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.command.scope.explicit")
      : t("catalog.features.sourceObservations.ui.primaryWorkbench.command.scope.matching"),
    requestedCount,
    eligibleCount,
    selectedObservationIds,
    filterSummary: promotionFilterSummaryFor(input.sourceObservationReview),
    partialFailureMode: "per-observation",
  };
  const staleReasons = promotionPreviewStaleReasonsFor({
    activeProfileVersion: input.activeProfileVersion,
    canManage: input.canManage,
    routeContext: input.routeContext,
    sourceObservationReview: input.sourceObservationReview,
    readinessBlockers: input.readinessBlockers,
    eligibleCount,
  });
  const overlappingActionBlockers = [
    ...(input.activeJobCount > 0 ? (["active-job-conflict"] as const) : []),
    ...(input.activeJobCount > 1 ? (["concurrent-job"] as const) : []),
  ];
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  if (eligibleCount <= 0) {
    blockers.add("no-promotion-eligible-observations");
  }
  if (!input.canManage) {
    blockers.add("permission-denied");
  }
  for (const blocker of input.readinessBlockers.filter(isPromotionExecutionReadinessBlocker)) {
    blockers.add(blocker);
  }
  for (const blocker of overlappingActionBlockers) {
    blockers.add(blocker);
  }
  if (scopedRows.some((row) => row.promotionReadiness.blockers.includes("promotion-conflict"))) {
    blockers.add("promotion-conflict");
  }
  if (staleReasons.length > 0) {
    blockers.add("stale-promotion-preview");
  }
  const confirmationRequired = eligibleCount > 0;
  const commandPlanHash = input.routeContext.promotionPreviewId
    ? [
        "preview",
        input.routeContext.promotionPreviewId,
        scope.kind,
        `requested:${scope.requestedCount}`,
        `eligible:${scope.eligibleCount}`,
        `profile:${input.routeContext.profileVersion ?? "none"}`,
      ].join(":")
    : null;

  return {
    previewId: input.routeContext.promotionPreviewId,
    freshness: staleReasons.length > 0 ? "stale" : eligibleCount > 0 ? "fresh" : "partial",
    scope,
    dispositions: {
      eligible: eligibleCount,
      skipped: skippedCount,
      blocked: blockedCount,
      conflicting: conflictingCount,
      destructive: 0,
      "stale-preview": staleReasons.length > 0 ? 1 : 0,
      "confirmation-required": confirmationRequired ? 1 : 0,
    },
    outcomeCounts: {
      eligible: eligibleCount,
      blocked: blockedCount,
      skipped: skippedCount,
      conflicting: conflictingCount,
      failed: input.failedJobCount,
    },
    commandPlanHash,
    confirmationRequired,
    destructiveCount: 0,
    executionSafeguards: {
      previewRequired: true,
      previewFresh: Boolean(input.routeContext.promotionPreviewId) && staleReasons.length === 0,
      stalePreviewRejected: staleReasons.length > 0,
      idempotencyRequired: true,
      doubleSubmitProtection: true,
      rejectsWhenChanged: ["observations", "profile-version", "rollout-state", "permissions", "command-inputs"],
      staleReasons,
      overlappingActionBlockers,
    },
    reviewDecisions: {
      reject: {
        reasonRequired: true,
        partialFailureMode: "failed-observations-remain-in-scope",
        auditEvidenceRequired: true,
      },
      defer: {
        stateChange: "keeps-observation-in-review",
        returnsToReviewWhen: "next-provider-import-or-filter-reset",
        auditEvidenceRequired: true,
      },
    },
    profileWorkflows: {
      reapply: {
        profileSemantics: "current-active-profile",
        target: "promoted-observations",
        profileVersion: input.activeProfileVersion,
      },
      replay: {
        profileSemantics: "original-source-profile-version",
        target: "source-observation-evidence",
        profileVersion: scopedRows[0]?.sourceProfileVersion ?? input.routeContext.profileVersion,
      },
    },
    blockers: [...blockers],
  };
}

function conflictResolutionFor(input: {
  canManage: boolean;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  generatedAt: string;
  promotionPreview: CatalogPrimaryWorkbenchReadModel["promotionPreview"];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
}): ConflictResolution {
  const selectedIds = new Set(input.routeContext.selectedObservationIds);
  const sourceRows =
    selectedIds.size > 0
      ? input.sourceObservationReview.rows.filter((row) => selectedIds.has(row.observationId))
      : input.sourceObservationReview.rows;
  const rows = sourceRows.filter(hasConflictResolutionEvidence).map((row) =>
    conflictResolutionRowFor(row, {
      canManage: input.canManage,
      promotionPreview: input.promotionPreview,
    }),
  );
  const blockingCount = rows.filter((row) => row.resolutionState === "blocks-promotion").length;
  const autoResolvedCount = rows.filter((row) => row.resolutionState === "auto-resolved").length;
  const reviewRequiredCount = rows.filter((row) => row.resolutionState === "requires-review").length;
  const recentAuditEvents = conflictResolutionAuditEventsFor(input.controlPlaneOverview, input.routeContext);
  const status: ConflictResolution["status"] =
    input.sourceObservationReview.freshness === "unavailable"
      ? "unavailable"
      : blockingCount > 0
        ? "blocked"
        : rows.length > 0
          ? "ready"
          : "empty";
  const overrideBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] = input.canManage
    ? ["unsupported-command"]
    : ["permission-denied", "unsupported-command"];

  return {
    status,
    freshness: input.sourceObservationReview.freshness,
    generatedAt: input.generatedAt,
    returnToPrimaryHref: catalogPrimaryWorkbenchReturnPath(input.routeContext),
    auditEvidenceUrl: catalogPrimaryWorkbenchSupportingHref(input.routeContext, "audit-evidence"),
    selectedObservationIds: input.routeContext.selectedObservationIds,
    summary: {
      conflictCount: rows.length,
      blockingCount,
      autoResolvedCount,
      reviewRequiredCount,
      overrideAvailableCount: rows.filter((row) => row.overrideAction.state === "available").length,
      auditEventCount: recentAuditEvents.length,
    },
    rows,
    precedenceRules: conflictResolutionPrecedenceRules(rows),
    overridePolicy: {
      supported: false,
      requiredPermission: "catalog.manage",
      state: input.canManage ? "unavailable" : "denied",
      blockers: overrideBlockers,
      auditRequired: true,
      reason: t("catalog.features.sourceObservations.ui.conflictResolution.override.policy.reason"),
    },
    recentAuditEvents,
  };
}

function governanceControlsFor(input: {
  actions: readonly CatalogPrimaryWorkbenchActionReadModel[];
  canManage: boolean;
  conflictResolution: ConflictResolution;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  generatedAt: string;
  healthTriage: CatalogPrimaryWorkbenchHealthTriageReadModel;
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  rolloutEnabled: boolean;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
}): GovernanceControls {
  const auditEvidenceUrl = catalogPrimaryWorkbenchSupportingHref(input.routeContext, "audit-evidence");
  const rolloutControls = input.controlPlaneOverview?.readiness.rolloutControls.controls ?? [];
  const activeRolloutStops = rolloutControls.filter((control) => control.status === "blocked").length;
  const controls = [
    ...rolloutControls.map((control) =>
      governanceRolloutControlFor(control, {
        auditEvidenceUrl,
      }),
    ),
    governanceWorkerControlFor({
      activeRolloutStops,
      auditEvidenceUrl,
      importJobs: input.importJobs,
    }),
    governanceLegacyRemovalControlFor(auditEvidenceUrl),
  ];
  const rbacMatrix = governanceRbacMatrixFor({
    actions: input.actions,
    canManage: input.canManage,
  });
  const observability = governanceObservabilityFor({
    auditEvidenceUrl,
    conflictResolution: input.conflictResolution,
    generatedAt: input.controlPlaneOverview?.generatedAt ?? null,
    healthTriage: input.healthTriage,
    importJobs: input.importJobs,
    overviewAvailable: Boolean(input.controlPlaneOverview),
    readinessBlockers: input.readinessBlockers,
    sourceObservationReview: input.sourceObservationReview,
  });
  const degradedSignals = observability.signals.filter((signal) => signal.status !== "ready").length;
  const alertCount = observability.signals.reduce((total, signal) => total + signal.alertLinks.length, 0);
  const deniedCommands = rbacMatrix.filter((entry) => entry.state === "denied").length;
  const blockedCommands = rbacMatrix.filter((entry) => entry.state === "blocked" || entry.state === "unsafe").length;
  const legacyRemovalEvidence = governanceLegacyRemovalEvidenceFor(auditEvidenceUrl);
  const status: GovernanceControls["status"] =
    !input.controlPlaneOverview && degradedSignals > 0
      ? "degraded"
      : activeRolloutStops > 0 || deniedCommands > 0 || blockedCommands > 0
        ? "blocked"
        : degradedSignals > 0
          ? "degraded"
          : "ready";

  return {
    status,
    freshness: input.controlPlaneOverview ? "fresh" : "partial",
    generatedAt: input.generatedAt,
    returnToPrimaryHref: catalogPrimaryWorkbenchReturnPath(input.routeContext),
    auditEvidenceUrl,
    summary: {
      activeRolloutStops,
      deniedCommands,
      blockedCommands,
      degradedSignals,
      alertCount,
      deletionEvidenceCount: legacyRemovalEvidence.evidence.length,
    },
    rolloutMode: {
      label:
        activeRolloutStops > 0
          ? "Staged rollout stopped"
          : rolloutControls.length > 0
            ? "Staged rollout open"
            : "Launch rollout open",
      state:
        activeRolloutStops > 0
          ? "stopped"
          : rolloutControls.some((control) => control.status === "degraded")
            ? "degraded"
            : rolloutControls.length > 0
              ? "staged"
              : "open",
      rolloutEnabled: input.rolloutEnabled,
      workerState: activeRolloutStops > 0 ? "paused" : input.controlPlaneOverview ? "running" : "unknown",
      providerEmergencyStopCount: rolloutControls.filter((control) => control.defaultState === "quarantined").length,
      importKillSwitchActive: hasCapabilityStop(rolloutControls, "import"),
      promotionKillSwitchActive: hasCapabilityStop(rolloutControls, "promotion"),
      reapplyKillSwitchActive: hasCapabilityStop(rolloutControls, "reapply"),
    },
    controls,
    rbacMatrix,
    observability,
    legacyRemovalEvidence,
  };
}

function governanceRolloutControlFor(
  control: CatalogIntegrationControlPlaneOverview["readiness"]["rolloutControls"]["controls"][number],
  input: { auditEvidenceUrl: string },
): GovernanceControlRow {
  const commandKeys = governanceControlCommandKeys(control.capabilities);
  const blockers = governanceControlBlockers(control);

  return {
    controlId: control.controlId,
    kind: governanceControlKind(control, commandKeys),
    label: governanceControlLabel(control, commandKeys),
    status: control.status,
    owner: control.owner,
    ownerIssue: control.ownerIssue,
    metricKey: control.metricKey,
    evidenceUrl: input.auditEvidenceUrl,
    commandKeys,
    blockers,
    providerKeys: control.providerKeys,
    unitKeys: control.unitKeys,
    message: control.message,
  };
}

function governanceWorkerControlFor(input: {
  activeRolloutStops: number;
  auditEvidenceUrl: string;
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
}): GovernanceControlRow {
  const activeJobs = input.importJobs.filter((job) => job.state === "queued" || job.state === "running").length;
  const paused = input.activeRolloutStops > 0;

  return {
    controlId: "catalog-import-worker-state",
    kind: "worker-pause",
    label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.worker.label"),
    status: paused ? "blocked" : "open",
    owner: "ops-release",
    ownerIssue: 801,
    metricKey: "catalog.integration.worker.state",
    evidenceUrl: input.auditEvidenceUrl,
    commandKeys: ["start-provider-import", "start-reapply", "start-replay"],
    blockers: paused ? ["kill-switch-active"] : [],
    providerKeys: [],
    unitKeys: [],
    message: paused
      ? t("catalog.features.sourceObservations.ui.governanceControls.readModel.worker.paused")
      : t("catalog.features.sourceObservations.ui.governanceControls.readModel.worker.running", {
          count: activeJobs,
        }),
  };
}

function governanceLegacyRemovalControlFor(auditEvidenceUrl: string): GovernanceControlRow {
  return {
    controlId: "catalog-retired-compatibility-removal",
    kind: "legacy-removal",
    label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.removal.label"),
    status: "removed",
    owner: "catalog-source-observations",
    ownerIssue: 1090,
    metricKey: "catalog.integration.retired_surfaces.removed",
    evidenceUrl: auditEvidenceUrl,
    commandKeys: [],
    blockers: ["raw-json-retired", "legacy-selector-retired"],
    providerKeys: [],
    unitKeys: [],
    message: t("catalog.features.sourceObservations.ui.governanceControls.readModel.removal.message"),
  };
}

function governanceControlCommandKeys(capabilities: readonly string[]): readonly CatalogPrimaryWorkbenchCommandKey[] {
  const text = capabilities.join(" ").toLowerCase();
  const keys = new Set<CatalogPrimaryWorkbenchCommandKey>();
  if (text.includes("import") || text.includes("source-observation")) {
    keys.add("start-provider-import");
  }
  if (text.includes("promotion") || text.includes("promote")) {
    keys.add("preview-promotion");
    keys.add("execute-promotion");
  }
  if (text.includes("reapply")) {
    keys.add("start-reapply");
  }
  if (text.includes("replay")) {
    keys.add("start-replay");
  }
  if (keys.size === 0) {
    keys.add("start-provider-import");
    keys.add("preview-promotion");
    keys.add("execute-promotion");
  }

  return [...keys];
}

function governanceControlBlockers(
  control: CatalogIntegrationControlPlaneOverview["readiness"]["rolloutControls"]["controls"][number],
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  if (control.status !== "blocked") {
    return [];
  }

  return [control.defaultState === "quarantined" ? "kill-switch-active" : "rollout-disabled"];
}

function governanceControlKind(
  control: CatalogIntegrationControlPlaneOverview["readiness"]["rolloutControls"]["controls"][number],
  commandKeys: readonly CatalogPrimaryWorkbenchCommandKey[],
): GovernanceControlRow["kind"] {
  if (control.defaultState === "quarantined") {
    return "provider-emergency-stop";
  }
  if (commandKeys.includes("start-provider-import")) {
    return "import-kill-switch";
  }
  if (commandKeys.includes("execute-promotion")) {
    return "promotion-kill-switch";
  }
  if (commandKeys.includes("start-reapply") || commandKeys.includes("start-replay")) {
    return "reapply-kill-switch";
  }

  return "staged-rollout";
}

function governanceControlLabel(
  control: CatalogIntegrationControlPlaneOverview["readiness"]["rolloutControls"]["controls"][number],
  commandKeys: readonly CatalogPrimaryWorkbenchCommandKey[],
): string {
  if (control.defaultState === "quarantined") {
    return "Provider emergency stop";
  }
  if (commandKeys.includes("start-provider-import")) {
    return "Provider import kill switch";
  }
  if (commandKeys.includes("execute-promotion")) {
    return "Promotion kill switch";
  }
  if (commandKeys.includes("start-reapply") || commandKeys.includes("start-replay")) {
    return "Reapply/replay kill switch";
  }

  return "Staged rollout control";
}

function hasCapabilityStop(
  controls: readonly CatalogIntegrationControlPlaneOverview["readiness"]["rolloutControls"]["controls"][number][],
  capability: "import" | "promotion" | "reapply",
): boolean {
  return controls.some((control) => {
    if (control.status !== "blocked") {
      return false;
    }
    const keys = governanceControlCommandKeys(control.capabilities);
    switch (capability) {
      case "import":
        return keys.includes("start-provider-import");
      case "promotion":
        return keys.includes("preview-promotion") || keys.includes("execute-promotion");
      case "reapply":
        return keys.includes("start-reapply") || keys.includes("start-replay");
    }
  });
}

function governanceRbacMatrixFor(input: {
  actions: readonly CatalogPrimaryWorkbenchActionReadModel[];
  canManage: boolean;
}): readonly GovernanceRbacRow[] {
  const readModelActions = new Map(input.actions.map((actionEntry) => [actionEntry.key, actionEntry]));

  return catalogPrimaryWorkbenchActions
    .filter((actionEntry) => actionEntry.requiredPermission === "catalog.manage" || actionEntry.confirmationRequired)
    .map((actionEntry) => {
      const readModelAction = readModelActions.get(actionEntry.key);
      const blockers = readModelAction?.blockers ?? (input.canManage ? ["unsupported-command"] : ["permission-denied"]);
      const state =
        blockers.includes("permission-denied") || blockers.includes("authorization-denied")
          ? "denied"
          : (readModelAction?.state ?? (input.canManage ? "unavailable" : "denied"));

      return {
        actionKey: actionEntry.key,
        requiredPermission: actionEntry.requiredPermission,
        routePattern: actionEntry.routePattern,
        state,
        blockers,
        confirmationRequired: actionEntry.confirmationRequired,
        destructive: actionEntry.confirmationRequired,
        deniedCopy:
          state === "denied"
            ? "catalog.manage is required; the command remains denied and no bypass is exposed."
            : `${actionEntry.requiredPermission} checked; command state is ${state}.`,
      } satisfies GovernanceRbacRow;
    });
}

function governanceObservabilityFor(input: {
  auditEvidenceUrl: string;
  conflictResolution: ConflictResolution;
  generatedAt: string | null;
  healthTriage: CatalogPrimaryWorkbenchHealthTriageReadModel;
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
  overviewAvailable: boolean;
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
}): GovernanceControls["observability"] {
  const totalJobs = input.importJobs.length;
  const failedJobs = input.importJobs.filter((job) => job.state === "failed").length;
  const failedPercent = totalJobs > 0 ? Math.round((failedJobs / totalJobs) * 100) : 0;
  const providerOptionHealth = input.healthTriage.providers.map((provider) => provider.optionQueryHealth);
  const optionStatus = statusFromHealthValues(providerOptionHealth, input.overviewAvailable);
  const projectionFreshnessStatus = projectionFreshnessStatusFor(input.healthTriage, input.overviewAvailable);
  const sourceQuarantineCount =
    input.sourceObservationReview.counts.blocked +
    input.readinessBlockers.filter((blocker) => blocker.includes("provider-transport")).length;
  const dataQuarantineCount = input.readinessBlockers.filter(
    (blocker) => blocker === "security-privacy-blocked",
  ).length;
  const conflictSpikeCount = input.conflictResolution.summary.blockingCount;
  const signals: readonly GovernanceObservabilitySignal[] = [
    governanceSignal({
      key: "option-query-latency",
      label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.signal.optionLatency"),
      status: optionStatus,
      value:
        providerOptionHealth.length > 0
          ? providerOptionHealth.join(", ")
          : input.overviewAvailable
            ? "no provider option queries reported"
            : "unavailable",
      threshold: "p95 stays within provider option query budget",
      ownerMetricKey: "catalog.integration.option_query.latency",
      auditEvidenceUrl: input.auditEvidenceUrl,
      stale: !input.overviewAvailable,
    }),
    governanceSignal({
      key: "job-failure-rate",
      label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.signal.jobFailureRate"),
      status: failedJobs > 0 ? "blocked" : input.overviewAvailable ? "ready" : "unavailable",
      value: `${failedJobs}/${totalJobs} failed (${failedPercent}%)`,
      threshold: "0 failed jobs in selected launch scope",
      ownerMetricKey: "catalog.integration.jobs.failure_rate",
      auditEvidenceUrl: input.auditEvidenceUrl,
      stale: !input.overviewAvailable,
    }),
    governanceSignal({
      key: "projection-freshness",
      label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.signal.projectionFreshness"),
      status: projectionFreshnessStatus,
      value: input.healthTriage.readModels.map((row) => `${row.queryKey}:${row.freshness}`).join(", ") || "unavailable",
      threshold: "read models are fresh or explicitly degraded",
      ownerMetricKey: "catalog.integration.projections.freshness",
      auditEvidenceUrl: input.auditEvidenceUrl,
      stale: projectionFreshnessStatus !== "ready",
    }),
    governanceSignal({
      key: "source-observation-quarantine",
      label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.signal.sourceQuarantine"),
      status: sourceQuarantineCount > 0 ? "degraded" : "ready",
      value: `${sourceQuarantineCount} quarantined or blocked source signal(s)`,
      threshold: "0 unresolved quarantine blockers",
      ownerMetricKey: "catalog.integration.source_observation.quarantine",
      auditEvidenceUrl: input.auditEvidenceUrl,
      stale: !input.overviewAvailable,
    }),
    governanceSignal({
      key: "data-quarantine",
      label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.signal.dataQuarantine"),
      status: dataQuarantineCount > 0 ? "blocked" : "ready",
      value: `${dataQuarantineCount} security/privacy quarantine blocker(s)`,
      threshold: "0 unsafe data blockers",
      ownerMetricKey: "catalog.integration.data_quarantine.count",
      auditEvidenceUrl: input.auditEvidenceUrl,
      stale: !input.overviewAvailable,
    }),
    governanceSignal({
      key: "conflict-spike",
      label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.signal.conflictSpike"),
      status:
        conflictSpikeCount > 0 ? "blocked" : input.conflictResolution.summary.conflictCount > 0 ? "degraded" : "ready",
      value: `${input.conflictResolution.summary.conflictCount} conflict(s), ${conflictSpikeCount} blocking`,
      threshold: "0 blocking promotion conflicts",
      ownerMetricKey: "catalog.integration.conflicts.spike",
      auditEvidenceUrl: input.auditEvidenceUrl,
      stale: input.conflictResolution.freshness !== "fresh",
    }),
  ];

  return {
    status: signals.some((signal) => signal.status === "blocked")
      ? "blocked"
      : signals.some((signal) => signal.status === "unavailable")
        ? "unavailable"
        : signals.some((signal) => signal.status === "degraded")
          ? "degraded"
          : "ready",
    generatedAt: input.generatedAt,
    signals,
  };
}

function governanceSignal(input: {
  key: GovernanceObservabilitySignal["key"];
  label: string;
  status: GovernanceObservabilitySignal["status"];
  value: string;
  threshold: string;
  ownerMetricKey: string;
  auditEvidenceUrl: string;
  stale: boolean;
}): GovernanceObservabilitySignal {
  const status = input.stale && input.status === "ready" ? "degraded" : input.status;

  return {
    key: input.key,
    label: input.label,
    status,
    value: input.value,
    threshold: input.threshold,
    ownerMetricKey: input.ownerMetricKey,
    evidenceUrl: input.auditEvidenceUrl,
    stale: input.stale,
    alertLinks: [
      {
        label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.alert", {
          value: input.ownerMetricKey,
        }),
        href: catalogIntegrationGrafanaDashboardHref,
      },
    ],
    runbookLinks: [
      {
        label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.runbook", {
          value: input.label,
        }),
        href: catalogIntegrationOperationsRunbookHref,
      },
    ],
  };
}

function statusFromHealthValues(
  values: readonly string[],
  overviewAvailable: boolean,
): GovernanceObservabilitySignal["status"] {
  if (!overviewAvailable || values.length === 0) {
    return "unavailable";
  }
  if (values.some((value) => value === "blocked")) {
    return "blocked";
  }
  if (values.some((value) => value === "degraded")) {
    return "degraded";
  }

  return "ready";
}

function projectionFreshnessStatusFor(
  healthTriage: CatalogPrimaryWorkbenchHealthTriageReadModel,
  overviewAvailable: boolean,
): GovernanceObservabilitySignal["status"] {
  if (!overviewAvailable || healthTriage.readModels.length === 0) {
    return "unavailable";
  }
  if (healthTriage.readModels.some((row) => row.freshness === "unavailable")) {
    return "unavailable";
  }
  if (healthTriage.readModels.some((row) => row.freshness === "partial" || row.freshness === "stale")) {
    return "degraded";
  }

  return "ready";
}

function governanceLegacyRemovalEvidenceFor(auditEvidenceUrl: string): GovernanceControls["legacyRemovalEvidence"] {
  const forbiddenSupportPaths =
    catalogPrimaryWorkbenchRetirementPolicy.forbiddenOutcomes.map(sanitizeRetiredSurfaceLabel);

  return {
    status: "removed",
    requiredDisposition: catalogPrimaryWorkbenchRetirementPolicy.requiredDisposition,
    removedSurfaces: catalogPrimaryWorkbenchRetirementPolicy.surfaces,
    forbiddenSupportPaths,
    evidence: [
      {
        key: "payload-escape-hatch",
        label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.removal.payload.label"),
        status: "removed",
        evidenceUrl: auditEvidenceUrl,
        detail: t("catalog.features.sourceObservations.ui.governanceControls.readModel.removal.payload.detail"),
      },
      {
        key: "broad-patch-compatibility",
        label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.removal.broadPatch.label"),
        status: "removed",
        evidenceUrl: auditEvidenceUrl,
        detail: t("catalog.features.sourceObservations.ui.governanceControls.readModel.removal.broadPatch.detail"),
      },
      {
        key: "legacy-selector-pattern",
        label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.removal.selector.label"),
        status: "removed",
        evidenceUrl: auditEvidenceUrl,
        detail: t("catalog.features.sourceObservations.ui.governanceControls.readModel.removal.selector.detail"),
      },
    ],
    launchBlockerIfPresent: forbiddenSupportPaths,
  };
}

function sanitizeRetiredSurfaceLabel(value: string): string {
  return value
    .replace(/raw JSON/gi, "payload")
    .replace(/support-only preserved route/gi, "support route still present")
    .replace(/support-only legacy route/gi, "legacy support route still present")
    .replace(/support-only/gi, "support route still present");
}

function cleanResetReleaseFor(input: {
  auditEvidence: AuditEvidence;
  cleanResetEvidence: CatalogIntegrationDataResetEvidencePacket | null;
  generatedAt: string;
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
  temporaryReleaseScaffolding: readonly CatalogPrimaryWorkbenchTemporaryReleaseScaffoldingInput[] | null;
}): CleanResetRelease {
  const environment = input.cleanResetEvidence?.environment ?? "production-prelaunch";
  const environmentPlan =
    catalogIntegrationDataResetEnvironmentPlans.find((plan) => plan.environment === environment) ??
    catalogIntegrationDataResetEnvironmentPlans.find((plan) => plan.environment === "production-prelaunch")!;
  const targetTables =
    input.cleanResetEvidence?.targetTables && input.cleanResetEvidence.targetTables.length > 0
      ? input.cleanResetEvidence.targetTables
      : catalogIntegrationDataResetTargetTables();
  const evidencePacket =
    input.cleanResetEvidence ??
    ({
      environment,
      generatedAt: input.generatedAt,
      operator: "",
      approvalReference: null,
      backupDecision: null,
      stagingRehearsalReference: null,
      smokeVerificationReference: null,
      targetTables,
      dryRun: null,
      before: null,
      after: null,
      forcedActiveJobReset: null,
    } satisfies CatalogIntegrationDataResetEvidencePacket);
  const resetFindings = evaluateCatalogIntegrationDataResetEvidence(evidencePacket).map((finding) => ({
    code: finding.code,
    severity: finding.severity,
    message: finding.message,
    blocksRelease: true as const,
  }));
  const cleanResetHref = catalogPrimaryWorkbenchSupportingHref(input.routeContext, "clean-reset-release");
  const auditEvidenceHref = catalogPrimaryWorkbenchSupportingHref(input.routeContext, "audit-evidence");
  const temporaryScaffolding = cleanResetScaffoldingFor({
    cleanResetHref,
    temporaryReleaseScaffolding: input.temporaryReleaseScaffolding,
  });
  const backfill = cleanResetBackfillFor({
    activeJobs: input.importJobs.filter((job) => job.state === "queued" || job.state === "running").length,
    after: evidencePacket.after,
    cleanResetEvidencePresent: Boolean(input.cleanResetEvidence),
    reviewRows: input.sourceObservationReview.rows.length,
    resetFindings,
  });
  const decisions = cleanResetDecisionsFor({
    auditEvidence: input.auditEvidence,
    backfill,
    cleanResetEvidencePresent: Boolean(input.cleanResetEvidence),
    environment,
    environmentPlan,
    evidencePacket,
    resetFindings,
    temporaryScaffolding,
  });
  const blockingDecisionCount = decisions.filter((decision) => decision.blocksRelease).length;
  const backfillRequiredCount = backfill.filter((row) => row.required).length;
  const temporaryScaffoldingRemovalRequiredCount = temporaryScaffolding.filter(
    (scaffold) => scaffold.status === "removal-required",
  ).length;
  const completeRemovalEvidenceReady = Boolean(
    decisions.find((decision) => decision.key === "complete-old-surface-removal" && !decision.blocksRelease),
  );
  const hasBlockingEvidence =
    blockingDecisionCount > 0 ||
    resetFindings.length > 0 ||
    backfill.some((row) => row.blocksRelease) ||
    temporaryScaffolding.some((scaffold) => scaffold.blocksRelease);
  const status: CleanResetRelease["status"] = hasBlockingEvidence
    ? "blocked"
    : input.cleanResetEvidence && evidencePacket.after && completeRemovalEvidenceReady
      ? "complete"
      : "partial";

  return {
    status,
    generatedAt: input.generatedAt,
    environment,
    returnToPrimaryHref: catalogPrimaryWorkbenchReturnPath(input.routeContext),
    auditEvidenceHref,
    summary: {
      decisionCount: decisions.length,
      blockingDecisionCount,
      findingCount: resetFindings.length,
      p0FindingCount: resetFindings.filter((finding) => finding.severity === "p0").length,
      targetTableCount: targetTables.length,
      backfillRequiredCount,
      temporaryScaffoldingRemovalRequiredCount,
      completeRemovalEvidenceReady,
    },
    environmentPlan: {
      mode: "pre-launch-wipe-and-rebuild",
      destructiveResetDefault: true,
      requiresBackupDecision: environmentPlan.requiresBackupDecision,
      requiresApprovalReference: environmentPlan.requiresApprovalReference,
      requiresStagingRehearsal: environment === "production-prelaunch",
      requiresSmokeVerification: environment !== "local-dev-test",
      unrelatedDataBoundary: environmentPlan.unrelatedDataBoundary,
    },
    decisions,
    resetEvidence: {
      targetTables,
      findings: resetFindings,
    },
    backfill,
    temporaryScaffolding,
    releaseProofLinks: [
      auditEvidenceLink({
        href: cleanResetHref,
        key: "clean-reset:policy",
        kind: "proof",
        label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.link.policy"),
        redactionState: "not-needed",
        summary: environmentPlan.unrelatedDataBoundary,
      }),
      auditEvidenceLink({
        href: auditEvidenceHref,
        key: "clean-reset:audit",
        kind: "audit-event",
        label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.link.audit"),
        redactionState: "redacted",
        summary: input.auditEvidence.projectionState.statusMessage,
      }),
    ],
  };
}

function cleanResetDecisionsFor(input: {
  auditEvidence: AuditEvidence;
  backfill: readonly CleanResetBackfillRow[];
  cleanResetEvidencePresent: boolean;
  environment: CleanResetRelease["environment"];
  environmentPlan: (typeof catalogIntegrationDataResetEnvironmentPlans)[number];
  evidencePacket: CatalogIntegrationDataResetEvidencePacket;
  resetFindings: CleanResetRelease["resetEvidence"]["findings"];
  temporaryScaffolding: readonly CleanResetScaffoldingRow[];
}): readonly CleanResetDecisionRow[] {
  const hasResetFindings = input.resetFindings.length > 0;
  const backupReady = !input.environmentPlan.requiresBackupDecision || Boolean(input.evidencePacket.backupDecision);
  const hasBackfillBlocker = input.backfill.some((row) => row.blocksRelease);
  const hasScaffoldingBlocker = input.temporaryScaffolding.some((row) => row.blocksRelease);
  const auditBlocked = input.auditEvidence.releaseChecklist.some((row) => row.blocksRelease);
  const cleanEvidenceStatus = (blocked: boolean, readyWhenPresent = true): CleanResetDecisionRow["status"] =>
    blocked ? "blocked" : input.cleanResetEvidencePresent && readyWhenPresent ? "complete" : "missing";

  return [
    cleanResetDecision({
      blocksRelease: hasResetFindings,
      evidence: input.cleanResetEvidencePresent
        ? t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.reset.evidenceReady")
        : t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.reset.evidenceMissing"),
      key: "destructive-reset-policy",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.reset.label"),
      owner: "catalog-source-observations",
      ownerIssue: "#1054",
      requiredEvidence: [
        "pre-launch wipe and rebuild mode",
        "dry-run counts",
        "before and after verification",
        "target table scope",
      ],
      status: cleanEvidenceStatus(hasResetFindings),
    }),
    cleanResetDecision({
      blocksRelease: !backupReady,
      evidence: backupReady
        ? backupDecisionLabel(input.evidencePacket.backupDecision)
        : t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.backup.missing"),
      key: "backup-or-data-loss",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.backup.label"),
      owner: "catalog-source-observations",
      ownerIssue: "#1054",
      requiredEvidence: [
        "backup/snapshot/export decision or accepted data loss",
        "approval reference",
        "restore verification when backup exists",
      ],
      status: cleanEvidenceStatus(!backupReady, backupReady),
    }),
    cleanResetDecision({
      blocksRelease: hasScaffoldingBlocker,
      evidence: hasScaffoldingBlocker
        ? t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.scaffolding.blocked")
        : t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.scaffolding.ready"),
      key: "deploy-skew-removal",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.scaffolding.label"),
      owner: "ops-release",
      ownerIssue: "#1061",
      requiredEvidence: [
        "deploy-skew check complete",
        "temporary reset/backfill/deploy-skew scaffolding deleted",
        "no internal support surface remains",
      ],
      status: hasScaffoldingBlocker ? "blocked" : "ready",
    }),
    cleanResetDecision({
      blocksRelease: hasBackfillBlocker,
      evidence: hasBackfillBlocker
        ? t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.backfill.blocked")
        : t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.backfill.ready"),
      key: "backfill-clean-state",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.backfill.label"),
      owner: "catalog-source-observations",
      ownerIssue: "#1054",
      requiredEvidence: [
        "backfill skipped after clean wipe",
        "or retained data backfilled to clean launch semantics",
        "legacy profile references are zero",
      ],
      status: hasBackfillBlocker ? "blocked" : input.cleanResetEvidencePresent ? "complete" : "missing",
    }),
    cleanResetDecision({
      blocksRelease: auditBlocked || hasResetFindings,
      evidence: input.auditEvidence.releaseChecklist.map((row) => `${row.workflowLabel}: ${row.status}`).join("; "),
      key: "release-acceptance",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.release.label"),
      owner: "ops-release",
      ownerIssue: "#1061",
      requiredEvidence: ["staging smoke", "production/prelaunch smoke", "audit evidence", "release signoff"],
      status: auditBlocked || hasResetFindings ? "blocked" : "ready",
    }),
    cleanResetDecision({
      blocksRelease: hasScaffoldingBlocker,
      evidence:
        "Complete removal of code, patterns, documentation, tests, fixtures, screenshots, runbooks, release notes, and operator instructions is required before launch.",
      key: "complete-old-surface-removal",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.removal.label"),
      owner: "ops-release",
      ownerIssue: "#1090",
      requiredEvidence: [
        "complete removal of code",
        "complete removal of product and UX patterns",
        "complete removal of documentation, runbooks, release notes, and operator instructions",
        "complete removal of tests, fixtures, and screenshots that preserve retired behavior",
        "no hidden flag, fallback branch, compatibility redirect, migration shim, alias, or support-only path",
      ],
      status: hasScaffoldingBlocker ? "blocked" : "ready",
    }),
  ];
}

function cleanResetDecision(input: CleanResetDecisionRow): CleanResetDecisionRow {
  return input;
}

function cleanResetBackfillFor(input: {
  activeJobs: number;
  after: CatalogIntegrationDataResetEvidencePacket["after"];
  cleanResetEvidencePresent: boolean;
  reviewRows: number;
  resetFindings: CleanResetRelease["resetEvidence"]["findings"];
}): readonly CleanResetBackfillRow[] {
  const missingResetEvidence = !input.cleanResetEvidencePresent || input.resetFindings.length > 0 || !input.after;
  const retainedObservations = (input.after?.sourceObservations ?? input.reviewRows) > 0;
  const legacyReferences = (input.after?.legacySourceObservationReferences ?? 0) > 0;
  const retainedJobs =
    (input.after?.integrationDurableJobs ?? input.activeJobs) > 0 ||
    (input.after?.bulkReviewJobs ?? 0) > 0 ||
    input.activeJobs > 0;
  const rows: readonly (CatalogIntegrationDataBackfillDecision & Readonly<{ blocked: boolean; evidence: string }>)[] = [
    {
      key: "profile-section-projections",
      required: missingResetEvidence || Boolean(input.after && input.after.profileSections === 0),
      reason:
        "Profile section projections are rebuilt from retained or seeded profile versions after reset; clean wipe evidence may skip additional backfill.",
      blocked: missingResetEvidence || Boolean(input.after && input.after.profileSections === 0),
      evidence: input.after
        ? `${input.after.profileSections} section row(s), ${input.after.profileSectionDiagnostics} diagnostic row(s)`
        : "reset after-report missing",
    },
    {
      key: "source-observation-profile-references",
      required: missingResetEvidence || retainedObservations || legacyReferences,
      reason:
        "Retained Source Observations must carry clean source and promotion profile references; prelaunch wipe leaves zero retained observations.",
      blocked: missingResetEvidence || retainedObservations || legacyReferences,
      evidence: input.after
        ? `${input.after.sourceObservations} observation(s), ${input.after.legacySourceObservationReferences} legacy reference(s)`
        : "reset after-report missing",
    },
    {
      key: "durable-job-profile-snapshots",
      required: missingResetEvidence || retainedJobs,
      reason:
        "Retained durable jobs must keep readable clean profile snapshots; clean wipe leaves no retained import or review jobs.",
      blocked: missingResetEvidence || retainedJobs,
      evidence: input.after
        ? `${input.after.integrationDurableJobs} import job(s), ${input.after.bulkReviewJobs} review job(s)`
        : "reset after-report missing",
    },
  ];

  return rows.map((row) => ({
    key: row.key,
    required: row.required,
    status: row.blocked ? "blocked" : row.required ? "complete" : ("skipped-clean-reset" as const),
    reason: row.reason,
    evidence: row.evidence,
    blocksRelease: row.blocked,
  }));
}

function cleanResetScaffoldingFor(input: {
  cleanResetHref: string;
  temporaryReleaseScaffolding: readonly CatalogPrimaryWorkbenchTemporaryReleaseScaffoldingInput[] | null;
}): readonly CleanResetScaffoldingRow[] {
  const defaultRows: readonly CatalogPrimaryWorkbenchTemporaryReleaseScaffoldingInput[] = [
    {
      key: "reset-execution-scaffold",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.scaffolding.reset"),
      ownerIssue: "#1054",
      status: "not-used",
    },
    {
      key: "backfill-verification-scaffold",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.scaffolding.backfill"),
      ownerIssue: "#1054",
      status: "not-used",
    },
    {
      key: "deploy-skew-release-scaffold",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.scaffolding.deploySkew"),
      ownerIssue: "#1061",
      status: "not-used",
    },
    {
      key: "old-surface-removal-scaffold",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.scaffolding.oldSurface"),
      ownerIssue: "#1090",
      status: "not-used",
    },
  ];

  return (input.temporaryReleaseScaffolding?.length ? input.temporaryReleaseScaffolding : defaultRows).map((row) => ({
    key: row.key,
    label: row.label,
    status: row.status,
    ownerIssue: row.ownerIssue,
    evidenceUrl: row.evidenceUrl ?? input.cleanResetHref,
    deletionRequiredBeforeLaunch: true,
    blocksRelease: row.status === "removal-required",
    removalEvidence:
      row.removalEvidence ??
      (row.status === "not-used"
        ? t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.scaffolding.notUsed")
        : row.status === "removed"
          ? t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.scaffolding.removed")
          : t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.scaffolding.required")),
  }));
}

function backupDecisionLabel(
  decision: CatalogIntegrationDataResetEvidencePacket["backupDecision"] | undefined,
): string {
  if (!decision) {
    return t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.backup.none");
  }
  if (decision.kind === "create-backup-snapshot-export") {
    return `${decision.reference}; ${decision.restoreVerificationReference}`;
  }
  if (decision.kind === "skip-backup-accepted-data-loss") {
    return `${decision.approver}: ${decision.targetDataSet}`;
  }

  return `${decision.owner}: ${decision.reason}`;
}

function auditEvidenceFor(input: {
  conflictResolution: ConflictResolution;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  generatedAt: string;
  governanceControls: GovernanceControls;
  healthTriage: CatalogPrimaryWorkbenchHealthTriageReadModel;
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
  lifecycleRecovery: LifecycleRecovery;
  promotionPreview: CatalogPrimaryWorkbenchReadModel["promotionPreview"];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  securityPrivacy: CatalogPrimaryWorkbenchReadModel["securityPrivacy"];
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
  validationReadiness: ValidationReadiness;
}): AuditEvidence {
  const auditTimelineHref = catalogPrimaryWorkbenchSupportingHref(input.routeContext, "audit-evidence");
  const projection = input.controlPlaneOverview?.auditLifecycle ?? null;
  const projectionState: AuditEvidence["projectionState"] = {
    queryKey: "audit-evidence-timeline",
    freshness: !projection || projection.projectionStatus === "unavailable" ? "unavailable" : "partial",
    generatedAt: projection?.generatedAt ?? null,
    statusMessage:
      projection?.statusMessage ??
      t("catalog.features.sourceObservations.ui.auditEvidence.readModel.projection.unavailable"),
    missingProjection: !projection || projection.projectionStatus === "unavailable",
    partialProjection: Boolean(projection && projection.projectionStatus === "partial"),
  };
  const timeline = dedupeAuditTimelineRows([
    ...auditProjectionRowsFor({
      auditTimelineHref,
      entries: projection?.entries ?? [],
      routeContext: input.routeContext,
    }),
    ...auditJobRowsFor({ auditTimelineHref, jobs: input.importJobs }),
    ...auditSourceObservationRowsFor({
      auditTimelineHref,
      routeContext: input.routeContext,
      rows: input.sourceObservationReview.rows,
    }),
    ...auditDryRunRowsFor({
      auditTimelineHref,
      routeContext: input.routeContext,
      rows: input.validationReadiness.dryRunEvidence,
    }),
    ...auditPromotionRowsFor({
      auditTimelineHref,
      promotionPreview: input.promotionPreview,
      routeContext: input.routeContext,
    }),
    ...auditConflictRowsFor({
      auditTimelineHref,
      events: input.conflictResolution.recentAuditEvents,
    }),
    auditGovernanceRemovalRowFor({
      auditTimelineHref,
      generatedAt: input.generatedAt,
      governanceControls: input.governanceControls,
      routeContext: input.routeContext,
    }),
  ])
    .filter((row) => auditTimelineRowMatchesContext(row, input.routeContext))
    .slice(0, 50);
  const releaseChecklist = auditReleaseChecklistFor({
    auditTimelineHref,
    conflictResolution: input.conflictResolution,
    governanceControls: input.governanceControls,
    importJobs: input.importJobs,
    lifecycleRecovery: input.lifecycleRecovery,
    projectionState,
    promotionPreview: input.promotionPreview,
    routeContext: input.routeContext,
    sourceObservationReview: input.sourceObservationReview,
    validationReadiness: input.validationReadiness,
  });
  const evidenceLinks = dedupeAuditEvidenceLinks([
    ...timeline.flatMap((row) => row.evidenceLinks),
    ...releaseChecklist.flatMap((row) => row.proofLinks),
  ]);
  const missingEvidence = releaseChecklist.filter((row) => row.status === "missing" || row.status === "blocked").length;
  const partialProjectionCount =
    (projectionState.partialProjection ? 1 : 0) +
    input.healthTriage.readModels.filter((state) => state.freshness === "partial" || state.freshness === "stale")
      .length;
  const residualDebtItems = releaseChecklist.reduce((count, row) => count + row.residualDebt.length, 0);
  const status: AuditEvidence["status"] = projectionState.missingProjection
    ? "unavailable"
    : releaseChecklist.some((row) => row.status === "blocked" && row.blocksRelease)
      ? "blocked"
      : projectionState.partialProjection ||
          releaseChecklist.some((row) => row.status === "partial" || row.status === "missing")
        ? "partial"
        : "ready";

  return {
    status,
    freshness: projectionState.freshness,
    generatedAt: input.generatedAt,
    returnToPrimaryHref: catalogPrimaryWorkbenchReturnPath(input.routeContext),
    summary: {
      timelineEvents: timeline.length,
      redactedEvidenceLinks: evidenceLinks.length,
      releaseChecklistItems: releaseChecklist.length,
      missingEvidence,
      partialProjectionCount,
      residualDebtItems,
    },
    filters: auditFiltersFor(input.routeContext, timeline),
    projectionState,
    redactionPolicy: {
      sourcePayloadAccess: "not-required",
      profileSnapshotAccess: "not-required",
      unsafeEvidenceBlocked: input.securityPrivacy.unsafeEvidenceBlocked,
      governedDataClasses: input.securityPrivacy.governedDataClasses,
      forbiddenEvidenceRequests: [
        "source payload body download",
        "provider profile snapshot document",
        "compatibility fallback export",
        "operator identity expansion",
      ],
      summary: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.redaction.summary"),
    },
    timeline,
    evidenceLinks,
    releaseChecklist,
  };
}

function auditProjectionRowsFor(input: {
  auditTimelineHref: string;
  entries: readonly CatalogIntegrationControlPlaneOverview["auditLifecycle"]["entries"][number][];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
}): readonly AuditTimelineRow[] {
  return input.entries.map((entry) => {
    const targetType = auditTargetTypeForCategory(entry.category);
    const targetId =
      entry.relatedJobId ??
      entry.profileVersion ??
      entry.unitKey ??
      entry.providerKey ??
      t("catalog.features.sourceObservations.ui.auditEvidence.readModel.target.controlPlane");

    return {
      eventId: entry.eventId,
      occurredAt: entry.occurredAt,
      eventName: entry.eventName,
      category: entry.category,
      actorLabel: entry.actorUserId
        ? t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.operator", {
            value: entry.actorUserId,
          })
        : t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.system"),
      targetType,
      targetId,
      providerKey: entry.providerKey,
      unitKey: entry.unitKey as CatalogIntegrationUnitKey | null,
      profileVersion: entry.profileVersion,
      jobId: entry.relatedJobId,
      observationId: null,
      catalogItemId: null,
      summary: entry.summary,
      diagnosticCodes: entry.diagnosticCodes,
      redactionState: "redacted",
      evidenceLinks: [
        auditEvidenceLink({
          href: input.auditTimelineHref,
          key: `audit:${entry.eventId}`,
          kind: "audit-event",
          label: entry.eventName,
          summary: entry.summary,
        }),
      ],
    } satisfies AuditTimelineRow;
  });
}

function auditJobRowsFor(input: {
  auditTimelineHref: string;
  jobs: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
}): readonly AuditTimelineRow[] {
  return input.jobs.slice(0, 12).map((job) => {
    const eventName =
      job.action === "start-provider-import" && job.state === "failed"
        ? "import-job-failed"
        : job.action === "start-provider-import" && job.state === "completed"
          ? "import-job-completed"
          : job.action === "start-provider-import"
            ? "import-job-started"
            : "reapply-run-executed";
    return {
      eventId: `job:${job.jobId}:${job.state}`,
      occurredAt: job.startedAt ?? job.createdAt,
      eventName,
      category: job.action === "start-provider-import" ? "import-job" : "reapply",
      actorLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.jobWorker"),
      targetType: "import-job",
      targetId: job.jobId,
      providerKey: job.providerKey,
      unitKey: job.unitKey,
      profileVersion: job.profileVersion,
      jobId: job.jobId,
      observationId: null,
      catalogItemId: null,
      summary: job.summary,
      diagnosticCodes: job.failureGroups.map((group) => group.key),
      redactionState: "redacted",
      evidenceLinks: [
        auditEvidenceLink({
          href: input.auditTimelineHref,
          key: `job:${job.jobId}`,
          kind: job.failureGroups.length > 0 ? "diagnostic" : "audit-event",
          label: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.link.job", { value: job.jobId }),
          summary: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.job.summary", {
            completed: String(job.completed),
            percent: String(job.progressPercent),
            status: job.operatorStatus,
            total: String(job.total),
          }),
        }),
      ],
    } satisfies AuditTimelineRow;
  });
}

function auditSourceObservationRowsFor(input: {
  auditTimelineHref: string;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  rows: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"];
}): readonly AuditTimelineRow[] {
  return input.rows.slice(0, 16).map((row) => ({
    eventId: `source-observation:${row.observationId}:${row.status}`,
    occurredAt: row.changedAt ?? row.observedAt,
    eventName: row.status === "changed" ? "source-observation-changed" : "source-observation-recorded",
    category: "source-observation",
    actorLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.providerAdapter"),
    targetType: "source-observation",
    targetId: row.observationId,
    providerKey: row.providerKey,
    unitKey: input.routeContext.unitKey,
    profileVersion: row.sourceProfileVersion,
    jobId: input.routeContext.jobId,
    observationId: row.observationId,
    catalogItemId: null,
    summary: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.sourceObservation.summary", {
      name: row.displayName,
      summary: row.redactionSummary,
    }),
    diagnosticCodes: [...row.promotionReadiness.blockers, ...row.duplicateEvidence, ...row.conflictEvidence].slice(
      0,
      8,
    ),
    redactionState: "redacted",
    evidenceLinks: [
      auditEvidenceLink({
        href: row.detailHref || input.auditTimelineHref,
        key: `source-observation:${row.observationId}`,
        kind: row.promotionReadiness.blockers.length > 0 ? "diagnostic" : "audit-event",
        label: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.link.observation", {
          value: row.observationId,
        }),
        summary: row.payloadSummary,
      }),
    ],
  }));
}

function auditDryRunRowsFor(input: {
  auditTimelineHref: string;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  rows: ValidationReadiness["dryRunEvidence"];
}): readonly AuditTimelineRow[] {
  return input.rows.slice(0, 8).map((row) => ({
    eventId: `dry-run:${row.externalKey}`,
    occurredAt: new Date(0).toISOString(),
    eventName: "dry-run-executed",
    category: "dry-run",
    actorLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.system"),
    targetType: "provider-profile",
    targetId: input.routeContext.profileVersion ?? row.externalKey,
    providerKey: input.routeContext.providerKey,
    unitKey: input.routeContext.unitKey,
    profileVersion: input.routeContext.profileVersion,
    jobId: null,
    observationId: null,
    catalogItemId: null,
    summary: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.dryRun.summary", {
      evidence: row.auditEvidence.join("; "),
      externalKey: row.externalKey,
      status: row.status,
    }),
    diagnosticCodes: row.diagnostics.map((diagnostic) => diagnostic.code),
    redactionState: "redacted",
    evidenceLinks: [
      auditEvidenceLink({
        href: input.auditTimelineHref,
        key: `dry-run:${row.externalKey}`,
        kind: "proof",
        label: row.externalKey,
        summary:
          row.redactionSummary
            .map((entry) =>
              t("catalog.features.sourceObservations.ui.auditEvidence.readModel.redaction.entry", {
                label: entry.label,
                value: entry.value,
              }),
            )
            .join("; ") || row.status,
      }),
    ],
  }));
}

function auditPromotionRowsFor(input: {
  auditTimelineHref: string;
  promotionPreview: CatalogPrimaryWorkbenchReadModel["promotionPreview"];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
}): readonly AuditTimelineRow[] {
  if (!input.promotionPreview.previewId && !input.promotionPreview.commandPlanHash) {
    return [];
  }

  return [
    {
      eventId: `promotion-preview:${input.promotionPreview.previewId ?? input.promotionPreview.commandPlanHash}`,
      occurredAt: new Date(0).toISOString(),
      eventName: "promotion-plan-generated",
      category: "promotion",
      actorLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.operatorScope"),
      targetType: "catalog-item",
      targetId: input.promotionPreview.commandPlanHash ?? input.promotionPreview.previewId ?? "promotion-preview",
      providerKey: input.routeContext.providerKey,
      unitKey: input.routeContext.unitKey,
      profileVersion: input.routeContext.profileVersion,
      jobId: input.routeContext.jobId,
      observationId: input.promotionPreview.scope.selectedObservationIds.at(0) ?? null,
      catalogItemId: null,
      summary: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.promotion.summary", {
        eligible: String(input.promotionPreview.outcomeCounts.eligible),
        blocked: String(input.promotionPreview.outcomeCounts.blocked),
      }),
      diagnosticCodes: input.promotionPreview.blockers,
      redactionState: "redacted",
      evidenceLinks: [
        auditEvidenceLink({
          href: input.auditTimelineHref,
          key: `promotion-preview:${input.promotionPreview.previewId ?? "pending"}`,
          kind: "proof",
          label: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.link.promotion"),
          summary: input.promotionPreview.commandPlanHash ?? "pending promotion command plan",
        }),
      ],
    },
  ];
}

function auditConflictRowsFor(input: {
  auditTimelineHref: string;
  events: ConflictResolution["recentAuditEvents"];
}): readonly AuditTimelineRow[] {
  return input.events.map((event) => ({
    eventId: `conflict:${event.eventId}`,
    occurredAt: event.occurredAt,
    eventName: "diagnostics-present",
    category: "diagnostic",
    actorLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.system"),
    targetType: event.observationId ? "source-observation" : "control-plane",
    targetId: event.observationId ?? event.providerKey,
    providerKey: event.providerKey,
    unitKey: event.unitKey,
    profileVersion: null,
    jobId: null,
    observationId: event.observationId,
    catalogItemId: null,
    summary: event.summary,
    diagnosticCodes: [event.eventName],
    redactionState: "redacted",
    evidenceLinks: [
      auditEvidenceLink({
        href: input.auditTimelineHref,
        key: `conflict:${event.eventId}`,
        kind: "diagnostic",
        label: event.eventName,
        summary: event.summary,
      }),
    ],
  }));
}

function auditGovernanceRemovalRowFor(input: {
  auditTimelineHref: string;
  generatedAt: string;
  governanceControls: GovernanceControls;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
}): AuditTimelineRow {
  return {
    eventId: "release:retired-compatibility-removal",
    occurredAt: input.generatedAt,
    eventName: "diagnostics-present",
    category: "diagnostic",
    actorLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.releaseOwner"),
    targetType: "release",
    targetId: "retired-compatibility-removal",
    providerKey: input.routeContext.providerKey,
    unitKey: input.routeContext.unitKey,
    profileVersion: input.routeContext.profileVersion,
    jobId: input.routeContext.jobId,
    observationId: null,
    catalogItemId: null,
    summary: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.retirement.summary"),
    diagnosticCodes: input.governanceControls.legacyRemovalEvidence.launchBlockerIfPresent,
    redactionState: "not-needed",
    evidenceLinks: input.governanceControls.legacyRemovalEvidence.evidence.map((evidence) =>
      auditEvidenceLink({
        href: input.auditTimelineHref,
        key: `retirement:${evidence.key}`,
        kind: "release-note",
        label: evidence.label,
        redactionState: "not-needed",
        summary: evidence.detail,
      }),
    ),
  };
}

function auditReleaseChecklistFor(input: {
  auditTimelineHref: string;
  conflictResolution: ConflictResolution;
  governanceControls: GovernanceControls;
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
  lifecycleRecovery: LifecycleRecovery;
  projectionState: AuditEvidence["projectionState"];
  promotionPreview: CatalogPrimaryWorkbenchReadModel["promotionPreview"];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
  validationReadiness: ValidationReadiness;
}): readonly ReleaseEvidenceChecklistRow[] {
  const failedJobs = input.importJobs.filter((job) => job.state === "failed").length;
  const activeJobs = input.importJobs.filter((job) => job.state === "queued" || job.state === "running").length;
  const sourceRows = input.sourceObservationReview.rows.length;
  const promotionReady =
    input.promotionPreview.scope.eligibleCount > 0 &&
    input.promotionPreview.commandPlanHash !== null &&
    input.promotionPreview.blockers.length === 0;
  const dryRunCount = input.validationReadiness.dryRunEvidence.length;
  const lifecycleEvents = input.lifecycleRecovery.recentAuditEvents.length;

  return [
    releaseChecklistRow({
      auditTimelineHref: input.auditTimelineHref,
      blocksRelease: failedJobs > 0,
      owner: "catalog-source-observations",
      proofKey: "provider-data-pull",
      proofSummary: `${input.importJobs.length} job(s), ${activeJobs} active, ${failedJobs} failed`,
      releaseNote: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.provider.releaseNote"),
      requiredEvidence: [
        "import job state",
        "provider/unit scope",
        "adapter readiness",
        "job consistency",
        "redacted job summary",
      ],
      residualDebt:
        input.importJobs.length === 0
          ? [t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.provider.noJobs")]
          : [],
      smokeProof: "production smoke opens protected Catalog integration workbench after sign-in",
      status: failedJobs > 0 ? "blocked" : input.importJobs.length > 0 ? "ready" : "partial",
      tests: [
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-read-model.test.ts",
        "deployables/admin-web/e2e/catalog-integrations.spec.ts",
      ],
      workflowKey: "provider-data-pull",
      workflowLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.provider.label"),
    }),
    releaseChecklistRow({
      auditTimelineHref: input.auditTimelineHref,
      blocksRelease: input.sourceObservationReview.freshness === "unavailable",
      owner: "catalog-source-observations",
      proofKey: "source-observation-review",
      proofSummary: `${sourceRows} row(s), ${input.sourceObservationReview.counts.eligible} eligible`,
      releaseNote: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.review.releaseNote"),
      requiredEvidence: [
        "Source Observation filters",
        "redacted fact summaries",
        "duplicate/conflict evidence",
        "review actions",
      ],
      residualDebt:
        sourceRows === 0
          ? [t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.review.noRows")]
          : [],
      smokeProof: "review table renders with redacted evidence and no document fallback",
      status:
        input.sourceObservationReview.freshness === "unavailable" ? "blocked" : sourceRows > 0 ? "ready" : "partial",
      tests: [
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-page.test.tsx",
        "bounded-contexts/catalog/features/source-observations/api/catalog-integration-no-confusion-ux-acceptance.test.ts",
      ],
      workflowKey: "source-observation-review",
      workflowLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.review.label"),
    }),
    releaseChecklistRow({
      auditTimelineHref: input.auditTimelineHref,
      blocksRelease: input.promotionPreview.blockers.length > 0,
      owner: "catalog-source-observations",
      proofKey: "promotion",
      proofSummary: input.promotionPreview.commandPlanHash ?? "promotion command plan pending",
      releaseNote: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.promotion.releaseNote"),
      requiredEvidence: [
        "promotion plan hash",
        "eligible/blocked disposition counts",
        "stale preview safeguards",
        "idempotency proof",
      ],
      residualDebt: promotionReady
        ? []
        : input.promotionPreview.blockers.map((blocker) => `promotion blocker: ${blocker}`),
      smokeProof: "promotion preview and confirmation render with stale preview protection",
      status: promotionReady ? "ready" : input.promotionPreview.blockers.length > 0 ? "blocked" : "partial",
      tests: [
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-read-model.test.ts",
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-page.test.tsx",
      ],
      workflowKey: "promotion",
      workflowLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.promotion.label"),
    }),
    releaseChecklistRow({
      auditTimelineHref: input.auditTimelineHref,
      blocksRelease: false,
      owner: "catalog-source-observations",
      proofKey: "dry-run-diagnostics",
      proofSummary: `${dryRunCount} dry-run evidence row(s)`,
      releaseNote: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.dryRun.releaseNote"),
      requiredEvidence: ["fixture coverage", "dry-run summaries", "diagnostics", "activation readiness"],
      residualDebt:
        dryRunCount === 0
          ? [t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.dryRun.noEvidence")]
          : [],
      smokeProof: "validation readiness workspace links back to import workbench",
      status: dryRunCount > 0 ? "ready" : "partial",
      tests: [
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-read-model.test.ts",
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-page.test.tsx",
      ],
      workflowKey: "dry-run-diagnostics",
      workflowLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.dryRun.label"),
    }),
    releaseChecklistRow({
      auditTimelineHref: input.auditTimelineHref,
      blocksRelease: false,
      owner: "catalog-source-observations",
      proofKey: "reapply-rollback",
      proofSummary: `${input.lifecycleRecovery.operations.length} lifecycle action(s), ${lifecycleEvents} event(s)`,
      releaseNote: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.lifecycle.releaseNote"),
      requiredEvidence: ["reapply semantics", "replay semantics", "rollback impact", "retirement impact"],
      residualDebt:
        input.lifecycleRecovery.status === "blocked"
          ? [t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.lifecycle.blocked")]
          : [],
      smokeProof: "lifecycle recovery workspace exposes confirmation and evidence links",
      status: input.lifecycleRecovery.status === "blocked" ? "partial" : lifecycleEvents > 0 ? "ready" : "partial",
      tests: [
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-read-model.test.ts",
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-page.test.tsx",
      ],
      workflowKey: "reapply-rollback",
      workflowLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.lifecycle.label"),
    }),
    releaseChecklistRow({
      auditTimelineHref: input.auditTimelineHref,
      blocksRelease: false,
      owner: "catalog-source-observations",
      proofKey: "governance-retirement",
      proofSummary: `${input.governanceControls.legacyRemovalEvidence.evidence.length} deletion evidence row(s)`,
      releaseNote: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.retirement.releaseNote"),
      requiredEvidence: [
        "complete removal of code, patterns, documentation, tests, fixtures, screenshots, runbooks, release notes, and operator instructions",
        "no hidden flag",
        "no fallback branch",
        "no compatibility redirect",
        "no migration shim",
      ],
      residualDebt: [],
      smokeProof: "governance workspace shows retired compatibility removal as complete-removal",
      status: "ready",
      tests: [
        "bounded-contexts/catalog/features/source-observations/api/primary-workbench-admin-contracts.test.ts",
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-page.test.tsx",
      ],
      workflowKey: "governance-retirement",
      workflowLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.retirement.label"),
    }),
    releaseChecklistRow({
      auditTimelineHref: input.auditTimelineHref,
      blocksRelease: input.projectionState.missingProjection,
      owner: "ops-release",
      proofKey: "release-smoke",
      proofSummary: input.projectionState.statusMessage,
      releaseNote: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.smoke.releaseNote"),
      requiredEvidence: ["unit tests", "E2E proof", "static verification", "staging smoke", "production smoke"],
      residualDebt: input.projectionState.partialProjection
        ? [t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.smoke.partialProjection")]
        : [],
      smokeProof: "release notes link tests, E2E proof, smoke checks, and accepted residual debt",
      status: input.projectionState.missingProjection
        ? "blocked"
        : input.projectionState.partialProjection
          ? "partial"
          : "ready",
      tests: ["pnpm run verify:static", "pnpm --dir bounded-contexts/catalog run test:fast"],
      workflowKey: "release-smoke",
      workflowLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.smoke.label"),
    }),
  ];
}

function releaseChecklistRow(
  input: Omit<ReleaseEvidenceChecklistRow, "e2eProof" | "proofLinks"> &
    Readonly<{ auditTimelineHref: string; proofKey: string; proofSummary: string }>,
): ReleaseEvidenceChecklistRow {
  return {
    workflowKey: input.workflowKey,
    workflowLabel: input.workflowLabel,
    status: input.status,
    owner: input.owner,
    requiredEvidence: input.requiredEvidence,
    proofLinks: [
      auditEvidenceLink({
        href: input.auditTimelineHref,
        key: `release:${input.proofKey}`,
        kind: "proof",
        label: input.workflowLabel,
        summary: input.proofSummary,
      }),
    ],
    tests: input.tests,
    e2eProof: "deployables/admin-web/e2e/catalog-integrations.spec.ts",
    smokeProof: input.smokeProof,
    residualDebt: input.residualDebt,
    releaseNote: input.releaseNote,
    blocksRelease: input.blocksRelease,
  };
}

function auditFiltersFor(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
  timeline: readonly AuditTimelineRow[],
): AuditEvidence["filters"] {
  const categories = uniqueSorted(timeline.map((row) => row.category));
  const actorLabels = uniqueSorted(timeline.map((row) => row.actorLabel));
  const occurredAtValues = timeline.map((row) => row.occurredAt).sort();

  return [
    auditFilter("provider", "Provider", routeContext.providerKey, uniqueSorted(timeline.map((row) => row.providerKey))),
    auditFilter("unit", "Unit", routeContext.unitKey, uniqueSorted(timeline.map((row) => row.unitKey))),
    auditFilter(
      "profile-version",
      "Profile version",
      routeContext.profileVersion,
      uniqueSorted(timeline.map((row) => row.profileVersion)),
    ),
    auditFilter("job", "Job", routeContext.jobId, uniqueSorted(timeline.map((row) => row.jobId))),
    auditFilter(
      "observation",
      "Observation",
      routeContext.selectedObservationIds.join(", ") || null,
      uniqueSorted(timeline.map((row) => row.observationId)),
    ),
    auditFilter(
      "action-category",
      "Action category",
      routeContext.sourceObservationFilters.auditCategory ?? null,
      categories,
    ),
    auditFilter("actor", "Actor", routeContext.sourceObservationFilters.actor ?? null, actorLabels),
    auditFilter(
      "time",
      "Time",
      routeContext.sourceObservationFilters.since ?? null,
      occurredAtValues.length > 0 ? [occurredAtValues[0] ?? "", occurredAtValues.at(-1) ?? ""] : [],
    ),
  ];
}

function auditFilter(
  key: AuditEvidence["filters"][number]["key"],
  label: string,
  value: string | null,
  options: readonly (string | null)[],
): AuditEvidence["filters"][number] {
  const normalizedOptions = uniqueSorted(options);
  return {
    key,
    label,
    value,
    options: normalizedOptions,
    active: Boolean(value),
  };
}

function auditTargetTypeForCategory(category: string): AuditTimelineRow["targetType"] {
  switch (category) {
    case "profile":
    case "profile-section":
    case "activation":
    case "dry-run":
    case "fixture-validation":
      return "provider-profile";
    case "import-job":
    case "reapply":
      return "import-job";
    case "source-observation":
      return "source-observation";
    case "promotion":
      return "catalog-item";
    default:
      return "control-plane";
  }
}

function auditEvidenceLink(input: {
  href: string;
  key: string;
  kind: AuditEvidenceLink["kind"];
  label: string;
  redactionState?: AuditEvidenceLink["redactionState"];
  summary: string;
}): AuditEvidenceLink {
  return {
    key: input.key,
    label: input.label,
    href: input.href,
    kind: input.kind,
    summary: input.summary,
    redactionState: input.redactionState ?? "redacted",
    sourcePayloadAccess: "not-required",
    profileSnapshotAccess: "not-required",
  };
}

function auditTimelineRowMatchesContext(
  row: AuditTimelineRow,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): boolean {
  if (routeContext.providerKey && row.providerKey && row.providerKey !== routeContext.providerKey) {
    return false;
  }
  if (routeContext.unitKey && row.unitKey && row.unitKey !== routeContext.unitKey) {
    return false;
  }
  if (routeContext.profileVersion && row.profileVersion && row.profileVersion !== routeContext.profileVersion) {
    return false;
  }
  if (routeContext.jobId && row.jobId && row.jobId !== routeContext.jobId) {
    return false;
  }
  if (
    routeContext.selectedObservationIds.length > 0 &&
    row.observationId &&
    !routeContext.selectedObservationIds.includes(row.observationId)
  ) {
    return false;
  }

  return true;
}

function dedupeAuditTimelineRows(rows: readonly AuditTimelineRow[]): readonly AuditTimelineRow[] {
  const seen = new Set<string>();
  const deduped: AuditTimelineRow[] = [];
  for (const row of rows) {
    if (seen.has(row.eventId)) {
      continue;
    }
    seen.add(row.eventId);
    deduped.push(row);
  }

  return deduped.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

function dedupeAuditEvidenceLinks(links: readonly AuditEvidenceLink[]): readonly AuditEvidenceLink[] {
  const seen = new Set<string>();
  const deduped: AuditEvidenceLink[] = [];
  for (const link of links) {
    if (seen.has(link.key)) {
      continue;
    }
    seen.add(link.key);
    deduped.push(link);
  }

  return deduped;
}

function uniqueSorted(values: readonly (string | null)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b));
}

function hasConflictResolutionEvidence(
  row: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number],
): boolean {
  return (
    row.duplicateEvidence.length > 0 ||
    row.conflictEvidence.length > 0 ||
    row.promotionReadiness.blockers.includes("promotion-conflict") ||
    row.commandPreview.disposition === "conflicting"
  );
}

function conflictResolutionRowFor(
  row: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number],
  input: {
    canManage: boolean;
    promotionPreview: CatalogPrimaryWorkbenchReadModel["promotionPreview"];
  },
): ConflictResolutionRow {
  const resolutionState = conflictResolutionStateFor(row);
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>(row.promotionReadiness.blockers);
  if (row.duplicateEvidence.length > 0) {
    blockers.add("duplicate-conflict");
  }
  if (
    row.promotionReadiness.blockers.includes("promotion-conflict") ||
    input.promotionPreview.blockers.includes("promotion-conflict")
  ) {
    blockers.add("promotion-conflict");
  }
  const overrideBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] = input.canManage
    ? ["unsupported-command"]
    : ["permission-denied", "unsupported-command"];

  return {
    observationId: row.observationId,
    displayName: row.displayName,
    providerKey: row.providerKey,
    externalKey: row.externalKey,
    affectedFact: row.normalizedFactSummaries[0] ?? row.displayName,
    factKey: conflictFactKeyFor(row),
    resolutionState,
    promotionReadinessState: row.promotionReadiness.state,
    precedenceRuleId: conflictPrecedenceRuleIdFor(row, resolutionState),
    candidateValues: conflictCandidateValuesFor(row),
    evidencePaths: conflictEvidencePathsFor(row),
    diagnostics: conflictDiagnosticsFor(row, blockers),
    blockers: [...blockers],
    auditTrail: row.auditTrail,
    detailHref: row.detailHref,
    overrideAction: {
      state: input.canManage ? "unavailable" : "denied",
      blockers: overrideBlockers,
      auditRequired: true,
    },
  };
}

function conflictResolutionStateFor(
  row: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number],
): ConflictResolutionRow["resolutionState"] {
  if (row.promotionReadiness.blockers.includes("promotion-conflict")) {
    return "blocks-promotion";
  }
  if (row.duplicateEvidence.length > 0) {
    return "requires-review";
  }

  return "auto-resolved";
}

function conflictFactKeyFor(row: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number]): string {
  if (row.duplicateEvidence.length > 0) {
    return "merge-identity";
  }
  if (row.statusReason) {
    return "status-reason";
  }

  return "normalized-facts";
}

function conflictPrecedenceRuleIdFor(
  row: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number],
  resolutionState: ConflictResolutionRow["resolutionState"],
): string {
  if (resolutionState === "blocks-promotion") {
    return "promotion-command.conflict-blocking.v1";
  }
  if (row.duplicateEvidence.length > 0) {
    return "duplicate-prevention.merge-identity.v1";
  }

  return "source-observation.field-precedence.v1";
}

function conflictCandidateValuesFor(
  row: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number],
): ConflictResolutionRow["candidateValues"] {
  const primaryValue = row.normalizedFactSummaries[0] ?? row.displayName;
  const competingValue = row.conflictEvidence[0] ?? row.duplicateEvidence[0] ?? row.externalKey;
  const unresolvedPromotionConflict = row.promotionReadiness.blockers.includes("promotion-conflict");
  const values: ConflictResolutionRow["candidateValues"] = [
    {
      source: t("catalog.features.sourceObservations.ui.conflictResolution.source.catalogCandidate"),
      value: primaryValue,
      role: unresolvedPromotionConflict ? "candidate" : "winner",
      evidencePath: "sourceObservationReview.rows.normalizedFactSummaries",
    },
    {
      source: t("catalog.features.sourceObservations.ui.conflictResolution.source.providerEvidence"),
      value: competingValue,
      role: unresolvedPromotionConflict ? "candidate" : "loser",
      evidencePath:
        row.conflictEvidence.length > 0
          ? "sourceObservationReview.rows.conflictEvidence"
          : "sourceObservationReview.rows.duplicateEvidence",
    },
  ];
  if (row.duplicateEvidence[0] && row.duplicateEvidence[0] !== competingValue) {
    return [
      ...values,
      {
        source: t("catalog.features.sourceObservations.ui.conflictResolution.source.duplicateEvidence"),
        value: row.duplicateEvidence[0],
        role: "candidate",
        evidencePath: "sourceObservationReview.rows.duplicateEvidence",
      },
    ];
  }

  return values;
}

function conflictEvidencePathsFor(
  row: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number],
): readonly string[] {
  return [
    "sourceObservationReview.rows.normalizedFactSummaries",
    ...(row.conflictEvidence.length > 0 ? ["sourceObservationReview.rows.conflictEvidence"] : []),
    ...(row.duplicateEvidence.length > 0 ? ["sourceObservationReview.rows.duplicateEvidence"] : []),
    "sourceObservationReview.rows.promotionReadiness",
  ];
}

function conflictDiagnosticsFor(
  row: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number],
  blockers: ReadonlySet<CatalogPrimaryWorkbenchBlockerCategory>,
): readonly string[] {
  const diagnostics = [
    ...row.conflictEvidence,
    ...row.duplicateEvidence,
    ...[...blockers].map((blocker) => getConflictResolutionBlockerDiagnostic(blocker)),
  ].filter(Boolean);

  return diagnostics.length > 0
    ? [...new Set(diagnostics)]
    : [t("catalog.features.sourceObservations.ui.conflictResolution.diagnostic.autoResolved")];
}

function getConflictResolutionBlockerDiagnostic(blocker: CatalogPrimaryWorkbenchBlockerCategory): string {
  if (blocker === "duplicate-conflict") {
    return t("catalog.features.sourceObservations.ui.conflictResolution.diagnostic.duplicateConflict");
  }
  if (blocker === "promotion-conflict") {
    return t("catalog.features.sourceObservations.ui.conflictResolution.diagnostic.promotionConflict");
  }
  if (blocker === "permission-denied") {
    return t("catalog.features.sourceObservations.ui.conflictResolution.diagnostic.permissionDenied");
  }

  return blocker;
}

function conflictResolutionPrecedenceRules(
  rows: readonly ConflictResolutionRow[],
): ConflictResolution["precedenceRules"] {
  const ruleIds = new Set(rows.map((row) => row.precedenceRuleId));
  if (ruleIds.size === 0) {
    return [];
  }

  const rules: ConflictResolution["precedenceRules"] = [
    {
      ruleId: "promotion-command.conflict-blocking.v1",
      label: t("catalog.features.sourceObservations.ui.conflictResolution.rule.promotionBlocking.label"),
      description: t("catalog.features.sourceObservations.ui.conflictResolution.rule.promotionBlocking.description"),
      blockingBehavior: "promotion-blocking",
      sourceAuthority: t("catalog.features.sourceObservations.ui.conflictResolution.rule.catalogAuthority"),
      evidencePaths: ["promotionPreview.blockers", "sourceObservationReview.rows.promotionReadiness"],
    },
    {
      ruleId: "duplicate-prevention.merge-identity.v1",
      label: t("catalog.features.sourceObservations.ui.conflictResolution.rule.duplicate.label"),
      description: t("catalog.features.sourceObservations.ui.conflictResolution.rule.duplicate.description"),
      blockingBehavior: "review-required",
      sourceAuthority: t("catalog.features.sourceObservations.ui.conflictResolution.rule.catalogAuthority"),
      evidencePaths: ["sourceObservationReview.rows.duplicateEvidence"],
    },
    {
      ruleId: "source-observation.field-precedence.v1",
      label: t("catalog.features.sourceObservations.ui.conflictResolution.rule.fieldPrecedence.label"),
      description: t("catalog.features.sourceObservations.ui.conflictResolution.rule.fieldPrecedence.description"),
      blockingBehavior: "auto-resolved",
      sourceAuthority: t("catalog.features.sourceObservations.ui.conflictResolution.rule.catalogAuthority"),
      evidencePaths: ["sourceObservationReview.rows.conflictEvidence"],
    },
  ];

  return rules.filter((rule) => ruleIds.has(rule.ruleId));
}

function conflictResolutionAuditEventsFor(
  overview: CatalogIntegrationControlPlaneOverview | null,
  context: CatalogPrimaryWorkbenchRouteContext,
): ConflictResolution["recentAuditEvents"] {
  return (
    overview?.auditLifecycle.entries
      .filter((entry) => {
        if (context.providerKey && entry.providerKey !== context.providerKey) {
          return false;
        }
        if (context.unitKey && entry.unitKey && entry.unitKey !== context.unitKey) {
          return false;
        }
        return (
          entry.eventName === "import-job-started" ||
          entry.eventName === "reapply-run-executed" ||
          entry.eventName === "profile-activated" ||
          entry.eventName === "profile-section-edited"
        );
      })
      .slice(0, 8)
      .map((entry) => ({
        eventId: entry.eventId,
        occurredAt: entry.occurredAt,
        eventName: entry.eventName,
        providerKey: entry.providerKey,
        unitKey: entry.unitKey as CatalogIntegrationUnitKey | null,
        observationId: null,
        summary: entry.summary,
      })) ?? []
  );
}

function promotionFilterSummaryFor(
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"],
): readonly string[] {
  const activeFilters = sourceObservationReview.filters
    .filter((filterEntry) => filterEntry.value)
    .map((filterEntry) => `${filterEntry.label}: ${filterEntry.value}`);

  return activeFilters.length > 0
    ? activeFilters
    : [t("catalog.features.sourceObservations.ui.primaryWorkbench.command.scope.no.filters")];
}

function promotionPreviewStaleReasonsFor(input: {
  activeProfileVersion: string | null;
  canManage: boolean;
  eligibleCount: number;
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
}): readonly CatalogPrimaryWorkbenchPromotionStaleProtectionKey[] {
  if (!input.routeContext.promotionPreviewId) {
    return [];
  }

  const staleReasons = new Set<CatalogPrimaryWorkbenchPromotionStaleProtectionKey>();
  if (input.sourceObservationReview.freshness !== "fresh") {
    staleReasons.add("observations");
  }
  if (
    input.routeContext.profileVersion &&
    input.activeProfileVersion &&
    input.routeContext.profileVersion !== input.activeProfileVersion
  ) {
    staleReasons.add("profile-version");
  }
  if (input.readinessBlockers.some((blocker) => blocker === "rollout-disabled" || blocker === "kill-switch-active")) {
    staleReasons.add("rollout-state");
  }
  if (!input.canManage || input.readinessBlockers.includes("permission-denied")) {
    staleReasons.add("permissions");
  }
  if (input.eligibleCount <= 0) {
    staleReasons.add("command-inputs");
  }

  return [...staleReasons];
}

function isPromotionExecutionReadinessBlocker(blocker: CatalogPrimaryWorkbenchBlockerCategory): boolean {
  switch (blocker) {
    case "authorization-denied":
    case "deploy-skew-unsupported-version":
    case "kill-switch-active":
    case "missing-active-profile":
    case "permission-denied":
    case "profile-version-missing":
    case "read-model-unavailable":
    case "rollout-disabled":
    case "security-privacy-blocked":
    case "source-projection-stale":
      return true;
    default:
      return false;
  }
}

function sourceObservationReviewRowFor(
  observation: SourceObservationListItem,
  input: { canManage: boolean; routeContext: CatalogPrimaryWorkbenchRouteContext },
): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number] {
  const promotionReadiness = promotionReadinessFor(observation, input.canManage);
  const duplicateEvidence = duplicateEvidenceFor(observation);
  const conflictEvidence = conflictEvidenceFor(observation);
  const detailHref = catalogPrimaryWorkbenchHref(
    {
      ...input.routeContext,
      selectedObservationIds: [observation.observation_id],
      sourceObservationFilters: {
        ...input.routeContext.sourceObservationFilters,
        providerKey: observation.provider_key,
        status: observation.status,
      },
    },
    "source-observation-review",
  );

  return {
    observationId: observation.observation_id,
    providerKey: observation.provider_key,
    externalKey: observation.external_key,
    displayName: observation.normalized.name,
    status: observation.status,
    statusReason: observation.status_reason,
    languageCode: observation.language_code,
    sourceUrl: observation.source_url,
    sourceRecordHash: observation.source_record_hash,
    sourceUpdatedAt: observation.source_updated_at,
    observedAt: observation.observed_at,
    changedAt: observation.updated_at,
    sourceProfileVersion: observation.source_profile_version,
    promotionProfileVersion: observation.promotion_profile_version,
    normalizedFactSummaries: normalizedFactSummariesFor(observation),
    payloadSummary: payloadSummaryFor(observation),
    redactionSummary: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.redaction.summary"),
    duplicateEvidence,
    conflictEvidence,
    promotionReadiness,
    commandPreview: {
      promotionPlanHash: observation.promotion_plan_fingerprint,
      disposition: promotionDispositionFor(promotionReadiness.state),
      confirmationRequired: promotionReadiness.state === "eligible",
    },
    auditTrail: auditTrailFor(observation),
    detailHref,
    actions: rowActionsFor(observation, {
      canManage: input.canManage,
      detailHref,
      promotionReadiness,
    }),
  };
}

function promotionDispositionFor(
  state: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number]["promotionReadiness"]["state"],
): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number]["commandPreview"]["disposition"] {
  if (state === "eligible") {
    return "eligible";
  }
  if (state === "already-promoted" || state === "rejected") {
    return "skipped";
  }

  return "blocked";
}

function reviewFiltersFor(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["filters"] {
  return [
    filter(
      "providerKey",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.provider"),
      routeContext.providerKey,
      Boolean(routeContext.providerKey),
    ),
    filter(
      "unitKey",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.unit"),
      routeContext.unitKey,
      Boolean(routeContext.unitKey),
    ),
    filter(
      "profileVersion",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.profile"),
      routeContext.profileVersion,
      Boolean(routeContext.profileVersion),
    ),
    filter(
      "status",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.status"),
      routeContext.sourceObservationFilters.status ?? null,
      true,
    ),
    filter(
      "language",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.language"),
      routeContext.sourceObservationFilters.language ?? importScopeSegment(routeContext.importScope, 0),
      true,
    ),
    filter(
      "setId",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.set"),
      routeContext.sourceObservationFilters.setId ?? importScopeSegment(routeContext.importScope, 3),
      true,
    ),
    filter(
      "observedAfter",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.observed.after"),
      routeContext.sourceObservationFilters.observedAfter ?? null,
      false,
    ),
    filter(
      "observedBefore",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.observed.before"),
      routeContext.sourceObservationFilters.observedBefore ?? null,
      false,
    ),
  ];
}

function savedReviewFiltersFor(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
  counts: { eligible: number; changed: number; rejected: number },
): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["savedFilters"] {
  const providerFilter: Record<string, string> = {};
  if (routeContext.providerKey) {
    providerFilter.providerKey = routeContext.providerKey;
  }

  return [
    {
      key: "ready-for-promotion",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.saved.ready"),
      filters: { ...providerFilter, status: "changed" },
      count: counts.eligible,
    },
    {
      key: "changed-since-last-pull",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.saved.changed"),
      filters: { ...providerFilter, status: "changed" },
      count: counts.changed,
    },
    {
      key: "rejected-audit",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.saved.rejected"),
      filters: { ...providerFilter, status: "rejected" },
      count: counts.rejected,
    },
  ];
}

function filter(
  key: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["filters"][number]["key"],
  label: string,
  value: string | null,
  serverApplied: boolean,
): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["filters"][number] {
  return { key, label, value, serverApplied };
}

function normalizedFactSummariesFor(observation: SourceObservationListItem): readonly string[] {
  const normalized = observation.normalized;
  const facts = [
    normalized.kind,
    normalized.name,
    normalized.expansionName ?? normalized.setName,
    normalized.cardNumber,
    "providerProductId" in normalized ? normalized.providerProductId : null,
    "productLineName" in normalized ? normalized.productLineName : null,
    "productCategoryName" in normalized ? normalized.productCategoryName : null,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return [...new Set(facts)].slice(0, 5);
}

function payloadSummaryFor(observation: SourceObservationListItem): string {
  const imageCount = observation.normalized.imageUrls.length;
  const externalReferenceCount =
    (observation.normalized.externalCatalogItemReferences?.length ?? 0) +
    (observation.normalized.externalProductReferences?.length ?? 0) +
    (observation.normalized.kind === "provider-product" ? observation.normalized.skuReferences.length : 0);

  return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.payload.summary", {
    kind: observation.normalized.kind,
    imageCount,
    externalReferenceCount,
  });
}

function duplicateEvidenceFor(observation: SourceObservationListItem): readonly string[] {
  const evidence = new Set<string>();
  const mergeIdentity = observation.normalized.mergeIdentity;
  if (mergeIdentity) {
    evidence.add(
      [
        mergeIdentity.tcg,
        mergeIdentity.productLineName,
        mergeIdentity.setName,
        mergeIdentity.printedProductName,
        mergeIdentity.collectorNumber,
        mergeIdentity.languageCode,
        mergeIdentity.productForm,
        mergeIdentity.barcode,
      ]
        .filter(Boolean)
        .join(" / "),
    );
  }
  for (const reference of observation.normalized.externalCatalogItemReferences ?? []) {
    evidence.add(
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.duplicate.catalog.reference", {
        provider: reference.providerKey,
        external: reference.externalKey,
      }),
    );
  }
  for (const reference of observation.normalized.externalProductReferences ?? []) {
    evidence.add(
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.duplicate.product.reference", {
        provider: reference.providerKey,
        external: reference.externalKey,
      }),
    );
  }

  return [...evidence].filter(Boolean).slice(0, 4);
}

function conflictEvidenceFor(observation: SourceObservationListItem): readonly string[] {
  const evidence: string[] = [];
  if (observation.status === "changed") {
    evidence.push(t("catalog.features.sourceObservations.ui.primaryWorkbench.review.conflict.changed"));
  }
  if (observation.status_reason) {
    evidence.push(observation.status_reason);
  }
  if (observation.promoted_catalog_item_id && observation.status !== "promoted") {
    evidence.push(
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.conflict.linked.catalog.item", {
        itemId: observation.promoted_catalog_item_id,
      }),
    );
  }

  return evidence;
}

function promotionReadinessFor(
  observation: SourceObservationListItem,
  canManage: boolean,
): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number]["promotionReadiness"] {
  if (observation.status === "promoted") {
    return { state: "already-promoted", blockers: ["no-promotion-eligible-observations"] };
  }
  if (observation.status === "rejected") {
    return { state: "rejected", blockers: ["no-promotion-eligible-observations"] };
  }
  if (observation.promoted_catalog_item_id && observation.status !== "promoted") {
    return { state: "blocked", blockers: ["promotion-conflict"] };
  }
  if (!canManage) {
    return { state: "blocked", blockers: ["permission-denied"] };
  }

  return { state: "eligible", blockers: [] };
}

function rowActionsFor(
  observation: SourceObservationListItem,
  input: {
    canManage: boolean;
    detailHref: string;
    promotionReadiness: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number]["promotionReadiness"];
  },
): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number]["actions"] {
  const manageState: CatalogPrimaryWorkbenchActionReadModel["state"] = input.canManage ? "available" : "denied";
  const manageBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] = input.canManage
    ? []
    : ["permission-denied"];
  const promotionBlockers = input.promotionReadiness.blockers;
  const promotionState =
    promotionBlockers.length > 0
      ? input.promotionReadiness.state === "blocked"
        ? "blocked"
        : "disabled"
      : manageState;
  const replayBlockers =
    observation.status !== "promoted"
      ? (["no-promotion-eligible-observations"] as readonly CatalogPrimaryWorkbenchBlockerCategory[])
      : hasOriginalSourceProfileEvidence(observation)
        ? manageBlockers
        : (["profile-version-missing"] as readonly CatalogPrimaryWorkbenchBlockerCategory[]);
  const replayState = actionStateForBlockers(replayBlockers, manageState);

  return [
    { key: "view-source-observation", state: "available", blockers: [], href: input.detailHref },
    { key: "preview-promotion", state: promotionState, blockers: promotionBlockers, href: input.detailHref },
    {
      key: "reject-source-observations",
      state: observation.status === "observed" || observation.status === "changed" ? manageState : "disabled",
      blockers:
        observation.status === "observed" || observation.status === "changed"
          ? manageBlockers
          : ["no-promotion-eligible-observations"],
      href: input.detailHref,
    },
    {
      key: "defer-source-observations",
      state: observation.status === "observed" || observation.status === "changed" ? manageState : "disabled",
      blockers:
        observation.status === "observed" || observation.status === "changed"
          ? manageBlockers
          : ["no-promotion-eligible-observations"],
      href: input.detailHref,
    },
    {
      key: "start-reapply",
      state: observation.status === "promoted" ? manageState : "disabled",
      blockers: observation.status === "promoted" ? manageBlockers : ["no-promotion-eligible-observations"],
      href: input.detailHref,
    },
    {
      key: "start-replay",
      state: replayState,
      blockers: replayBlockers,
      href: input.detailHref,
    },
  ];
}

function hasOriginalSourceProfileEvidence(observation: SourceObservationListItem): boolean {
  const sourceProfileKey = observation.source_profile_key.trim();
  const sourceProfileVersion = observation.source_profile_version.trim();
  return sourceProfileKey.length > 0 && sourceProfileVersion.length > 0;
}

function auditTrailFor(observation: SourceObservationListItem): readonly string[] {
  return [
    t("catalog.features.sourceObservations.ui.primaryWorkbench.review.audit.observed", {
      observedAt: observation.observed_at,
    }),
    observation.source_updated_at
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.review.audit.provider.changed", {
          changedAt: observation.source_updated_at,
        })
      : null,
    t("catalog.features.sourceObservations.ui.primaryWorkbench.review.audit.source.profile", {
      profileKey: observation.source_profile_key,
      profileVersion: observation.source_profile_version,
    }),
    observation.promotion_profile_version
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.review.audit.promotion.profile", {
          profileKey:
            observation.promotion_profile_key ??
            t("catalog.features.sourceObservations.ui.primaryWorkbench.review.audit.unknown"),
          profileVersion: observation.promotion_profile_version,
        })
      : null,
    observation.promoted_at
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.review.audit.promoted", {
          promotedAt: observation.promoted_at,
        })
      : null,
  ].filter((value): value is string => Boolean(value));
}

function sourceObservationReviewHrefFor(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
  job: CatalogIntegrationRecentJobReadModel,
): string {
  return catalogPrimaryWorkbenchHref(
    {
      ...routeContext,
      jobId: job.jobId,
      importScope: job.importScope ?? routeContext.importScope,
      sourceObservationFilters: {
        ...routeContext.sourceObservationFilters,
        providerKey: job.providerKey,
      },
    },
    "source-observation-review",
  );
}

function importJobState(
  job: CatalogIntegrationRecentJobReadModel,
): CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"][number]["state"] {
  if (job.operatorStatus === "cancelled") {
    return "cancelled";
  }
  if (job.phase === "completed") {
    return "completed";
  }
  if (job.phase === "failed") {
    return "failed";
  }
  if (job.phase === "enqueued") {
    return "queued";
  }

  return "running";
}

function jobMatchesRouteScope(
  job: CatalogIntegrationRecentJobReadModel,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): boolean {
  return !routeContext.importScope || job.importScope === routeContext.importScope;
}

function jobOccurredAt(job: CatalogIntegrationRecentJobReadModel): string {
  return job.startedAt ?? job.createdAt;
}

function failureGroupsFor(
  job: CatalogIntegrationRecentJobReadModel,
  providerTransport: readonly CatalogPrimaryWorkbenchProviderTransportCategory[],
): CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"][number]["failureGroups"] {
  const groups: {
    key: string;
    label: string;
    count: number;
    severity: "warning" | "error";
  }[] = [];
  if (job.operatorStatus === "cancelled") {
    groups.push({
      key: "durable-job-cancelled",
      label: "durable-job-cancelled",
      count: 1,
      severity: "warning",
    });
  } else if (job.operatorStatus === "failed" || job.phase === "failed") {
    groups.push({
      key: "durable-job-failed",
      label: "durable-job-failed",
      count: Math.max(job.total - job.completed, 1),
      severity: "error",
    });
  }
  if (job.operatorStatus === "partial") {
    groups.push({
      key: "partial-provider-data",
      label: "partial-provider-data",
      count: Math.max(job.total - job.completed, 1),
      severity: "warning",
    });
  }
  if (job.operatorStatus === "stale") {
    groups.push({
      key: "stale-replay",
      label: "stale-replay",
      count: 1,
      severity: "warning",
    });
  }
  for (const category of providerTransport) {
    groups.push({
      key: `provider-transport-${category}`,
      label: `provider-transport-${category}`,
      count: 1,
      severity: category === "degraded-provider" ? "warning" : "error",
    });
  }

  return groups;
}

function progressPercent(completed: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round((completed / total) * 100)));
}

function credentialBlockerFor(
  state: "not-required" | "configured" | "missing" | "invalid" | "expired" | "revoked" | "unknown",
): CatalogPrimaryWorkbenchBlockerCategory {
  if (state === "invalid" || state === "revoked") {
    return "provider-credential-invalid";
  }
  if (state === "expired") {
    return "provider-credential-expired";
  }

  return "provider-credential-missing";
}

function providerTransportCategoryFor(
  code: string,
  message: string | null,
  retryAfterSeconds: number | null,
): CatalogPrimaryWorkbenchProviderTransportCategory {
  const text = `${code} ${message ?? ""}`.toLowerCase();
  if (text.includes("quota")) {
    return "quota";
  }
  if (text.includes("timeout")) {
    return "timeout";
  }
  if (text.includes("pagination") || text.includes("cursor")) {
    return "pagination-failure";
  }
  if (text.includes("partial")) {
    return "partial-data";
  }
  if (text.includes("stale") || text.includes("cache")) {
    return "stale-cache";
  }
  if (text.includes("rate")) {
    return "rate-limit";
  }
  if (retryAfterSeconds !== null || text.includes("throttle")) {
    return "throttle";
  }

  return "degraded-provider";
}

function providerTransportBlockerFor(
  category: CatalogPrimaryWorkbenchProviderTransportCategory,
): CatalogPrimaryWorkbenchBlockerCategory {
  switch (category) {
    case "rate-limit":
      return "provider-transport-rate-limited";
    case "throttle":
      return "provider-transport-throttled";
    case "quota":
      return "provider-transport-quota-exceeded";
    case "timeout":
      return "provider-transport-timeout";
    case "pagination-failure":
      return "provider-transport-pagination-failure";
    case "partial-data":
      return "provider-transport-partial-data";
    case "stale-cache":
      return "provider-transport-stale-cache";
    case "degraded-provider":
      return "provider-transport-degraded";
  }
}

function buildActions(input: {
  canManage: boolean;
  providerSelected: boolean;
  activeProfileReady: boolean;
  eligible: number;
  reviewable: number;
  activeJobCount: number;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  activationBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  cloneProfileBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  lifecycleOperations: readonly LifecycleOperationRow[];
  promotionBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
}): readonly CatalogPrimaryWorkbenchActionReadModel[] {
  const manageState = input.canManage ? "available" : "denied";
  const importBlockers = input.canManage
    ? input.providerSelected && input.activeProfileReady
      ? [
          ...input.blockers,
          ...(input.activeJobCount > 0 ? (["active-job-conflict"] as const) : []),
          ...(input.activeJobCount > 1 ? (["concurrent-job"] as const) : []),
        ]
      : ["missing-active-profile" as const]
    : ["permission-denied" as const];
  const previewBlockers =
    input.eligible > 0
      ? []
      : (["no-promotion-eligible-observations"] as readonly CatalogPrimaryWorkbenchBlockerCategory[]);
  const promotionBlockers = input.promotionBlockers;
  const promotionState = actionStateForBlockers(promotionBlockers, manageState);
  const reviewDecisionBlockers =
    input.reviewable > 0 ? [] : (["selection-empty"] as readonly CatalogPrimaryWorkbenchBlockerCategory[]);
  const reviewDecisionState = actionStateForBlockers(reviewDecisionBlockers, manageState);
  const reapplyBlockers = input.activeProfileReady
    ? []
    : (["profile-version-missing"] as readonly CatalogPrimaryWorkbenchBlockerCategory[]);
  const reapplyState = actionStateForBlockers(reapplyBlockers, manageState);
  const replayBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] = [];
  const replayState = actionStateForBlockers(replayBlockers, manageState);
  const cloneProfileState = actionStateForBlockers(input.cloneProfileBlockers, manageState);
  const activationState = actionStateForBlockers(input.activationBlockers, manageState);
  const lifecycleOperationByCommand = new Map(
    input.lifecycleOperations.map((operation) => [operation.commandKey, operation]),
  );

  return [
    {
      key: "select-provider-scope",
      state: "available",
      blockers: [],
      copyKey: null,
    },
    {
      key: "start-provider-import",
      state: importBlockers.length > 0 ? "blocked" : manageState,
      blockers: importBlockers,
      copyKey: importBlockers.length > 0 ? "catalog.primary.import.blocked" : null,
    },
    {
      key: "select-source-observations",
      state: "available",
      blockers: [],
      copyKey: null,
    },
    {
      key: "clone-provider-profile",
      state: cloneProfileState,
      blockers: input.cloneProfileBlockers,
      copyKey:
        input.cloneProfileBlockers.length > 0
          ? input.cloneProfileBlockers.includes("permission-denied")
            ? "catalog.primary.import.denied"
            : input.cloneProfileBlockers.includes("profile-version-missing")
              ? "catalog.primary.reapply.originalProfileMissing"
              : "catalog.primary.import.blocked"
          : null,
    },
    {
      key: "activate-provider-profile",
      state: activationState,
      blockers: input.activationBlockers,
      copyKey: input.activationBlockers.length > 0 ? "catalog.primary.import.blocked" : null,
    },
    lifecycleAction("rollback-provider-profile", lifecycleOperationByCommand, manageState),
    lifecycleAction("deprecate-provider-profile", lifecycleOperationByCommand, manageState),
    lifecycleAction("retire-provider-profile", lifecycleOperationByCommand, manageState),
    {
      key: "preview-promotion",
      state: previewBlockers.length > 0 ? "disabled" : manageState,
      blockers: previewBlockers,
      copyKey: previewBlockers.length > 0 ? "catalog.primary.review.empty" : null,
    },
    {
      key: "execute-promotion",
      state: promotionState,
      blockers: promotionBlockers,
      copyKey: promotionBlockers.length > 0 ? "catalog.primary.promotion.previewRequired" : null,
    },
    {
      key: "reject-source-observations",
      state: reviewDecisionState,
      blockers: reviewDecisionBlockers,
      copyKey: reviewDecisionBlockers.length > 0 ? "catalog.primary.review.empty" : null,
    },
    {
      key: "defer-source-observations",
      state: reviewDecisionState,
      blockers: reviewDecisionBlockers,
      copyKey: reviewDecisionBlockers.length > 0 ? "catalog.primary.review.empty" : null,
    },
    {
      key: "start-reapply",
      state: reapplyState,
      blockers: reapplyBlockers,
      copyKey: reapplyBlockers.length > 0 ? "catalog.primary.reapply.originalProfileMissing" : null,
    },
    {
      key: "start-replay",
      state: replayState,
      blockers: replayBlockers,
      copyKey: null,
    },
  ];
}

function lifecycleAction(
  key: Extract<
    CatalogPrimaryWorkbenchActionReadModel["key"],
    "rollback-provider-profile" | "deprecate-provider-profile" | "retire-provider-profile"
  >,
  operations: ReadonlyMap<LifecycleOperationRow["commandKey"], LifecycleOperationRow>,
  manageState: CatalogPrimaryWorkbenchActionReadModel["state"],
): CatalogPrimaryWorkbenchActionReadModel {
  const operation = operations.get(key);
  const blockers = operation?.blockers ?? (["profile-version-missing"] as const);

  return {
    key,
    state: operation?.state ?? actionStateForBlockers(blockers, manageState),
    blockers,
    copyKey: blockers.length > 0 ? "catalog.primary.reapply.originalProfileMissing" : null,
  };
}

function actionStateForBlockers(
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
  stateWhenUnblocked: CatalogPrimaryWorkbenchActionReadModel["state"],
): CatalogPrimaryWorkbenchActionReadModel["state"] {
  if (blockers.length === 0) {
    return stateWhenUnblocked;
  }
  if (blockers.includes("permission-denied") || blockers.includes("authorization-denied")) {
    return "denied";
  }
  if (blockers.every((blocker) => blocker === "selection-empty" || blocker === "no-promotion-eligible-observations")) {
    return "disabled";
  }
  if (blockers.includes("security-privacy-blocked")) {
    return "unsafe";
  }

  return "blocked";
}

function providerScopeProviders(
  input: CatalogPrimaryWorkbenchInput,
  selectedProviderKey: string | null,
  selectedProfile: CatalogProviderProfileVersionReview | null,
): CatalogPrimaryWorkbenchReadModel["providerScope"]["providers"] {
  const providerKeys = new Set<string>();
  for (const scope of input.scopes.items) {
    providerKeys.add(scope.provider_key);
  }
  for (const profile of input.profileReviews.items) {
    providerKeys.add(profile.providerKey);
  }
  if (selectedProviderKey) {
    providerKeys.add(selectedProviderKey);
  }

  return [...providerKeys].sort().map((providerKey) => {
    const profile =
      providerKey === selectedProviderKey
        ? selectedProfile
        : findActiveProfile(input.profileReviews.items, providerKey);
    const providerScopes = input.scopes.items.filter((scope) => scope.provider_key === providerKey);
    const unitKey = inferUnitKey(input, providerKey, profile);

    return {
      providerKey,
      displayName: profile?.displayName ?? providerKey,
      units: [
        {
          unitKey:
            unitKey ??
            defineCatalogIntegrationUnitKey({
              providerKey,
              productDomain: "catalog",
              productForm: "source-observation",
              ingestionPurpose: "import",
            }),
          productDomain: profile?.supportedScopes[0]?.split("/")[0] ?? "catalog",
          productForm: profile?.supportedScopes[0]?.split("/")[1] ?? "source-observation",
          importScopes: providerScopes.map((scope) =>
            [scope.language_code, scope.product_line_id, scope.series_id, scope.expansion_id].filter(Boolean).join(":"),
          ),
          activeProfile: profilePointerForProfile(profile),
        },
      ],
    };
  });
}

function profilePointerForProfile(
  profile: CatalogProviderProfileVersionReview | null,
): CatalogPrimaryWorkbenchReadModel["providerScope"]["providers"][number]["units"][number]["activeProfile"] {
  if (!profile) {
    return null;
  }

  return {
    schemaVersion: "catalog-provider-profile-version-v1",
    compatibilityPolicy: "provider-profile-version",
    providerKey: profile.providerKey,
    profileKey: profile.profileKey,
    profileVersion: profile.profileVersion,
    lifecycle: profile.lifecycle,
    active: profile.active,
    connectorKind: profile.connectorKind,
    connectorSourceVersion: null,
    sourceMappingFingerprint: null,
  };
}

function normalizeUnitSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "catalog"
  );
}

function scopeKey(scope: SourceObservationIntegrationScope): string {
  return [scope.language_code, scope.product_line_id, scope.series_id, scope.expansion_id].filter(Boolean).join(":");
}

function sum<T>(items: readonly T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0);
}

function importScopeSegment(importScope: string | null, index: number): string | null {
  return importScope?.split(":")[index] || null;
}

function setQueryParam(params: URLSearchParams, key: string, value: string | null | undefined): void {
  if (value) {
    params.set(key, value);
  }
}
