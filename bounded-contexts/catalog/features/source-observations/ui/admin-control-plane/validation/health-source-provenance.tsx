import { KeyValueList, WorkbenchStack, WorkbenchText } from "@chase-sets/design-system";
import { formatDateTime, t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { stateLabel } from "../import-to-promotion/workbench-formatting";

export function HealthSourceProvenance({
  health,
  queryKeys,
}: Readonly<{
  health: CatalogPrimaryWorkbenchReadModel["healthTriage"];
  queryKeys: readonly string[];
}>) {
  return (
    <WorkbenchStack data-catalog-health-provenance="true">
      <WorkbenchText>{t("catalog.features.sourceObservations.ui.healthFacts.source")}</WorkbenchText>
      <KeyValueList
        density="compact"
        items={[
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.status"),
            value: stateLabel(health.status),
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.freshness"),
            value: stateLabel(health.freshness),
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.generated"),
            value: formatDateTime(health.generatedAt),
          },
          ...health.readModels
            .filter((row) => queryKeys.includes(row.queryKey))
            .map((row) => ({
              key: row.queryKey,
              value: (
                <WorkbenchStack gap="sm">
                  <WorkbenchText>{stateLabel(row.freshness)}</WorkbenchText>
                  <WorkbenchText>
                    {row.generatedAt ? formatDateTime(row.generatedAt) : stateLabel("unavailable")}
                  </WorkbenchText>
                  <WorkbenchText>{row.statusMessage}</WorkbenchText>
                  <WorkbenchText size="xs">{row.ownerMetricKey}</WorkbenchText>
                </WorkbenchStack>
              ),
            })),
        ]}
      />
    </WorkbenchStack>
  );
}
