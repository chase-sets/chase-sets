import {
  Badge,
  DataTable,
  EmptyState,
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

type ConflictResolution = CatalogPrimaryWorkbenchReadModel["conflictResolution"];
type ConflictRow = ConflictResolution["rows"][number];
type PrecedenceRule = ConflictResolution["precedenceRules"][number];
type AuditEvent = ConflictResolution["recentAuditEvents"][number];
type BadgeTone = "success" | "warning" | "danger" | "neutral" | "info" | "accent";

export function CatalogIntegrationConflictResolutionWorkspace({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const conflicts = readModel.conflictResolution;

  return (
    <section className="grid min-w-0 gap-4" data-catalog-conflict-resolution-workspace="true">
      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.conflictResolution.title")}
        description={t("catalog.features.sourceObservations.ui.conflictResolution.description")}
        status={<Badge tone={statusTone(conflicts.status)}>{stateLabel(conflicts.status)}</Badge>}
        actions={
          <LinkButton size="sm" tone="secondary" leadingIcon="chevronLeft" href={conflicts.returnToPrimaryHref}>
            {t("catalog.features.sourceObservations.ui.conflictResolution.backToWorkbench")}
          </LinkButton>
        }
        headingLevel={2}
        density="compact"
      >
        <div className="grid gap-4">
          <OperationalStatusBanner
            tone={conflicts.status === "blocked" ? "danger" : conflicts.status === "empty" ? "success" : "warning"}
            title={conflictBannerTitle(conflicts)}
            description={conflictBannerDescription(conflicts)}
          />
          <MetricStrip
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.conflictResolution.metric.conflicts"),
                value: String(conflicts.summary.conflictCount),
                trend: `${conflicts.summary.reviewRequiredCount} ${t(
                  "catalog.features.sourceObservations.ui.conflictResolution.metric.reviewRequired",
                )}`,
              },
              {
                label: t("catalog.features.sourceObservations.ui.conflictResolution.metric.blocking"),
                value: String(conflicts.summary.blockingCount),
                trend: `${conflicts.summary.autoResolvedCount} ${t(
                  "catalog.features.sourceObservations.ui.conflictResolution.metric.autoResolved",
                )}`,
              },
              {
                label: t("catalog.features.sourceObservations.ui.conflictResolution.metric.overrides"),
                value: String(conflicts.summary.overrideAvailableCount),
                trend: stateLabel(conflicts.overridePolicy.state),
              },
              {
                label: t("catalog.features.sourceObservations.ui.conflictResolution.metric.audit"),
                value: String(conflicts.summary.auditEventCount),
                trend: conflicts.freshness,
              },
            ]}
          />
        </div>
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.conflictResolution.conflicts.title")}
        description={t("catalog.features.sourceObservations.ui.conflictResolution.conflicts.description")}
        status={<Badge tone="neutral">{conflicts.rows.length}</Badge>}
        density="compact"
      >
        {conflicts.rows.length > 0 ? (
          <DataTable
            rows={[...conflicts.rows]}
            columns={conflictColumns}
            getRowId={(row) => row.observationId}
            density="compact"
          />
        ) : (
          <EmptyState
            title={t("catalog.features.sourceObservations.ui.conflictResolution.conflicts.emptyTitle")}
            description={t("catalog.features.sourceObservations.ui.conflictResolution.conflicts.emptyDescription")}
          />
        )}
      </WorkflowModule>

      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <WorkflowModule
          title={t("catalog.features.sourceObservations.ui.conflictResolution.rules.title")}
          description={t("catalog.features.sourceObservations.ui.conflictResolution.rules.description")}
          status={<Badge tone="neutral">{conflicts.precedenceRules.length}</Badge>}
          density="compact"
        >
          {conflicts.precedenceRules.length > 0 ? (
            <DataTable
              rows={[...conflicts.precedenceRules]}
              columns={ruleColumns}
              getRowId={(rule) => rule.ruleId}
              density="compact"
            />
          ) : (
            <EmptyState
              title={t("catalog.features.sourceObservations.ui.conflictResolution.rules.emptyTitle")}
              description={t("catalog.features.sourceObservations.ui.conflictResolution.rules.emptyDescription")}
            />
          )}
        </WorkflowModule>

        <WorkflowModule
          title={t("catalog.features.sourceObservations.ui.conflictResolution.override.title")}
          description={t("catalog.features.sourceObservations.ui.conflictResolution.override.description")}
          status={
            <Badge tone={actionTone(conflicts.overridePolicy.state)}>
              {stateLabel(conflicts.overridePolicy.state)}
            </Badge>
          }
          density="compact"
        >
          <div className="grid gap-4">
            <OperationalStatusBanner
              tone={conflicts.overridePolicy.supported ? "warning" : "danger"}
              title={t("catalog.features.sourceObservations.ui.conflictResolution.override.banner.title")}
              description={conflicts.overridePolicy.reason}
            />
            <KeyValueList
              density="compact"
              layout="grid"
              items={[
                {
                  key: t("catalog.features.sourceObservations.ui.conflictResolution.override.key.permission"),
                  value: conflicts.overridePolicy.requiredPermission,
                },
                {
                  key: t("catalog.features.sourceObservations.ui.conflictResolution.override.key.audit"),
                  value: conflicts.overridePolicy.auditRequired
                    ? t("catalog.features.sourceObservations.ui.conflictResolution.override.audit.required")
                    : t("catalog.features.sourceObservations.ui.primaryWorkbench.none"),
                },
              ]}
            />
            <BlockerBadges blockers={conflicts.overridePolicy.blockers} />
          </div>
        </WorkflowModule>
      </div>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.conflictResolution.audit.title")}
        description={t("catalog.features.sourceObservations.ui.conflictResolution.audit.description")}
        status={<Badge tone="neutral">{conflicts.recentAuditEvents.length}</Badge>}
        density="compact"
      >
        {conflicts.recentAuditEvents.length > 0 ? (
          <DataTable
            rows={[...conflicts.recentAuditEvents]}
            columns={auditColumns}
            getRowId={(event) => event.eventId}
            density="compact"
          />
        ) : (
          <EmptyState
            title={t("catalog.features.sourceObservations.ui.conflictResolution.audit.emptyTitle")}
            description={t("catalog.features.sourceObservations.ui.conflictResolution.audit.emptyDescription")}
          />
        )}
      </WorkflowModule>
    </section>
  );
}

