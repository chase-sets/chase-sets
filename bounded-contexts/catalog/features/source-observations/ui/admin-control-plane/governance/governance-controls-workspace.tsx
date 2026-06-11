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
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import { getCatalogPrimaryWorkbenchBlockerCopy } from "../../primary-workbench-copy";

type GovernanceControls = CatalogPrimaryWorkbenchReadModel["governanceControls"];
type GovernanceControl = GovernanceControls["controls"][number];
type GovernanceRbacRow = GovernanceControls["rbacMatrix"][number];
type GovernanceSignal = GovernanceControls["observability"]["signals"][number];
type GovernanceRemovalEvidence = GovernanceControls["legacyRemovalEvidence"]["evidence"][number];
type BadgeTone = "success" | "warning" | "danger" | "neutral" | "info" | "accent";

export function CatalogIntegrationGovernanceControlsWorkspace({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const governance = readModel.governanceControls;

  return (
    <section className="grid min-w-0 gap-4" data-catalog-governance-controls-workspace="true">
      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.governanceControls.title")}
        description={t("catalog.features.sourceObservations.ui.governanceControls.description")}
        status={<Badge tone={statusTone(governance.status)}>{stateLabel(governance.status)}</Badge>}
        actions={
          <LinkButton size="sm" tone="secondary" leadingIcon="chevronLeft" href={governance.returnToPrimaryHref}>
            {t("catalog.features.sourceObservations.ui.governanceControls.backToWorkbench")}
          </LinkButton>
        }
        headingLevel={2}
        density="compact"
      >
        <div className="grid gap-4">
          <OperationalStatusBanner
            tone={governance.status === "blocked" ? "danger" : governance.status === "ready" ? "success" : "warning"}
            title={governanceBannerTitle(governance)}
            description={governanceBannerDescription(governance)}
          />
          <MetricStrip
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.governanceControls.metric.rolloutStops"),
                value: String(governance.summary.activeRolloutStops),
                trend: governance.rolloutMode.label,
              },
              {
                label: t("catalog.features.sourceObservations.ui.governanceControls.metric.deniedCommands"),
                value: String(governance.summary.deniedCommands),
                trend: "catalog.manage",
              },
              {
                label: t("catalog.features.sourceObservations.ui.governanceControls.metric.blockedCommands"),
                value: String(governance.summary.blockedCommands),
                trend: governance.rolloutMode.workerState,
              },
              {
                label: t("catalog.features.sourceObservations.ui.governanceControls.metric.observability"),
                value: String(governance.summary.degradedSignals),
                trend: `${governance.summary.alertCount} alert links`,
              },
              {
                label: t("catalog.features.sourceObservations.ui.governanceControls.metric.deletionEvidence"),
                value: String(governance.summary.deletionEvidenceCount),
                trend: governance.legacyRemovalEvidence.requiredDisposition,
              },
            ]}
          />
          <KeyValueList
            density="compact"
            layout="grid"
            items={[
              { key: "Rollout mode", value: governance.rolloutMode.state },
              { key: "Worker state", value: governance.rolloutMode.workerState },
              {
                key: "Provider emergency stops",
                value: String(governance.rolloutMode.providerEmergencyStopCount),
              },
              { key: "Import kill switch", value: onOff(governance.rolloutMode.importKillSwitchActive) },
              { key: "Promotion kill switch", value: onOff(governance.rolloutMode.promotionKillSwitchActive) },
              { key: "Reapply/replay kill switch", value: onOff(governance.rolloutMode.reapplyKillSwitchActive) },
            ]}
          />
        </div>
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.governanceControls.controls.title")}
        description={t("catalog.features.sourceObservations.ui.governanceControls.controls.description")}
        status={
          <Badge tone={governance.summary.activeRolloutStops > 0 ? "danger" : "success"}>
            {governance.rolloutMode.state}
          </Badge>
        }
        density="compact"
      >
        <DataTable
          rows={[...governance.controls]}
          columns={controlColumns}
          getRowId={(row) => row.controlId}
          density="compact"
          emptyTitle={t("catalog.features.sourceObservations.ui.governanceControls.controls.emptyTitle")}
          emptyDescription={t("catalog.features.sourceObservations.ui.governanceControls.controls.emptyDescription")}
        />
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.governanceControls.rbac.title")}
        description={t("catalog.features.sourceObservations.ui.governanceControls.rbac.description")}
        status={
          <Badge tone={governance.summary.deniedCommands > 0 ? "danger" : "success"}>
            {t("catalog.features.sourceObservations.ui.governanceControls.rbac.actionCount", {
              count: governance.rbacMatrix.length,
            })}
          </Badge>
        }
        density="compact"
      >
        <DataTable
          rows={[...governance.rbacMatrix]}
          columns={rbacColumns}
          getRowId={(row) => row.actionKey}
          density="compact"
          emptyTitle={t("catalog.features.sourceObservations.ui.governanceControls.rbac.emptyTitle")}
          emptyDescription={t("catalog.features.sourceObservations.ui.governanceControls.rbac.emptyDescription")}
        />
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.governanceControls.observability.title")}
        description={t("catalog.features.sourceObservations.ui.governanceControls.observability.description")}
        status={
          <Badge tone={statusTone(governance.observability.status)}>
            {stateLabel(governance.observability.status)}
          </Badge>
        }
        density="compact"
      >
        <DataTable
          rows={[...governance.observability.signals]}
          columns={observabilityColumns}
          getRowId={(row) => row.key}
          density="compact"
          emptyTitle={t("catalog.features.sourceObservations.ui.governanceControls.observability.emptyTitle")}
          emptyDescription={t(
            "catalog.features.sourceObservations.ui.governanceControls.observability.emptyDescription",
          )}
        />
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.governanceControls.removal.title")}
        description={t("catalog.features.sourceObservations.ui.governanceControls.removal.description")}
        status={<Badge tone="danger">{governance.legacyRemovalEvidence.requiredDisposition}</Badge>}
        density="compact"
      >
        <div className="grid gap-4">
          <OperationalStatusBanner
            tone="danger"
            title={t("catalog.features.sourceObservations.ui.governanceControls.removal.bannerTitle")}
            description={t("catalog.features.sourceObservations.ui.governanceControls.removal.bannerDescription")}
          />
          <KeyValueList
            density="compact"
            layout="grid"
            items={[
              { key: "Status", value: governance.legacyRemovalEvidence.status },
              { key: "Removed surfaces", value: governance.legacyRemovalEvidence.removedSurfaces.join(", ") },
              {
                key: "Launch blocker if present",
                value: governance.legacyRemovalEvidence.launchBlockerIfPresent.join(", "),
              },
            ]}
          />
          <DataTable
            rows={[...governance.legacyRemovalEvidence.evidence]}
            columns={removalColumns}
            getRowId={(row) => row.key}
            density="compact"
          />
        </div>
      </WorkflowModule>
    </section>
  );
}

