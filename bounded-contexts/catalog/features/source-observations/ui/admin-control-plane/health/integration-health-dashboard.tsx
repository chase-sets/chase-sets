import {
  Badge,
  DataTable,
  KeyValueList,
  LinkButton,
  MetricStrip,
  OperationalStatusBanner,
  WorkflowModule,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchHealthTriageJob,
  CatalogPrimaryWorkbenchHealthTriageProvider,
  CatalogPrimaryWorkbenchHealthTriageReadModel,
  CatalogPrimaryWorkbenchHealthTriageReadModelState,
  CatalogPrimaryWorkbenchHealthTriageRolloutControl,
  CatalogPrimaryWorkbenchHealthTriageStatus,
  CatalogPrimaryWorkbenchHealthTriageUnit,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";

export function CatalogIntegrationHealthTriageWorkspace({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const health = readModel.healthTriage;

  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.title")}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.description")}
      status={<Badge tone={statusTone(health.status)}>{statusLabel(health.status)}</Badge>}
      actions={
        <LinkButton size="sm" tone="secondary" leadingIcon="chevronLeft" href={health.returnToPrimaryHref}>
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.health.return.primary")}
        </LinkButton>
      }
      headingLevel={2}
      density="compact"
    >
      <MetricStrip
        items={[
          {
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.metric.ready.units"),
            value: `${health.summary.readyUnits}/${health.summary.totalUnits}`,
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.metric.ready.units.trend"),
          },
          {
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.metric.blocked.units"),
            value: String(health.summary.blockedUnits),
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.metric.blocked.units.trend"),
          },
          {
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.metric.degraded.providers"),
            value: String(health.summary.degradedProviders),
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.metric.degraded.providers.trend"),
          },
          {
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.metric.active.jobs"),
            value: String(health.summary.activeJobs),
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.metric.active.jobs.trend"),
          },
          {
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.metric.rollout.stops"),
            value: String(health.summary.rolloutStops),
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.metric.rollout.stops.trend"),
          },
          {
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.metric.audit.entries"),
            value: String(health.summary.auditEntries),
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.metric.audit.entries.trend"),
          },
        ]}
      />

      {health.status === "unavailable" ? (
        <OperationalStatusBanner
          tone="danger"
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unavailable.title")}
          description={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unavailable.description")}
        />
      ) : null}

      <DataTable
        rows={[...health.readModels]}
        columns={readModelColumns}
        getRowId={(row) => row.queryKey}
        density="compact"
        emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModels.empty")}
        emptyDescription={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModels.empty.detail")}
      />

      <DataTable
        rows={[...health.units]}
        columns={unitColumns}
        getRowId={(row) => row.unitKey}
        density="compact"
        emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.units.empty")}
        emptyDescription={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.units.empty.detail")}
      />

      <DataTable
        rows={[...health.providers]}
        columns={providerColumns}
        getRowId={(row) => row.providerKey}
        density="compact"
        emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.providers.empty")}
        emptyDescription={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.providers.empty.detail")}
      />

      <CatalogIntegrationRolloutTriage controls={health.rolloutControls} />
      <CatalogIntegrationJobTriage jobs={health.recentJobs} />
      <CatalogIntegrationAuditTriage health={health} />
    </WorkflowModule>
  );
}

const readModelColumns: DataColumn<CatalogPrimaryWorkbenchHealthTriageReadModelState>[] = [
  {
    key: "query",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.query"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.query"),
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{row.queryKey}</span>
        <span className="text-xs text-secondary">{row.statusMessage}</span>
      </div>
    ),
  },
  {
    key: "freshness",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.freshness"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.freshness"),
    cell: (row) => <Badge tone={freshnessTone(row.freshness)}>{row.freshness}</Badge>,
  },
  {
    key: "ownerMetric",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.owner.metric"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.owner.metric"),
    cell: (row) => row.ownerMetricKey,
  },
  {
    key: "generated",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.generated"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.generated"),
    cell: (row) => formatDateTime(row.generatedAt),
  },
];