const conflictColumns: DataColumn<ConflictRow>[] = [
  {
    key: "fact",
    header: t("catalog.features.sourceObservations.ui.conflictResolution.table.fact"),
    sortable: true,
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{row.affectedFact}</span>
        <span className="text-xs text-secondary">
          {row.displayName} - {row.externalKey}
        </span>
      </div>
    ),
  },
  {
    key: "state",
    header: t("catalog.features.sourceObservations.ui.conflictResolution.table.state"),
    mobileLabel: t("catalog.features.sourceObservations.ui.conflictResolution.table.state"),
    cell: (row) => <Badge tone={resolutionTone(row.resolutionState)}>{stateLabel(row.resolutionState)}</Badge>,
  },
  {
    key: "values",
    header: t("catalog.features.sourceObservations.ui.conflictResolution.table.values"),
    mobileLabel: t("catalog.features.sourceObservations.ui.conflictResolution.table.values"),
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        {row.candidateValues.slice(0, 3).map((candidate) => (
          <span
            key={`${row.observationId}-${candidate.evidencePath}-${candidate.role}`}
            className="text-xs text-secondary"
          >
            {candidate.source}: {candidate.value} ({stateLabel(candidate.role)})
          </span>
        ))}
      </div>
    ),
  },
  {
    key: "rule",
    header: t("catalog.features.sourceObservations.ui.conflictResolution.table.rule"),
    mobileLabel: t("catalog.features.sourceObservations.ui.conflictResolution.table.rule"),
    cell: (row) => row.precedenceRuleId,
  },
  {
    key: "detail",
    header: t("catalog.features.sourceObservations.ui.conflictResolution.table.action"),
    mobileLabel: t("catalog.features.sourceObservations.ui.conflictResolution.table.action"),
    align: "right",
    cell: (row) => (
      <LinkButton size="sm" tone="secondary" href={row.detailHref}>
        {t("catalog.features.sourceObservations.ui.conflictResolution.table.openEvidence")}
      </LinkButton>
    ),
  },
];

const ruleColumns: DataColumn<PrecedenceRule>[] = [
  {
    key: "rule",
    header: t("catalog.features.sourceObservations.ui.conflictResolution.table.rule"),
    sortable: true,
    cell: (rule) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{rule.label}</span>
        <span className="text-xs text-secondary">{rule.ruleId}</span>
      </div>
    ),
  },
  {
    key: "behavior",
    header: t("catalog.features.sourceObservations.ui.conflictResolution.table.behavior"),
    mobileLabel: t("catalog.features.sourceObservations.ui.conflictResolution.table.behavior"),
    cell: (rule) => <Badge tone={behaviorTone(rule.blockingBehavior)}>{stateLabel(rule.blockingBehavior)}</Badge>,
  },
  {
    key: "authority",
    header: t("catalog.features.sourceObservations.ui.conflictResolution.table.authority"),
    mobileLabel: t("catalog.features.sourceObservations.ui.conflictResolution.table.authority"),
    cell: (rule) => rule.sourceAuthority,
  },
];

