import {
  Badge,
  BadgeCluster,
  DataTable,
  KeyValueList,
  MetricStrip,
  OperationalStatusBanner,
  WorkbenchDataCell,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
  type DataColumn,
} from "@chase-sets/design-system";
import { formatDateTime, t } from "@chase-sets/localization";
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
        caption={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.query")}
        getRowId={(row) => row.queryKey}
        density="compact"
        emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModels.empty")}
        emptyDescription={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModels.empty.detail")}
      />

      <DataTable
        rows={[...health.units]}
        columns={unitColumns}
        caption={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.unit")}
        getRowId={(row) => row.unitKey}
        density="compact"
        emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.units.empty")}
        emptyDescription={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.units.empty.detail")}
      />

      <DataTable
        rows={[...health.providers]}
        columns={providerColumns}
        caption={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.provider")}
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
    cell: (row) => <WorkbenchDataCell title={row.queryKey} description={row.statusMessage} />,
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
    cell: (row) => formatWorkspaceDateTime(row.generatedAt),
  },
];

const unitColumns: DataColumn<CatalogPrimaryWorkbenchHealthTriageUnit>[] = [
  {
    key: "unit",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.unit"),
    sortable: true,
    cell: (row) => (
      <WorkbenchDataCell
        title={row.displayName}
        description={row.unitKey}
        detail={`${row.providerKey} / ${row.productDomain}/${row.productForm}`}
      />
    ),
  },
  {
    key: "semantic",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.catalog.semantic"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.catalog.semantic"),
    cell: (row) => (
      <BadgeCluster
        items={[
          { key: "semantic", label: row.semanticReadiness, tone: readinessTone(row.semanticReadiness) },
          { key: "fixture", label: row.fixtureValidationStatus, tone: readinessTone(row.fixtureValidationStatus) },
          { key: "dry-run", label: row.dryRunStatus, tone: row.dryRunStatus === "completed" ? "success" : "danger" },
        ]}
      />
    ),
  },
  {
    key: "transport",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.provider.transport"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.provider.transport"),
    cell: (row) => (
      <WorkbenchStack gap="sm">
        <BadgeCluster
          items={[
            { key: "transport", label: row.transportReadiness, tone: readinessTone(row.transportReadiness) },
            { key: "credential", label: row.credentialReadinessState, tone: readinessTone(row.credentialReadiness) },
          ]}
        />
        <WorkbenchText size="xs">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.health.observation.facts", {
            count: String(row.observationFacts),
          })}
        </WorkbenchText>
      </WorkbenchStack>
    ),
  },
  {
    key: "next",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.next.action"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.next.action"),
    cell: (row) => (
      <WorkbenchStack gap="sm">
        <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
        <WorkbenchText tone="foreground">{primaryActionLabel(row.affectedPrimaryAction)}</WorkbenchText>
        <WorkbenchText size="xs">{row.ownerMetricKey}</WorkbenchText>
        <WorkbenchText size="xs">{row.nextAction}</WorkbenchText>
      </WorkbenchStack>
    ),
  },
  {
    key: "diagnostics",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.diagnostics"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.diagnostics"),
    cell: (row) => (
      <WorkbenchDataCell
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.diagnostic.counts", {
          errors: String(row.diagnosticCounts.error),
          warnings: String(row.diagnosticCounts.warning),
          infos: String(row.diagnosticCounts.info),
        })}
        titleWeight="regular"
        detail={
          row.latestDiagnosticText ??
          t("catalog.features.sourceObservations.ui.primaryWorkbench.health.diagnostics.none")
        }
      />
    ),
  },
];

