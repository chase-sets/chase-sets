import type { ListResponse } from "@chase-sets/http/responses";
import { t } from "@chase-sets/localization";
import {
  catalogPrimaryWorkbenchContractVersion,
  catalogPrimaryWorkbenchDeploySkewPolicies,
  catalogPrimaryWorkbenchInstrumentationDimensions,
  validateCatalogPrimaryWorkbenchReadModelContract,
  type CatalogPrimaryWorkbenchActionReadModel,
  type CatalogPrimaryWorkbenchBlockerCategory,
  type CatalogPrimaryWorkbenchHealthTriageReadModel,
  type CatalogPrimaryWorkbenchProviderTransportCategory,
  type CatalogPrimaryWorkbenchPromotionStaleProtectionKey,
  type CatalogPrimaryWorkbenchReadModel,
  type CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import { defineCatalogIntegrationUnitKey, type CatalogIntegrationUnitKey } from "../api/integration-unit";
import {
  catalogProviderProfileEditableSectionMetadata,
  type CatalogProviderProfileEditableSectionKey,
} from "../api/provider-profile-section-registry";
import type {
  CatalogIntegrationControlPlaneOverview,
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
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  reviewObservations?: ListResponse<SourceObservationListItem> | null;
  reviewPagination?: Readonly<{ limit: number; offset: number }>;
  canManageCatalog: boolean;
}>;

type CatalogIntegrationRecentJobReadModel =
  CatalogIntegrationControlPlaneOverview["unitActivity"]["units"][number]["recentJobs"][number];
type ProfileSectionField =
  CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["sectionWorkspaces"][number]["fields"][number];

const defaultReviewPageSize = 25;

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
  const profileAuthoring = profileAuthoringFor({
    activeJobCount,
    activeProfile,
    canManage,
    generatedAt,
    profiles: input.profileReviews.items,
    providerKey,
    requestedProfileVersion: parsedContext.profileVersion,
    requestUrl: input.requestUrl,
    routeContext,
    selectedProfile,
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
  const actions = buildActions({
    canManage,
    providerSelected: Boolean(providerKey && unitKey && importScope),
    activeProfileReady: Boolean(activeProfile),
    eligible: promotionPreview.outcomeCounts.eligible,
    reviewable: sourceObservationReview.counts.observed + sourceObservationReview.counts.changed,
    activeJobCount,
    blockers: readinessBlockers,
    cloneProfileBlockers: profileAuthoring.cloneDraft.blockers,
    promotionBlockers: promotionPreview.blockers,
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
    healthTriage: healthTriageFor({
      overview: input.controlPlaneOverview,
      routeContext,
      importJobs: importJobRows,
    }),
    profileAuthoring,
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
    promotionPreview,
    promotionResult: null,
    actions,
    deploySkew: catalogPrimaryWorkbenchDeploySkewPolicies[0],
    securityPrivacy: {
      redactionApplied: true,
      governedDataClasses: ["provider payload", "operator identity", "external source URLs"],
      unsafeEvidenceBlocked: false,
      missingSecurityFieldsBlocker: "security-privacy-blocked",
    },
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
  generatedAt: string;
  profiles: readonly CatalogProviderProfileVersionReview[];
  providerKey: string | null;
  requestedProfileVersion: string | null;
  requestUrl: string | URL;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  selectedProfile: CatalogProviderProfileVersionReview | null;
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
  requestUrl: string | URL;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  status: CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["status"];
  profile: CatalogProviderProfileVersionReview;
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
  return (
    sourceProfileKey.length > 0 &&
    sourceProfileVersion.length > 0 &&
    sourceProfileKey.toLowerCase() !== "legacy" &&
    sourceProfileVersion.toLowerCase() !== "legacy"
  );
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
  cloneProfileBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
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