const unitColumns: DataColumn<CatalogPrimaryWorkbenchHealthTriageUnit>[] = [
  {
    key: "unit",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.unit"),
    sortable: true,
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{row.displayName}</span>
        <span className="text-xs text-secondary">{row.unitKey}</span>
        <span className="text-xs text-secondary">
          {row.providerKey} · {row.productDomain}/{row.productForm}
        </span>
      </div>
    ),
  },
  {
    key: "semantic",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.catalog.semantic"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.catalog.semantic"),
    cell: (row) => (
      <div className="flex min-w-0 flex-wrap gap-1.5">
        <Badge tone={readinessTone(row.semanticReadiness)}>{row.semanticReadiness}</Badge>
        <Badge tone={readinessTone(row.fixtureValidationStatus)}>{row.fixtureValidationStatus}</Badge>
        <Badge tone={row.dryRunStatus === "completed" ? "success" : "danger"}>{row.dryRunStatus}</Badge>
      </div>
    ),
  },
  {
    key: "transport",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.provider.transport"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.provider.transport"),
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        <div className="flex min-w-0 flex-wrap gap-1.5">
          <Badge tone={readinessTone(row.transportReadiness)}>{row.transportReadiness}</Badge>
          <Badge tone={readinessTone(row.credentialReadiness)}>{row.credentialReadinessState}</Badge>
        </div>
        <span className="text-xs text-secondary">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.health.observation.facts", {
            count: String(row.observationFacts),
          })}
        </span>
      </div>
    ),
  },
  {
    key: "next",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.next.action"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.next.action"),
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
        <span className="text-sm text-foreground">{primaryActionLabel(row.affectedPrimaryAction)}</span>
        <span className="text-xs text-secondary">{row.ownerMetricKey}</span>
        <span className="text-xs leading-5 text-secondary">{row.nextAction}</span>
      </div>
    ),
  },
  {
    key: "diagnostics",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.diagnostics"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.diagnostics"),
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm text-foreground">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.health.diagnostic.counts", {
            errors: String(row.diagnosticCounts.error),
            warnings: String(row.diagnosticCounts.warning),
            infos: String(row.diagnosticCounts.info),
          })}
        </span>
        <span className="text-xs leading-5 text-secondary">
          {row.latestDiagnosticText ??
            t("catalog.features.sourceObservations.ui.primaryWorkbench.health.diagnostics.none")}
        </span>
      </div>
    ),
  },
];

const providerColumns: DataColumn<CatalogPrimaryWorkbenchHealthTriageProvider>[] = [
  {
    key: "provider",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.provider"),
    sortable: true,
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{row.providerKey}</span>
        <span className="text-xs text-secondary">{row.adapterKey}</span>
        <span className="text-xs text-secondary">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.health.affected.units", {
            count: String(row.unitKeys.length),
          })}
        </span>
      </div>
    ),
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.status"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.status"),
    cell: (row) => (
      <div className="flex min-w-0 flex-wrap gap-1.5">
        <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
        <Badge tone={readinessTone(row.credentialReadiness)}>{row.credentialReadinessState}</Badge>
      </div>
    ),
  },
  {
    key: "capabilities",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.capabilities"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.capabilities"),
    cell: (row) => (
      <KeyValueList
        density="compact"
        items={[
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.capability.api"),
            value: row.apiReachability,
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.capability.options"),
            value: row.optionQueryHealth,
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.capability.rate.limit"),
            value: row.rateLimitStatus,
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.capability.payload"),
            value: row.payloadAcquisition,
          },
        ]}
      />
    ),
  },
  {
    key: "next",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.next.action"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.next.action"),
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-xs text-secondary">{row.ownerMetricKey}</span>
        <span className="text-sm leading-5 text-foreground">{row.nextAction}</span>
        <span className="text-xs leading-5 text-secondary">
          {row.latestDiagnosticText ??
            t("catalog.features.sourceObservations.ui.primaryWorkbench.health.diagnostics.none")}
        </span>
      </div>
    ),
  },
];

function CatalogIntegrationRolloutTriage({
  controls,
}: Readonly<{
  controls: readonly CatalogPrimaryWorkbenchHealthTriageRolloutControl[];
}>) {
  const activeControls = controls.filter((control) => control.status !== "open");

  if (activeControls.length === 0) {
    return (
      <OperationalStatusBanner
        tone="success"
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.rollout.clear.title")}
        description={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.rollout.clear.description")}
      />
    );
  }

  return (
    <div className="grid gap-2">
      {activeControls.map((control) => (
        <OperationalStatusBanner
          key={control.controlId}
          tone={control.status === "blocked" ? "danger" : "warning"}
          title={control.controlId}
          description={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.rollout.description", {
            message: control.message,
            ownerMetric: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.rollout.owner.metric", {
              metric: control.metricKey,
              owner: control.owner,
              ownerIssue: String(control.ownerIssue),
            }),
            nextAction: control.nextAction,
          })}
        />
      ))}
    </div>
  );
}