const providerColumns: DataColumn<CatalogPrimaryWorkbenchHealthTriageProvider>[] = [
  {
    key: "provider",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.provider"),
    sortable: true,
    cell: (row) => (
      <WorkbenchDataCell
        title={row.providerKey}
        description={row.adapterKey}
        detail={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.affected.units", {
          count: String(row.unitKeys.length),
        })}
      />
    ),
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.status"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.status"),
    cell: (row) => (
      <BadgeCluster
        items={[
          { key: "status", label: statusLabel(row.status), tone: statusTone(row.status) },
          { key: "credential", label: row.credentialReadinessState, tone: readinessTone(row.credentialReadiness) },
        ]}
      />
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
          ...(row.usageBudget
            ? [
                {
                  key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.capability.credits"),
                  value: formatUsageBudgetCredits(row.usageBudget),
                },
                {
                  key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.capability.budget.readiness"),
                  value: row.usageBudget.readiness,
                },
                {
                  key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.capability.estimated.calls"),
                  value: formatEstimatedCalls(row.usageBudget),
                },
              ]
            : []),
        ]}
      />
    ),
  },
  {
    key: "next",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.next.action"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.next.action"),
    cell: (row) => (
      <WorkbenchDataCell
        title={row.nextAction}
        titleWeight="regular"
        description={row.ownerMetricKey}
        detail={
          row.latestDiagnosticText ??
          t("catalog.features.sourceObservations.ui.primaryWorkbench.health.diagnostics.none")
        }
      />
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
    <WorkbenchStack gap="sm">
      {activeControls.map((control) => (
        <OperationalStatusBanner
          key={control.controlId}
          tone={control.status === "blocked" ? "danger" : "warning"}
          title={control.controlId}
          description={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.rollout.description", {
            message: control.message,
            ownerMetric: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.rollout.owner.metric", {
              metric: control.metricKey,
            }),
            nextAction: control.nextAction,
          })}
        />
      ))}
    </WorkbenchStack>
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
      cell: (row) => <WorkbenchDataCell title={row.jobId} description={row.summary} />,
    },
    {
      key: "progress",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.progress"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.progress"),
      cell: (row) => (
        <WorkbenchStack gap="sm">
          <Badge tone={row.phase === "failed" ? "danger" : "warning"}>{row.operatorStatus}</Badge>
          <WorkbenchText size="xs">{row.progressLabel}</WorkbenchText>
        </WorkbenchStack>
      ),
    },
    {
      key: "next",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.next.action"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.next.action"),
      cell: (row) => (
        <WorkbenchDataCell title={row.nextAction} titleWeight="regular" description={row.ownerMetricKey} />
      ),
    },
  ];

  return (
    <DataTable
      rows={[...jobs]}
      columns={columns}
      caption={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.job")}
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
      cell: (row) => <WorkbenchDataCell title={row.eventName} description={row.summary} />,
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
      cell: (row) => formatWorkspaceDateTime(row.occurredAt),
    },
  ];

  return (
    <WorkbenchStack gap="sm">
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
        caption={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.audit.event")}
        getRowId={(row) => row.eventId}
        density="compact"
        emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.audit.empty")}
        emptyDescription={t("catalog.features.sourceObservations.ui.primaryWorkbench.health.audit.empty.detail")}
      />
    </WorkbenchStack>
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
    case "observation.promote":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.primaryAction.previewPromotion");
  }
}

function formatWorkspaceDateTime(value: string | null | undefined) {
  if (!value) {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected");
  }

  return formatDateTime(value);
}

function formatUsageBudgetCredits(
  budget: NonNullable<CatalogPrimaryWorkbenchHealthTriageProvider["usageBudget"]>,
): string {
  if (budget.creditBalance === null) {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected");
  }

  return [String(budget.creditBalance), budget.creditUnit].filter(Boolean).join(" ");
}

function formatEstimatedCalls(budget: NonNullable<CatalogPrimaryWorkbenchHealthTriageProvider["usageBudget"]>): string {
  if (budget.estimatedCalls === null) {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected");
  }

  return [String(budget.estimatedCalls), budget.estimatedScope].filter(Boolean).join(" / ");
}
