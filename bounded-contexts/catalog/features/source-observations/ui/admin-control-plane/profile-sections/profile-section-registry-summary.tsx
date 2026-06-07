import { t } from "@chase-sets/localization";
import { Button, Inline, Stack, StatusPill, TaskSummary } from "@chase-sets/design-system";
import type { CatalogProviderProfileEditableSection } from "../../contracts";
import { profileSectionRegistryItems } from "./registry";
import type {
  CatalogProviderProfileSectionArea,
  CatalogProviderProfileSectionSaveState,
  CatalogProviderProfileSectionSaveStatus,
} from "./types";

export function ProfileSectionRegistrySummary({
  editableSections,
  sectionStates,
}: Readonly<{
  editableSections: readonly CatalogProviderProfileEditableSection[];
  sectionStates?: ReadonlyMap<string, CatalogProviderProfileSectionSaveState>;
}>) {
  const items = profileSectionRegistryItems(editableSections).map(({ module, editableSection }) => ({
    label: module.label,
    value: sectionStates?.get(module.section) ? (
      <ProfileSectionStateValue
        state={sectionStates.get(module.section)!}
        fallbackArea={areaLabel(module.area)}
        editable={Boolean(editableSection)}
      />
    ) : editableSection ? (
      t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.section.registry.editable", {
        area: areaLabel(module.area),
      })
    ) : (
      t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.section.registry.framework.ready", {
        area: areaLabel(module.area),
      })
    ),
  }));

  return (
    <TaskSummary
      title={t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.section.registry")}
      items={items}
    />
  );
}

function ProfileSectionStateValue({
  state,
  fallbackArea,
  editable,
}: Readonly<{ state: CatalogProviderProfileSectionSaveState; fallbackArea: string; editable: boolean }>) {
  const fallbackText = editable
    ? t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.section.registry.editable", {
        area: fallbackArea,
      })
    : t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.section.registry.framework.ready", {
        area: fallbackArea,
      });
  const needsOperatorAttention = state.dirty || state.stale || state.status === "blocked" || state.status === "error";

  return (
    <Stack gap={2}>
      <Inline gap={2} align="center">
        <StatusPill tone={sectionStatusTone(state.status)}>{sectionStatusLabel(state.status)}</StatusPill>
        <span>{needsOperatorAttention ? (state.blockedReason ?? fallbackText) : fallbackText}</span>
      </Inline>
      {state.error ? <p className="m-0 text-sm text-danger">{state.error}</p> : null}
      {state.canSave && state.onSave ? (
        <Inline gap={2}>
          <Button size="sm" tone="secondary" leadingIcon="check" onClick={state.onSave} loading={state.saving}>
            {t("catalog.features.sourceObservations.ui.integrationManagementPage.save.section")}
          </Button>
        </Inline>
      ) : null}
    </Stack>
  );
}

function sectionStatusLabel(status: CatalogProviderProfileSectionSaveStatus): string {
  switch (status) {
    case "clean":
      return "Clean";
    case "dirty":
      return "Dirty";
    case "blocked":
      return "Blocked";
    case "saving":
      return "Saving";
    case "saved":
      return "Saved";
    case "error":
      return "Error";
    case "stale":
      return "Stale";
  }
}

function sectionStatusTone(status: CatalogProviderProfileSectionSaveStatus) {
  switch (status) {
    case "clean":
      return "neutral";
    case "dirty":
      return "warning";
    case "blocked":
    case "stale":
    case "error":
      return "danger";
    case "saving":
      return "info";
    case "saved":
      return "success";
  }
}

function areaLabel(area: CatalogProviderProfileSectionArea): string {
  switch (area) {
    case "identity":
      return t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.section.area.identity");
    case "transport":
      return t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.section.area.transport");
    case "mapping":
      return t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.section.area.mapping");
    case "governance":
      return t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.section.area.governance");
  }
}