function CatalogIntegrationJobTriage({
  jobs,
}: Readonly<{
  jobs: readonly CatalogPrimaryWorkbenchHealthTriageJob[];
}>) {
  const columns: DataColumn<CatalogPrimaryWorkbenchHealthTriageJob>[] = [
    {
      key: "job",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.job"),
      cell: (row) => (
        <div className="grid min-w-0 gap-1">
          <span className="text-sm font-semibold text-foreground">{row.jobId}</span>
          <span className="text-xs text-secondary">{row.summary}</span>
        </div>
      ),
    },
    {
      key: "progress",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.progress"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.progress"),
      cell: (row) => (
        <div className="grid min-w-0 gap-1">
          <Badge tone={row.phase === "failed" ? "danger" : "warning"}>{row.operatorStatus}</Badge>
          <span className="text-xs text-secondary">{row.progressLabel}</span>
        </div>
      ),
    },
    {
      key: "next",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.next.action"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.next.action"),
      cell: (row) => (
        <div className="grid min-w-0 gap-1">
          <span className="text-xs text-secondary">{row.ownerMetricKey}</span>
          <span className="text-sm text-foreground">{row.nextAction}</span>
        </div>
      ),
    },
  ];

  return (
    <DataTable
      rows={[...jobs]}
      columns={columns}
      getRowId={(row) => row.jobId}
      density="compact"
      emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.jobs.empty")}
      emptyDescription={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.jobs.empty.detail")}
    />
  );
}

function CatalogIntegrationAuditTriage({
  health,
}: Readonly<{
  health: CatalogPrimaryWorkbenchHealthTriageReadModel;
}>) {
  const columns: DataColumn<CatalogPrimaryWorkbenchHealthTriageReadModel["auditPreview"]["entries"][number]>[] = [
    {
      key: "event",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.audit.event"),
      cell: (row) => (
        <div className="grid min-w-0 gap-1">
          <span className="text-sm font-semibold text-foreground">{row.eventName}</span>
          <span className="text-xs text-secondary">{row.summary}</span>
        </div>
      ),
    },
    {
      key: "category",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.audit.category"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.audit.category"),
      cell: (row) => <Badge tone="neutral">{row.category}</Badge>,
    },
    {
      key: "scope",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.scope"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.scope"),
      cell: (row) =>
        `${row.providerKey} / ${row.unitKey ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected")}`,
    },
    {
      key: "occurred",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.occurred"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.occurred"),
      cell: (row) => formatDateTime(row.occurredAt),
    },
  ];

  return (
    <div className="grid gap-2">
      <OperationalStatusBanner
        tone={health.auditPreview.projectionStatus === "partial" ? "warning" : "danger"}
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.audit.status", {
          status: health.auditPreview.projectionStatus,
        })}
        description={health.auditPreview.statusMessage}
      />
      <DataTable
        rows={[...health.auditPreview.entries]}
        columns={columns}
        getRowId={(row) => row.eventId}
        density="compact"
        emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.audit.empty")}
        emptyDescription={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.audit.empty.detail")}
      />
    </div>
  );
}

function statusTone(status: CatalogPrimaryWorkbenchHealthTriageStatus): "success" | "danger" | "warning" | "neutral" {
  if (status === "ready") {
    return "success";
  }
  if (status === "blocked" || status === "unavailable") {
    return "danger";
  }

  return "warning";
}

function readinessTone(status: string): "success" | "danger" | "warning" | "neutral" {
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

function freshnessTone(status: string): "success" | "danger" | "warning" | "neutral" {
  if (status === "fresh") {
    return "success";
  }
  if (status === "unavailable") {
    return "danger";
  }
  if (status === "partial" || status === "stale" || status === "lagging") {
    return "warning";
  }

  return "neutral";
}

function statusLabel(status: CatalogPrimaryWorkbenchHealthTriageStatus): string {
  switch (status) {
    case "ready":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.status.ready");
    case "degraded":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.status.degraded");
    case "blocked":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.status.blocked");
    case "unavailable":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.status.unavailable");
  }
}

function primaryActionLabel(action: CatalogPrimaryWorkbenchHealthTriageUnit["affectedPrimaryAction"]): string {
  switch (action) {
    case "pull-provider-data":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.primaryAction.pullProviderData");
    case "review-source-observations":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.primaryAction.reviewSourceObservations");
    case "preview-promotion":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.primaryAction.previewPromotion");
  }
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected");
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
