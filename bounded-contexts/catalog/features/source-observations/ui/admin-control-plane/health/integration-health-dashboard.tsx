import { t } from "@chase-sets/localization";
import {
  Button,
  DataTable,
  Inline,
  OperationalStatusBanner,
  Select,
  Stack,
  StatusPill,
  TaskSummary,
  type DataColumn,
  type SelectItem,
} from "@chase-sets/design-system";
import type {
  CatalogIntegrationControlPlaneReadiness,
  CatalogIntegrationControlPlaneUnitReadiness,
  CatalogProviderProfileVersionReview,
} from "../../contracts";

export type CatalogIntegrationProfileHealthPanelProps = Readonly<{
  profiles: CatalogProviderProfileVersionReview[];
  columns: DataColumn<CatalogProviderProfileVersionReview>[];
  profileWorkspaceItems: SelectItem[];
  selectedProfileId: string;
  emptyProfileWorkspaceValue: string;
  onSelectedProfileChange: (value: string) => void;
  onRefresh: () => void;
  getProfileRowId: (profile: CatalogProviderProfileVersionReview) => string;
  controlPlaneReadiness: CatalogIntegrationControlPlaneReadiness | null;
  controlPlaneLoading: boolean;
  controlPlaneError: string | null;
  onRefreshControlPlane: () => void;
}>;