const auditColumns: DataColumn<AuditEvent>[] = [
  {
    key: "event",
    header: t("catalog.features.sourceObservations.ui.conflictResolution.table.event"),
    sortable: true,
    cell: (event) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{event.eventName}</span>
        <span className="text-xs text-secondary">{event.summary}</span>
      </div>
    ),
  },
  {
    key: "provider",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.provider"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.provider"),
    cell: (event) => event.providerKey,
  },
  {
    key: "occurred",
    header: t("catalog.features.sourceObservations.ui.conflictResolution.table.occurred"),
    mobileLabel: t("catalog.features.sourceObservations.ui.conflictResolution.table.occurred"),
    cell: (event) => formatDateTime(event.occurredAt),
  },
];

function BlockerBadges({ blockers }: { blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] }) {
  if (blockers.length === 0) {
    return <Badge tone="success">{t("catalog.features.sourceObservations.ui.conflictResolution.blockers.none")}</Badge>;
  }

  return (
    <div className="grid min-w-0 gap-2">
      <h3 className="text-sm font-semibold text-foreground">
        {t("catalog.features.sourceObservations.ui.conflictResolution.blockers.title")}
      </h3>
      <div className="grid min-w-0 gap-2">
        {[...new Set(blockers)].map((blocker) => {
          const copy = getCatalogPrimaryWorkbenchBlockerCopy(blocker);
          return (
            <div key={blocker} className="grid min-w-0 gap-1">
              <Badge tone={blockerTone(blocker)}>{copy.label}</Badge>
              <span className="text-xs leading-5 text-secondary">{copy.reason}</span>
              <span className="text-xs leading-5 text-secondary">{copy.nextStep}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function conflictBannerTitle(conflicts: ConflictResolution): string {
  if (conflicts.status === "blocked") {
    return t("catalog.features.sourceObservations.ui.conflictResolution.banner.blockedTitle");
  }
  if (conflicts.status === "empty") {
    return t("catalog.features.sourceObservations.ui.conflictResolution.banner.emptyTitle");
  }
  if (conflicts.status === "ready") {
    return t("catalog.features.sourceObservations.ui.conflictResolution.banner.readyTitle");
  }

  return t("catalog.features.sourceObservations.ui.conflictResolution.banner.unavailableTitle");
}

function conflictBannerDescription(conflicts: ConflictResolution): string {
  if (conflicts.status === "blocked") {
    return t("catalog.features.sourceObservations.ui.conflictResolution.banner.blockedDescription");
  }
  if (conflicts.status === "empty") {
    return t("catalog.features.sourceObservations.ui.conflictResolution.banner.emptyDescription");
  }
  if (conflicts.status === "ready") {
    return t("catalog.features.sourceObservations.ui.conflictResolution.banner.readyDescription");
  }

  return t("catalog.features.sourceObservations.ui.conflictResolution.banner.unavailableDescription");
}

function statusTone(status: ConflictResolution["status"]): BadgeTone {
  if (status === "ready" || status === "empty") {
    return "success";
  }
  if (status === "blocked") {
    return "danger";
  }

  return "warning";
}

function resolutionTone(state: ConflictRow["resolutionState"]): BadgeTone {
  if (state === "auto-resolved") {
    return "success";
  }
  if (state === "blocks-promotion") {
    return "danger";
  }

  return "warning";
}

function behaviorTone(state: PrecedenceRule["blockingBehavior"]): BadgeTone {
  if (state === "auto-resolved") {
    return "success";
  }
  if (state === "promotion-blocking") {
    return "danger";
  }

  return "warning";
}

function actionTone(state: CatalogPrimaryWorkbenchActionState): BadgeTone {
  if (state === "available") {
    return "success";
  }
  if (state === "denied" || state === "unsafe" || state === "blocked" || state === "unavailable") {
    return "danger";
  }
  if (state === "degraded") {
    return "warning";
  }

  return "neutral";
}

function blockerTone(blocker: CatalogPrimaryWorkbenchBlockerCategory): BadgeTone {
  const group = getCatalogPrimaryWorkbenchBlockerCopy(blocker).group;
  if (group === "permission" || group === "security-privacy" || group === "retirement") {
    return "danger";
  }
  if (group === "promotion") {
    return "danger";
  }

  return blocker.includes("conflict") ? "warning" : "neutral";
}

function stateLabel(state: string): string {
  return state
    .split("-")
    .join(" ")
    .replace(/^\w/, (char) => char.toUpperCase());
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return t("catalog.features.sourceObservations.ui.conflictResolution.audit.notRecorded");
  }
  try {
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}
