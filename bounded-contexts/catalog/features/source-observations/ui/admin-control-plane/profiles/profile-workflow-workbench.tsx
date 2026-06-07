import { t } from "@chase-sets/localization";
import { Button, Inline, OperationalStatusBanner, Stack, TaskSummary } from "@chase-sets/design-system";
import type { CatalogProviderProfileAuthoringModel, CatalogProviderProfileVersionReview } from "../../contracts";
import { type CatalogIntegrationModuleArea, moduleAreaLabel } from "../registry";

export type CatalogIntegrationAreaWorkbenchProps = Readonly<{
  area: CatalogIntegrationModuleArea;
  selectedProfile: CatalogProviderProfileVersionReview | null;
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  loading: boolean;
  error: string | null;
  canManageCatalog: boolean;
  onEditProfile: (profile: CatalogProviderProfileVersionReview) => void;
  onDryRun: (profile: CatalogProviderProfileVersionReview) => void;
  onCompare: (profile: CatalogProviderProfileVersionReview) => void;
  onMigrationEvidence: (profile: CatalogProviderProfileVersionReview) => void;
  onActivate: (profile: CatalogProviderProfileVersionReview) => void;
  onImport: () => void;
  onReapply: () => void;
}>;

export function CatalogIntegrationAreaWorkbench({
  area,
  selectedProfile,
  authoringModel,
  loading,
  error,
  canManageCatalog,
  onEditProfile,
  onDryRun,
  onCompare,
  onMigrationEvidence,
  onActivate,
  onImport,
  onReapply,
}: CatalogIntegrationAreaWorkbenchProps) {
  if (area === "health") {
    return null;
  }

  if (!selectedProfile) {
    return (
      <OperationalStatusBanner
        tone="warning"
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.value.workbench", {
          value: String(moduleAreaLabel(area)),
        })}
        description={t(
          "catalog.features.sourceObservations.ui.integrationManagementPage.select.a.provider.profile.version.to.use.this",
        )}
      />
    );
  }

  const readiness = authoringModel?.activationReadiness;
  const areaItems =
    area === "authoring"
      ? [
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.editable.sections"),
            value: authoringModel ? String(authoringModel.editableSections.length) : "Loading",
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.fixture.flows"),
            value: selectedProfile.fixtures.coveredFlows.join(", ") || "None",
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.mapping.output"),
            value: selectedProfile.mappingOutputKind,
          },
        ]
      : area === "validation"
        ? [
            {
              label: t("catalog.features.sourceObservations.ui.integrationManagementPage.validation"),
              value: selectedProfile.validation.status,
            },
            {
              label: t("catalog.features.sourceObservations.ui.integrationManagementPage.readiness"),
              value: readiness?.status ?? "Loading",
            },
            {
              label: t("catalog.features.sourceObservations.ui.integrationManagementPage.readiness.checks"),
              value: readiness ? String(readiness.checks.length) : "Loading",
            },
          ]
        : area === "operations"
          ? [
              {
                label: t("catalog.features.sourceObservations.ui.integrationManagementPage.provider"),
                value: selectedProfile.providerKey,
              },
              {
                label: t("catalog.features.sourceObservations.ui.integrationManagementPage.capabilities"),
                value: selectedProfile.capabilities.join(", ") || "None",
              },
              {
                label: t("catalog.features.sourceObservations.ui.integrationManagementPage.supported.scopes"),
                value: selectedProfile.supportedScopes.join(", ") || "None",
              },
            ]
          : [
              {
                label: t("catalog.features.sourceObservations.ui.integrationManagementPage.lifecycle"),
                value: selectedProfile.lifecycle,
              },
              {
                label: t("catalog.features.sourceObservations.ui.integrationManagementPage.reference.count"),
                value: String(selectedProfile.referenceCount),
              },
              {
                label: t("catalog.features.sourceObservations.ui.integrationManagementPage.migration.evidence"),
                value: selectedProfile.migrationEvidence ? "Recorded" : "Not recorded",
              },
            ];

  return (
    <Stack gap={3}>
      <TaskSummary
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.value.workbench.2", {
          value: String(moduleAreaLabel(area)),
        })}
        items={areaItems}
      />
      {loading ? (
        <p className="text-sm text-secondary">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.loading.selected.profile.context")}
        </p>
      ) : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Inline gap={2}>
        {area === "authoring" ? (
          <Button
            size="sm"
            leadingIcon="settings"
            disabled={!canManageCatalog}
            onClick={() => onEditProfile(selectedProfile)}
          >
            {t("catalog.features.sourceObservations.ui.integrationManagementPage.edit.selected.profile")}
          </Button>
        ) : null}
        {area === "validation" ? (
          <>
            <Button size="sm" tone="secondary" leadingIcon="play" onClick={() => onDryRun(selectedProfile)}>
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.dry.run.selected.profile")}
            </Button>
            <Button size="sm" tone="secondary" leadingIcon="search" onClick={() => onCompare(selectedProfile)}>
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.compare.active")}
            </Button>
          </>
        ) : null}
        {area === "operations" ? (
          <>
            <Button size="sm" leadingIcon="plus" disabled={!canManageCatalog} onClick={onImport}>
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.pull.provider.data")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="badgeCheck"
              disabled={!canManageCatalog}
              onClick={onReapply}
            >
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.reapply.promoted")}
            </Button>
          </>
        ) : null}
        {area === "audit" ? (
          <>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="badgeCheck"
              disabled={!canManageCatalog}
              onClick={() => onMigrationEvidence(selectedProfile)}
            >
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.evidence")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="badgeCheck"
              disabled={!canManageCatalog}
              onClick={() => onActivate(selectedProfile)}
            >
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.activate")}
            </Button>
          </>
        ) : null}
      </Inline>
    </Stack>
  );
}