export function CatalogIntegrationProfileHealthPanel({
  profiles,
  columns,
  profileWorkspaceItems,
  selectedProfileId,
  emptyProfileWorkspaceValue,
  onSelectedProfileChange,
  onRefresh,
  getProfileRowId,
  controlPlaneReadiness,
  controlPlaneLoading,
  controlPlaneError,
  onRefreshControlPlane,
}: CatalogIntegrationProfileHealthPanelProps) {
  return (
    <Stack gap={3}>
      <CatalogIntegrationControlPlaneReadinessPanel
        readiness={controlPlaneReadiness}
        loading={controlPlaneLoading}
        error={controlPlaneError}
        onRefresh={onRefreshControlPlane}
      />
      <Inline gap={3} align="center">
        <Stack gap={1}>
          <h2>{t("catalog.features.sourceObservations.ui.integrations.profile.review.title")}</h2>
          <p>{t("catalog.features.sourceObservations.ui.integrations.profile.review.description")}</p>
        </Stack>
        <Button tone="secondary" leadingIcon="refreshCcw" onClick={onRefresh}>
          {t("catalog.features.sourceObservations.ui.integrations.profile.review.refresh")}
        </Button>
      </Inline>
      <Select
        label={t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.workspace")}
        value={selectedProfileId}
        onValueChange={onSelectedProfileChange}
        items={
          profileWorkspaceItems.length > 0
            ? profileWorkspaceItems
            : [
                {
                  label: t(
                    "catalog.features.sourceObservations.ui.integrationManagementPage.no.provider.profiles.available",
                  ),
                  value: emptyProfileWorkspaceValue,
                },
              ]
        }
        disabled={profileWorkspaceItems.length === 0}
      />
      <DataTable
        rows={profiles}
        columns={columns}
        getRowId={getProfileRowId}
        emptyTitle={t("catalog.features.sourceObservations.ui.integrations.profile.review.none.found")}
      />
    </Stack>
  );
}

function CatalogIntegrationControlPlaneReadinessPanel({
  readiness,
  loading,
  error,
  onRefresh,
}: Readonly<{
  readiness: CatalogIntegrationControlPlaneReadiness | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}>) {
  const units = readiness?.units ?? [];
  const readyUnits = units.filter(
    (unit) =>
      unit.semanticReadiness === "ready" &&
      unit.transportReadiness === "ready" &&
      unit.fixtureValidationStatus === "ready" &&
      unit.dryRunStatus === "completed",
  ).length;

  return (
    <Stack gap={3}>
      <Inline gap={3} align="center">
        <Stack gap={1}>
          <h2>{t("catalog.features.sourceObservations.ui.integrationManagementPage.first.slice.readiness")}</h2>
          <p>
            {t(
              "catalog.features.sourceObservations.ui.integrationManagementPage.reference.ingestion.unit.health.fixture.validation.dry.run.facts.and.diagnostics",
            )}
          </p>
        </Stack>
        <Button tone="secondary" leadingIcon="refreshCcw" loading={loading} onClick={onRefresh}>
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.refresh.readiness")}
        </Button>
      </Inline>
      {error ? (
        <OperationalStatusBanner
          tone="danger"
          title={t("catalog.features.sourceObservations.ui.integrationManagementPage.readiness.unavailable")}
          description={error}
        />
      ) : null}
      <TaskSummary
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.control.plane.proof")}
        items={[
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.ready.units"),
            value: `${readyUnits}/${units.length}`,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.generated"),
            value: readiness ? formatDateTime(readiness.generatedAt) : loading ? "Loading" : "Not loaded",
          },
        ]}
      />
      {units.length > 0 ? (
        <Stack gap={2}>
          {units.map((unit) => (
            <CatalogIntegrationControlPlaneUnitPanel key={unit.unitKey} unit={unit} />
          ))}
        </Stack>
      ) : !loading ? (
        <OperationalStatusBanner
          tone="warning"
          title={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.ingestion.units.reported")}
          description={t(
            "catalog.features.sourceObservations.ui.integrationManagementPage.the.catalog.integration.control.plane.did.not.return.any.ingestion.unit.readiness.records",
          )}
        />
      ) : null}
    </Stack>
  );
}

function CatalogIntegrationControlPlaneUnitPanel({
  unit,
}: Readonly<{ unit: CatalogIntegrationControlPlaneUnitReadiness }>) {
  const firstEvidence = unit.dryRunEvidence[0] ?? null;

  return (
    <Stack gap={2}>
      <Inline gap={2} align="center" wrap>
        <h3>{unit.displayName}</h3>
        <StatusPill tone={unit.semanticReadiness === "ready" ? "success" : "danger"}>
          {unit.semanticReadiness}
        </StatusPill>
        <StatusPill tone={unit.dryRunStatus === "completed" ? "success" : "danger"}>{unit.dryRunStatus}</StatusPill>
      </Inline>
      <TaskSummary
        title={unit.unitKey}
        items={[
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.provider"),
            value: unit.providerKey,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.version"),
            value: unit.profileVersion || "Not assigned",
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.transport"),
            value: unit.transportReadiness,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.fixtures"),
            value: unit.fixtureValidationStatus,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.facts"),
            value: formatCount(unit.observationFacts),
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.diagnostics"),
            value: `${unit.diagnosticCounts.error} error / ${unit.diagnosticCounts.warning} warning / ${unit.diagnosticCounts.info} info`,
          },
        ]}
      />
      {firstEvidence ? (
        <TaskSummary
          title={t("catalog.features.sourceObservations.ui.integrationManagementPage.dry.run.source.observation.fact")}
          items={[
            {
              label: t("catalog.features.sourceObservations.ui.integrationManagementPage.external.key"),
              value: firstEvidence.externalKey,
            },
            {
              label: t("catalog.features.sourceObservations.ui.integrationManagementPage.source.hash"),
              value: firstEvidence.sourceHash ?? "None",
            },
            {
              label: t("catalog.features.sourceObservations.ui.integrationManagementPage.name"),
              value: firstEvidence.normalizedFacts.name ?? "None",
            },
            {
              label: t("catalog.features.sourceObservations.ui.integrationManagementPage.expansion"),
              value: firstEvidence.normalizedFacts.expansionName ?? "None",
            },
          ]}
        />
      ) : null}
      {unit.latestDiagnosticText ? <p className="text-sm text-secondary">{unit.latestDiagnosticText}</p> : null}
    </Stack>
  );
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