const controlColumns: DataColumn<GovernanceControl>[] = [
  {
    key: "control",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.control"),
    sortable: true,
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{row.label}</span>
        <span className="text-xs text-secondary">{row.controlId}</span>
        <span className="text-xs leading-5 text-secondary">{row.message}</span>
      </div>
    ),
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.status"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.status"),
    cell: (row) => (
      <div className="grid gap-1">
        <Badge tone={controlTone(row.status)}>{stateLabel(row.status)}</Badge>
        <BlockerBadges blockers={row.blockers} />
      </div>
    ),
  },
  {
    key: "owner",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.ownerMetric"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.ownerMetric"),
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm text-foreground">{row.owner}</span>
        <span className="text-xs text-secondary">{row.metricKey}</span>
        <span className="text-xs text-secondary">
          {row.ownerIssue
            ? t("catalog.features.sourceObservations.ui.governanceControls.issue", { value: row.ownerIssue })
            : t("catalog.features.sourceObservations.ui.governanceControls.noIssue")}
        </span>
      </div>
    ),
  },
  {
    key: "scope",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.scope"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.scope"),
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-xs text-secondary">{row.commandKeys.join(", ") || "deletion evidence"}</span>
        <span className="text-xs text-secondary">{row.providerKeys.join(", ") || "all providers"}</span>
        <span className="text-xs text-secondary">{row.unitKeys.join(", ") || "all units"}</span>
      </div>
    ),
  },
  {
    key: "evidence",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.evidence"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.evidence"),
    align: "right",
    cell: (row) => (
      <a className="text-sm font-semibold text-accent hover:underline" href={row.evidenceUrl}>
        {t("catalog.features.sourceObservations.ui.governanceControls.openEvidence")}
      </a>
    ),
  },
];

const rbacColumns: DataColumn<GovernanceRbacRow>[] = [
  {
    key: "action",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.action"),
    sortable: true,
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{row.actionKey}</span>
        <span className="text-xs text-secondary">{row.routePattern}</span>
      </div>
    ),
  },
  {
    key: "permission",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.permission"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.permission"),
    cell: (row) => (
      <div className="flex min-w-0 flex-wrap gap-1.5">
        <Badge tone="info">{row.requiredPermission}</Badge>
        {row.confirmationRequired ? (
          <Badge tone="warning">
            {t("catalog.features.sourceObservations.ui.governanceControls.confirmationRequired")}
          </Badge>
        ) : (
          <Badge tone="neutral">{t("catalog.features.sourceObservations.ui.governanceControls.noConfirmation")}</Badge>
        )}
      </div>
    ),
  },
  {
    key: "state",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.state"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.state"),
    cell: (row) => (
      <div className="grid gap-1">
        <Badge tone={actionTone(row.state)}>{stateLabel(row.state)}</Badge>
        <span className="text-xs leading-5 text-secondary">{row.deniedCopy}</span>
        <BlockerBadges blockers={row.blockers} />
      </div>
    ),
  },
];

