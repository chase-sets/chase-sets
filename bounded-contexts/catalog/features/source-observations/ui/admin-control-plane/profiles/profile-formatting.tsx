import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";

export type ProfileAuthoringReadModel = CatalogPrimaryWorkbenchReadModel["profileAuthoring"];
export type ProfileOverview = NonNullable<ProfileAuthoringReadModel["selectedProfile"]>;
export type ProfileOption = ProfileAuthoringReadModel["availableProfiles"][number];
export type ProfileSectionWorkspace = ProfileAuthoringReadModel["sectionWorkspaces"][number];
export type BadgeTone = "success" | "warning" | "danger" | "neutral" | "info" | "accent";

export function keyValue(key: string, value: string) {
  return { key, value };
}

export function joinOrFallback(values: readonly string[]): string {
  return values.join(", ") || t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.not.reported");
}

export function profileBannerTitle(authoring: ProfileAuthoringReadModel): string {
  if (authoring.status === "stale-selection") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.banner.stale.title");
  }
  if (authoring.status === "missing-profile") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.banner.missing.title");
  }

  return t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.banner.ready.title");
}

export function profileBannerDescription(authoring: ProfileAuthoringReadModel): string {
  if (authoring.status === "stale-selection") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.banner.stale.description");
  }
  if (authoring.status === "missing-profile") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.banner.missing.description");
  }

  return t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.banner.ready.description");
}

export function authoringTone(status: ProfileAuthoringReadModel["status"]) {
  if (status === "ready") {
    return "success";
  }

  return "warning";
}

export function optionQueryHealthTone(
  status: ProfileSectionWorkspace["optionQueries"][number]["cacheState"]["status"],
): BadgeTone {
  if (status === "ready") {
    return "success";
  }
  if (status === "degraded") {
    return "warning";
  }
  if (status === "blocked") {
    return "danger";
  }

  return "neutral";
}

export function importScopeTone(state: ProfileSectionWorkspace["importScopeControls"][number]["state"]): BadgeTone {
  if (state === "selected") {
    return "success";
  }
  if (state === "available") {
    return "info";
  }

  return "warning";
}

export function mappingAffordanceLabels(row: ProfileSectionWorkspace["mappingRows"][number]): readonly string[] {
  return [
    row.previewAvailable
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.affordance.preview")
      : null,
    row.affordances.duplicate
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.affordance.duplicate")
      : null,
    row.affordances.reorder
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.affordance.reorder")
      : null,
    row.affordances.remove
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.affordance.remove")
      : null,
    row.affordances.inlineDiagnostics
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.affordance.inlineDiagnostics")
      : null,
    row.affordances.longPathSafe
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.affordance.longPaths")
      : null,
  ].filter((label): label is string => Boolean(label));
}

export function lifecycleTone(lifecycle: string) {
  switch (lifecycle.toLowerCase()) {
    case "active":
      return "success";
    case "draft":
    case "test":
      return "info";
    case "deprecated":
      return "warning";
    case "retired":
      return "danger";
    default:
      return "neutral";
  }
}

export function sectionStatusTone(status: ProfileSectionWorkspace["status"]) {
  switch (status) {
    case "valid":
      return "success";
    case "warning":
      return "warning";
    case "error":
    case "blocked":
      return "danger";
  }
}

export function restrictionTone(severity: "info" | "warning" | "blocked") {
  if (severity === "blocked") {
    return "danger";
  }
  if (severity === "warning") {
    return "warning";
  }

  return "info";
}
