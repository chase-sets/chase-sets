import { t } from "@chase-sets/localization";
import { TaskSummary } from "@chase-sets/design-system";
import type { CatalogProviderProfileEditableSection } from "../../contracts";
import { profileSectionRegistryItems } from "./registry";
import type { CatalogProviderProfileSectionArea } from "./types";

export function ProfileSectionRegistrySummary({
  editableSections,
}: Readonly<{ editableSections: readonly CatalogProviderProfileEditableSection[] }>) {
  const items = profileSectionRegistryItems(editableSections).map(({ module, editableSection }) => ({
    label: module.label,
    value: editableSection
      ? t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.section.registry.editable", {
          area: areaLabel(module.area),
        })
      : t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.section.registry.framework.ready", {
          area: areaLabel(module.area),
        }),
  }));

  return (
    <TaskSummary
      title={t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.section.registry")}
      items={items}
    />
  );
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