const observabilityColumns: DataColumn<GovernanceSignal>[] = [
  {
    key: "signal",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.signal"),
    sortable: true,
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{row.label}</span>
        <span className="text-xs text-secondary">{row.ownerMetricKey}</span>
      </div>
    ),
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.status"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.status"),
    cell: (row) => (
      <div className="grid gap-1">
        <Badge tone={statusTone(row.status)}>{stateLabel(row.status)}</Badge>
        {row.stale ? (
          <Badge tone="warning">{t("catalog.features.sourceObservations.ui.governanceControls.staleEvidence")}</Badge>
        ) : null}
      </div>
    ),
  },
  {
    key: "value",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.value"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.value"),
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm text-foreground">{row.value}</span>
        <span className="text-xs leading-5 text-secondary">{row.threshold}</span>
      </div>
    ),
  },
  {
    key: "links",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.alertRunbook"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.alertRunbook"),
    align: "right",
    cell: (row) => (
      <div className="grid justify-items-end gap-1">
        {[...row.alertLinks, ...row.runbookLinks].map((link) => (
          <a key={link.label} className="text-sm font-semibold text-accent hover:underline" href={link.href}>
            {link.label}
          </a>
        ))}
      </div>
    ),
  },
];

const removalColumns: DataColumn<GovernanceRemovalEvidence>[] = [
  {
    key: "surface",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.surface"),
    sortable: true,
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{row.label}</span>
        <span className="text-xs leading-5 text-secondary">{row.detail}</span>
      </div>
    ),
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.status"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.status"),
    cell: (row) => <Badge tone="danger">{stateLabel(row.status)}</Badge>,
  },
  {
    key: "evidence",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.evidence"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.evidence"),
    align: "right",
    cell: (row) => (
      <a className="text-sm font-semibold text-accent hover:underline" href={row.evidenceUrl}>
        {t("catalog.features.sourceObservations.ui.governanceControls.openEvidence")}
      </a>
    ),
  },
];

function BlockerBadges({ blockers }: { blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] }) {
  if (blockers.length === 0) {
    return <Badge tone="success">{t("catalog.features.sourceObservations.ui.governanceControls.blockers.none")}</Badge>;
  }

  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {[...new Set(blockers)].map((blocker) => (
        <Badge key={blocker} tone={blockerTone(blocker)}>
          {getCatalogPrimaryWorkbenchBlockerCopy(blocker).label}
        </Badge>
      ))}
    </div>
  );
}

function governanceBannerTitle(governance: GovernanceControls): string {
  if (governance.status === "blocked") {
    return t("catalog.features.sourceObservations.ui.governanceControls.banner.blockedTitle");
  }
  if (governance.status === "ready") {
    return t("catalog.features.sourceObservations.ui.governanceControls.banner.readyTitle");
  }

  return t("catalog.features.sourceObservations.ui.governanceControls.banner.degradedTitle");
}

function governanceBannerDescription(governance: GovernanceControls): string {
  if (governance.status === "blocked") {
    return t("catalog.features.sourceObservations.ui.governanceControls.banner.blockedDescription");
  }
  if (governance.status === "ready") {
    return t("catalog.features.sourceObservations.ui.governanceControls.banner.readyDescription");
  }

  return t("catalog.features.sourceObservations.ui.governanceControls.banner.degradedDescription");
}

function onOff(value: boolean): string {
  return value ? "active" : "clear";
}

function statusTone(status: string): BadgeTone {
  if (status === "ready" || status === "open") {
    return "success";
  }
  if (status === "blocked" || status === "unavailable" || status === "removed") {
    return "danger";
  }
  if (status === "degraded" || status === "stopped" || status === "staged") {
    return "warning";
  }

  return "neutral";
}

function controlTone(status: GovernanceControl["status"]): BadgeTone {
  if (status === "open") {
    return "success";
  }
  if (status === "blocked" || status === "removed") {
    return "danger";
  }

  return "warning";
}

function actionTone(state: CatalogPrimaryWorkbenchActionState): BadgeTone {
  if (state === "available") {
    return "success";
  }
  if (state === "denied" || state === "blocked" || state === "unsafe" || state === "unavailable") {
    return "danger";
  }
  if (state === "degraded") {
    return "warning";
  }

  return "neutral";
}

function blockerTone(blocker: CatalogPrimaryWorkbenchBlockerCategory): BadgeTone {
  const group = getCatalogPrimaryWorkbenchBlockerCopy(blocker).group;
  if (group === "permission" || group === "rollout" || group === "security-privacy" || group === "retirement") {
    return "danger";
  }
  if (group === "provider-transport" || group === "resilience" || group === "job") {
    return "warning";
  }

  return "warning";
}

function stateLabel(value: string): string {
  return value
    .split("-")
    .join(" ")
    .replace(/^\w/, (char) => char.toUpperCase());
}
