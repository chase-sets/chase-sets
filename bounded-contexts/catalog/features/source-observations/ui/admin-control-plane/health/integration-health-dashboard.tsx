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
  CatalogIntegrationAuditLifecycleEntry,
  CatalogIntegrationControlPlaneOverview,
  CatalogIntegrationRecentJobSummary,
  CatalogIntegrationControlPlaneUnitReadiness,
  CatalogIntegrationProviderReadiness,
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
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
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
  controlPlaneOverview,
  controlPlaneLoading,
  controlPlaneError,
  onRefreshControlPlane,
}: CatalogIntegrationProfileHealthPanelProps) {
  return (
    <Stack gap={3}>
      <CatalogIntegrationControlPlaneReadinessPanel
        overview={controlPlaneOverview}
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
  overview,
  loading,
  error,
  onRefresh,
}: Readonly<{
  overview: CatalogIntegrationControlPlaneOverview | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}>) {
  const readiness = overview?.readiness ?? null;
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
            value: readiness
              ? formatDateTime(readiness.generatedAt)
              : loading
                ? t("catalog.features.sourceObservations.ui.integrationManagementPage.loading")
                : t("catalog.features.sourceObservations.ui.integrationManagementPage.not.loaded"),
          },
        ]}
      />
      {units.length > 0 ? (
        <Stack gap={2}>
          {units.map((unit) => {
            const recentJobs =
              overview?.unitActivity.units.find((activity) => activity.unitKey === unit.unitKey)?.recentJobs ?? [];

            return <CatalogIntegrationControlPlaneUnitPanel key={unit.unitKey} unit={unit} recentJobs={recentJobs} />;
          })}
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
      <CatalogIntegrationProviderReadinessPanel overview={overview} loading={loading} />
      <CatalogIntegrationAuditLifecyclePanel overview={overview} loading={loading} />
    </Stack>
  );
}

function CatalogIntegrationControlPlaneUnitPanel({
  unit,
  recentJobs,
}: Readonly<{
  unit: CatalogIntegrationControlPlaneUnitReadiness;
  recentJobs: readonly CatalogIntegrationRecentJobSummary[];
}>) {
  const firstEvidence = unit.dryRunEvidence[0] ?? null;
  const latestJob = recentJobs[0] ?? null;

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
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.credential"),
            value: `${unit.credentialReadiness} / ${unit.credentialReadinessState}`,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.version"),
            value:
              unit.profileVersion || t("catalog.features.sourceObservations.ui.integrationManagementPage.not.assigned"),
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
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.recent.jobs"),
            value: recentJobs.length
              ? formatCount(recentJobs.length)
              : t("catalog.features.sourceObservations.ui.integrationManagementPage.none"),
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.latest.job"),
            value: latestJob
              ? formatRecentJob(latestJob)
              : t("catalog.features.sourceObservations.ui.integrationManagementPage.none"),
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
              value:
                firstEvidence.sourceHash ?? t("catalog.features.sourceObservations.ui.integrationManagementPage.none"),
            },
            {
              label: t("catalog.features.sourceObservations.ui.integrationManagementPage.name"),
              value:
                firstEvidence.normalizedFacts.name ??
                t("catalog.features.sourceObservations.ui.integrationManagementPage.none"),
            },
            {
              label: t("catalog.features.sourceObservations.ui.integrationManagementPage.expansion"),
              value:
                firstEvidence.normalizedFacts.expansionName ??
                t("catalog.features.sourceObservations.ui.integrationManagementPage.none"),
            },
          ]}
        />
      ) : null}
      {unit.latestDiagnosticText ? <p className="text-sm text-secondary">{unit.latestDiagnosticText}</p> : null}
    </Stack>
  );
}

function CatalogIntegrationProviderReadinessPanel({
  overview,
  loading,
}: Readonly<{
  overview: CatalogIntegrationControlPlaneOverview | null;
  loading: boolean;
}>) {
  const providers = overview?.providerReadiness.providers ?? [];
  const readyProviders = providers.filter((provider) => provider.readiness === "ready").length;

  return (
    <Stack gap={3}>
      <Inline gap={3} align="center">
        <Stack gap={1}>
          <h2>{t("catalog.features.sourceObservations.ui.integrationManagementPage.adapter.readiness")}</h2>
          <p>{t("catalog.features.sourceObservations.ui.integrationManagementPage.adapter.readiness.description")}</p>
        </Stack>
      </Inline>
      <TaskSummary
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.provider.adapters")}
        items={[
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.ready.providers"),
            value: `${readyProviders}/${providers.length}`,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.generated"),
            value: overview
              ? formatDateTime(overview.providerReadiness.generatedAt)
              : loading
                ? t("catalog.features.sourceObservations.ui.integrationManagementPage.loading")
                : t("catalog.features.sourceObservations.ui.integrationManagementPage.not.loaded"),
          },
        ]}
      />
      {providers.length > 0 ? (
        <Stack gap={2}>
          {providers.map((provider) => (
            <CatalogIntegrationProviderReadinessCard key={provider.providerKey} provider={provider} />
          ))}
        </Stack>
      ) : !loading ? (
        <OperationalStatusBanner
          tone="warning"
          title={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.provider.readiness.reported")}
          description={t(
            "catalog.features.sourceObservations.ui.integrationManagementPage.no.provider.readiness.reported.description",
          )}
        />
      ) : null}
    </Stack>
  );
}

