import { t } from "@chase-sets/localization";
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
import { catalogPrimaryWorkbenchReturnPath } from "./primary-workbench-route-context";
import { catalogProviderDetailHref } from "./admin-control-plane/provider-detail/provider-detail-links";
import { actionStateForBlockers } from "./primary-workbench-read-model-support";
import { profileSectionGroups, profileSectionWorkspacesFor } from "./primary-workbench-profile-section-workspaces";

export function profileAuthoringFor(input: {
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
  const activeProfile = input.activeProfile ? profileOptionFor(input.activeProfile) : null;
  const availableProfiles = providerProfiles.map((profile) => profileOptionFor(profile));
  const cloneBlockers = cloneProfileBlockersFor({
    activeJobCount: input.activeJobCount,
    canManage: input.canManage,
    status,
  });
  const cloneState = actionStateForBlockers(cloneBlockers, "available");
  const submitHref = catalogProviderDetailHref(input.providerKey ?? input.selectedProfile?.providerKey ?? null);
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
      commandKey: "provider-profile.clone",
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
): CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["availableProfiles"][number] {
  return {
    providerKey: profile.providerKey,
    profileKey: profile.profileKey,
    profileVersion: profile.profileVersion,
    displayName: profile.displayName,
    lifecycle: profile.lifecycle,
    active: profile.active,
    status: profile.status,
    href: catalogProviderDetailHref(profile.providerKey, { profileVersion: profile.profileVersion }),
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
