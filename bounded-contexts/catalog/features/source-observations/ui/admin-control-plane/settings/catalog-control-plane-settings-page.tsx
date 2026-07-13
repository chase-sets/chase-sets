import {
  Badge,
  BadgeCluster,
  DataTable,
  KeyValueList,
  LinkText,
  MetricStrip,
  OperationalStatusBanner,
  StatusReasonList,
  WorkbenchActionRow,
  WorkbenchDataCell,
  WorkbenchLinkList,
  WorkbenchStack,
  WorkbenchText,
  WorkbenchValueList,
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
import { CatalogControlPlaneEvidenceDrawer } from "../evidence/catalog-control-plane-evidence-drawer";

type GovernanceControls = CatalogPrimaryWorkbenchReadModel["governanceControls"];
type GovernanceControl = GovernanceControls["controls"][number];
type GovernanceRbacRow = GovernanceControls["rbacMatrix"][number];
type GovernanceSignal = GovernanceControls["observability"]["signals"][number];
type GovernanceRemovalEvidence = GovernanceControls["legacyRemovalEvidence"]["evidence"][number];
type BadgeTone = "success" | "warning" | "danger" | "neutral" | "info" | "accent";

// The Catalog integration control-plane Settings page. Governance becomes
// Settings: RBAC, rollout mode, kill switches, and observability signal
// ownership are read-mostly configuration an operator visits rarely, so they
// render here — with an Evidence drawer for audit traceability instead of the
// old standalone audit-evidence workspace, and the manage-permission gates on
// mutations unchanged.
//
// This surface still hosts the lifecycle-recovery workspace (rollback, retire,
// deprecate) alongside these controls, pending its move to the provider-detail
// page in a follow-on slice; the workspaces below are the Settings-owned part.
export function CatalogControlPlaneSettingsPage({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const governance = readModel.governanceControls;

  return (
    <WorkbenchStack
      element="section"
      data-catalog-control-plane-settings-page="true"
      data-catalog-governance-controls-workspace="true"
    >
      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.governanceControls.title")}
        description={t("catalog.features.sourceObservations.ui.governanceControls.description")}
        status={<Badge tone={statusTone(governance.status)}>{stateLabel(governance.status)}</Badge>}
        headingLevel={2}
        density="compact"
      >
        <WorkbenchStack>
          <OperationalStatusBanner
            tone={governance.status === "blocked" ? "danger" : governance.status === "ready" ? "success" : "warning"}
            title={governanceBannerTitle(governance)}
            description={governanceBannerDescription(governance)}
          />
          <WorkbenchActionRow align="between">
            <WorkbenchText size="sm">
              {t("catalog.features.sourceObservations.ui.auditEvidence.description")}
            </WorkbenchText>
            <CatalogControlPlaneEvidenceDrawer auditEvidence={readModel.auditEvidence} />
          </WorkbenchActionRow>
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
        </WorkbenchStack>
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
          caption={t("catalog.features.sourceObservations.ui.governanceControls.controls.title")}
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
          caption={t("catalog.features.sourceObservations.ui.governanceControls.rbac.title")}
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
          caption={t("catalog.features.sourceObservations.ui.governanceControls.observability.title")}
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
        <WorkbenchStack>
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
            caption={t("catalog.features.sourceObservations.ui.governanceControls.removal.title")}
            getRowId={(row) => row.key}
            density="compact"
          />
        </WorkbenchStack>
      </WorkflowModule>
    </WorkbenchStack>
  );
}

const controlColumns: DataColumn<GovernanceControl>[] = [
  {
    key: "control",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.control"),
    sortable: true,
    cell: (row) => <WorkbenchDataCell title={row.label} description={row.controlId} detail={row.message} />,
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.status"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.status"),
    cell: (row) => (
      <WorkbenchStack gap="sm">
        <Badge tone={controlTone(row.status)}>{stateLabel(row.status)}</Badge>
        <BlockerBadges blockers={row.blockers} />
      </WorkbenchStack>
    ),
  },
  {
    key: "metric",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.metric"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.metric"),
    cell: (row) => <WorkbenchDataCell title={row.metricKey} titleWeight="regular" />,
  },
  {
    key: "scope",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.scope"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.scope"),
    cell: (row) => (
      <WorkbenchValueList>
        <WorkbenchText size="xs">{row.commandKeys.join(", ") || "deletion evidence"}</WorkbenchText>
        <WorkbenchText size="xs">{row.providerKeys.join(", ") || "all providers"}</WorkbenchText>
        <WorkbenchText size="xs">{row.unitKeys.join(", ") || "all units"}</WorkbenchText>
      </WorkbenchValueList>
    ),
  },
  {
    key: "evidence",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.evidence"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.evidence"),
    align: "right",
    cell: (row) => (
      <LinkText href={row.evidenceUrl}>
        {t("catalog.features.sourceObservations.ui.governanceControls.openEvidence")}
      </LinkText>
    ),
  },
];