function CatalogIntegrationProviderReadinessCard({
  provider,
}: Readonly<{ provider: CatalogIntegrationProviderReadiness }>) {
  const latestDiagnostic = provider.diagnostics.at(-1) ?? null;

  return (
    <Stack gap={2}>
      <Inline gap={2} align="center" wrap>
        <h3>{provider.providerKey}</h3>
        <StatusPill tone={statusTone(provider.readiness)}>{provider.readiness}</StatusPill>
        <StatusPill tone={statusTone(provider.credentialReadiness)}>{provider.credentialReadinessState}</StatusPill>
      </Inline>
      <TaskSummary
        title={provider.adapterKey}
        items={[
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.credential"),
            value: `${provider.credentialRequirement} / ${provider.credentialReadiness}`,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.api.reachability"),
            value: provider.apiReachability.status,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.option.query.health"),
            value: provider.optionQueryHealth.status,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.rate.limit.cooldown"),
            value: provider.rateLimitStatus.status,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.payload.acquisition"),
            value: provider.payloadAcquisition.status,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.affected.units"),
            value: String(provider.unitKeys.length),
          },
        ]}
      />
      {latestDiagnostic ? <p className="text-sm text-secondary">{latestDiagnostic.message}</p> : null}
    </Stack>
  );
}

function CatalogIntegrationAuditLifecyclePanel({
  overview,
  loading,
}: Readonly<{
  overview: CatalogIntegrationControlPlaneOverview | null;
  loading: boolean;
}>) {
  const lifecycle = overview?.auditLifecycle ?? null;
  const rows = lifecycle?.entries ?? [];
  const columns: DataColumn<CatalogIntegrationAuditLifecycleEntry>[] = [
    {
      key: "eventName",
      header: t("catalog.features.sourceObservations.ui.integrationManagementPage.audit.event"),
      cell: (row) => (
        <Inline gap={2} align="center" wrap>
          <StatusPill tone={auditCategoryTone(row.category)}>{row.category}</StatusPill>
          <span>{row.eventName}</span>
        </Inline>
      ),
    },
    {
      key: "providerKey",
      header: t("catalog.features.sourceObservations.ui.integrationManagementPage.provider"),
      cell: (row) => row.providerKey,
    },
    {
      key: "unitKey",
      header: t("catalog.features.sourceObservations.ui.integrationManagementPage.unit"),
      cell: (row) => row.unitKey ?? t("catalog.features.sourceObservations.ui.integrationManagementPage.none"),
    },
    {
      key: "profileVersion",
      header: t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.version"),
      cell: (row) => row.profileVersion ?? t("catalog.features.sourceObservations.ui.integrationManagementPage.none"),
    },
    {
      key: "occurredAt",
      header: t("catalog.features.sourceObservations.ui.integrationManagementPage.occurred"),
      cell: (row) => formatDateTime(row.occurredAt),
    },
    {
      key: "summary",
      header: t("catalog.features.sourceObservations.ui.integrationManagementPage.summary"),
      cell: (row) => row.summary,
    },
  ];

  return (
    <Stack gap={3}>
      <Inline gap={3} align="center">
        <Stack gap={1}>
          <h2>{t("catalog.features.sourceObservations.ui.integrationManagementPage.audit.lifecycle")}</h2>
          <p>{t("catalog.features.sourceObservations.ui.integrationManagementPage.audit.lifecycle.description")}</p>
        </Stack>
      </Inline>
      {lifecycle ? (
        <OperationalStatusBanner
          tone={lifecycle.projectionStatus === "partial" ? "warning" : "danger"}
          title={t("catalog.features.sourceObservations.ui.integrationManagementPage.audit.lifecycle.partial")}
          description={lifecycle.statusMessage}
        />
      ) : loading ? null : (
        <OperationalStatusBanner
          tone="warning"
          title={t("catalog.features.sourceObservations.ui.integrationManagementPage.audit.lifecycle.unavailable")}
          description={t(
            "catalog.features.sourceObservations.ui.integrationManagementPage.audit.lifecycle.unavailable.description",
          )}
        />
      )}
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.eventId}
        emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.audit.lifecycle.entries")}
      />
    </Stack>
  );
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return t("catalog.features.sourceObservations.ui.integrationManagementPage.never");
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatRecentJob(job: CatalogIntegrationRecentJobSummary): string {
  return `${job.action} ${job.operatorStatus} (${formatCount(job.completed)}/${formatCount(job.total)})`;
}

function statusTone(status: string): "success" | "danger" | "warning" | "neutral" {
  if (status === "ready" || status === "completed" || status === "not-required" || status === "configured") {
    return "success";
  }
  if (status === "blocked" || status === "missing" || status === "invalid" || status === "expired") {
    return "danger";
  }
  if (status === "degraded" || status === "unknown") {
    return "warning";
  }
  return "neutral";
}

function auditCategoryTone(
  category: CatalogIntegrationAuditLifecycleEntry["category"],
): "success" | "danger" | "warning" | "neutral" | "info" {
  if (category === "activation") {
    return "success";
  }
  if (category === "import-job" || category === "reapply") {
    return "info";
  }
  if (category === "profile-section") {
    return "warning";
  }
  return "neutral";
}
