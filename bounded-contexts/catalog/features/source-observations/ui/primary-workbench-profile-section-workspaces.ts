import { t } from "@chase-sets/localization";
import {
  catalogProviderProfileEditableSectionMetadata,
  type CatalogProviderProfileEditableSectionKey,
} from "../api/provider-profile-section-registry";
import type {
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import type {
  CatalogIntegrationControlPlaneOverview,
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationScope,
} from "./contracts";
import { actionStateForBlockers } from "./primary-workbench-read-model-support";
import { profileSectionFields } from "./primary-workbench-profile-section-fields";
import { profileSectionOptionQueries } from "./primary-workbench-profile-option-queries";
import { profileSectionImportScopeControls } from "./primary-workbench-profile-import-scope-controls";
import { profileSectionMappingRows } from "./primary-workbench-profile-mapping-rows";

export type ProfileSectionWorkspace = CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["sectionWorkspaces"][number];

export function profileSectionGroups(): CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["sectionGroups"] {
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

export function profileSectionWorkspacesFor(input: {
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
      commandKey: "provider-profile.edit-section",
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

export function profileSectionDescription(section: CatalogProviderProfileEditableSectionKey): string {
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
      return "Removal plan evidence for profiles that will be retired.";
    case "migration-evidence":
      return "Evidence proving profile changes were validated before activation.";
  }
}

export function profileSectionDomainConcept(section: CatalogProviderProfileEditableSectionKey): string {
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
    url.searchParams.get("commandIntent") !== "provider-profile.edit-section" ||
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

export function profileDiagnosticsBySection(
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

export function sectionForDiagnosticPath(path: string): CatalogProviderProfileEditableSectionKey {
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