const rbacColumns: DataColumn<GovernanceRbacRow>[] = [
  {
    key: "action",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.action"),
    sortable: true,
    cell: (row) => <WorkbenchDataCell title={row.actionKey} description={row.routePattern} />,
  },
  {
    key: "permission",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.permission"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.permission"),
    cell: (row) => (
      <BadgeCluster
        items={[
          { key: "permission", label: row.requiredPermission, tone: "info" },
          {
            key: "confirmation",
            label: row.confirmationRequired
              ? t("catalog.features.sourceObservations.ui.governanceControls.confirmationRequired")
              : t("catalog.features.sourceObservations.ui.governanceControls.noConfirmation"),
            tone: row.confirmationRequired ? "warning" : "neutral",
          },
        ]}
      />
    ),
  },
  {
    key: "state",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.state"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.state"),
    cell: (row) => (
      <WorkbenchStack gap="sm">
        <Badge tone={actionTone(row.state)}>{stateLabel(row.state)}</Badge>
        <WorkbenchText size="xs">{row.deniedCopy}</WorkbenchText>
        <BlockerBadges blockers={row.blockers} />
      </WorkbenchStack>
    ),
  },
];

const observabilityColumns: DataColumn<GovernanceSignal>[] = [
  {
    key: "signal",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.signal"),
    sortable: true,
    cell: (row) => <WorkbenchDataCell title={row.label} description={row.ownerMetricKey} />,
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.status"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.status"),
    cell: (row) => (
      <BadgeCluster
        items={[
          { key: "status", label: stateLabel(row.status), tone: statusTone(row.status) },
          ...(row.stale
            ? [
                {
                  key: "stale",
                  label: t("catalog.features.sourceObservations.ui.governanceControls.staleEvidence"),
                  tone: "warning" as const,
                },
              ]
            : []),
        ]}
      />
    ),
  },
  {
    key: "value",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.value"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.value"),
    cell: (row) => <WorkbenchDataCell title={row.value} titleWeight="regular" detail={row.threshold} />,
  },
  {
    key: "links",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.alertRunbook"),
    mobileLabel: t("catalog.features.sourceObservations.ui.governanceControls.table.alertRunbook"),
    align: "right",
    cell: (row) => (
      <WorkbenchLinkList align="end">
        {[...row.alertLinks, ...row.runbookLinks].map((link) => (
          <LinkText key={link.label} href={link.href}>
            {link.label}
          </LinkText>
        ))}
      </WorkbenchLinkList>
    ),
  },
];

const removalColumns: DataColumn<GovernanceRemovalEvidence>[] = [
  {
    key: "surface",
    header: t("catalog.features.sourceObservations.ui.governanceControls.table.surface"),
    sortable: true,
    cell: (row) => <WorkbenchDataCell title={row.label} detail={row.detail} />,
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
      <LinkText href={row.evidenceUrl}>
        {t("catalog.features.sourceObservations.ui.governanceControls.openEvidence")}
      </LinkText>
    ),
  },
];

function BlockerBadges({ blockers }: { blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] }) {
  if (blockers.length === 0) {
    return <Badge tone="success">{t("catalog.features.sourceObservations.ui.governanceControls.blockers.none")}</Badge>;
  }

  return (
    <StatusReasonList
      compact
      items={[...new Set(blockers)].map((blocker) => {
        const copy = getCatalogPrimaryWorkbenchBlockerCopy(blocker);

        return {
          key: blocker,
          label: copy.label,
          tone: blockerTone(blocker),
        };
      })}
    />
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
