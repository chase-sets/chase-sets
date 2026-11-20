import { KeyValueList } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { stateLabel } from "../import-to-promotion/workbench-formatting";

export function IntegrationUnitHealth({
  unit,
}: Readonly<{
  unit: CatalogPrimaryWorkbenchReadModel["healthTriage"]["units"][number] | undefined;
}>) {
  if (!unit)
    return (
      <KeyValueList
        density="compact"
        items={[
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.status"),
            value: stateLabel("unavailable"),
          },
        ]}
      />
    );
  return (
    <KeyValueList
      density="compact"
      variant="surface"
      items={[
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.unit"),
          value: `${unit.displayName} / ${unit.unitKey}`,
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.provider"),
          value: unit.providerKey,
        },
        {
          key: t("catalog.features.sourceObservations.ui.healthFacts.product"),
          value: `${unit.productDomain}/${unit.productForm}`,
        },
        {
          key: t("catalog.features.sourceObservations.ui.healthFacts.purpose"),
          value: unit.ingestionPurpose ?? stateLabel("unavailable"),
        },
        {
          key: t("catalog.features.sourceObservations.ui.healthFacts.profileVersion"),
          value: unit.profileVersion ?? stateLabel("unavailable"),
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.status"),
          value: stateLabel(unit.status),
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.catalog.semantic"),
          value: stateLabel(unit.semanticReadiness),
        },
        {
          key: t("catalog.features.sourceObservations.ui.healthFacts.credential"),
          value: `${stateLabel(unit.credentialReadiness)} / ${unit.credentialReadinessState}`,
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.provider.transport"),
          value: stateLabel(unit.transportReadiness),
        },
        {
          key: t("catalog.features.sourceObservations.ui.healthFacts.fixture"),
          value: stateLabel(unit.fixtureValidationStatus),
        },
        { key: t("catalog.features.sourceObservations.ui.healthFacts.dryRun"), value: stateLabel(unit.dryRunStatus) },
        {
          key: t("catalog.features.sourceObservations.ui.healthFacts.observations"),
          value: String(unit.observationFacts),
        },
        {
          key: t("catalog.features.sourceObservations.ui.healthFacts.diagnosticCounts"),
          value: `${unit.diagnosticCounts.info} / ${unit.diagnosticCounts.warning} / ${unit.diagnosticCounts.error}`,
        },
        {
          key: t("catalog.features.sourceObservations.ui.healthFacts.diagnosticCodes"),
          value: unit.diagnosticCodes.join(", ") || t("catalog.features.sourceObservations.ui.primaryWorkbench.none"),
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.diagnostics"),
          value: unit.latestDiagnosticText ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.none"),
        },
        {
          key: t("catalog.features.sourceObservations.ui.healthFacts.primaryAction"),
          value: {
            "pull-provider-data": t(
              "catalog.features.sourceObservations.ui.primaryWorkbench.health.primaryAction.pullProviderData",
            ),
            "review-source-observations": t(
              "catalog.features.sourceObservations.ui.primaryWorkbench.health.primaryAction.reviewSourceObservations",
            ),
            "observation.promote": t(
              "catalog.features.sourceObservations.ui.primaryWorkbench.health.primaryAction.previewPromotion",
            ),
          }[unit.affectedPrimaryAction],
        },
        {
          key: t("catalog.features.sourceObservations.ui.governanceControls.table.metric"),
          value: unit.ownerMetricKey,
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.next.action"),
          value: unit.nextAction,
        },
      ]}
    />
  );
}
