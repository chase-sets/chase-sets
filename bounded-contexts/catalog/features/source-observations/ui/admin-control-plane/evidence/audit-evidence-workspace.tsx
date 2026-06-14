import {
  Badge,
  DataTable,
  EmptyState,
  KeyValueList,
  LinkText,
  MetricStrip,
  OperationalStatusBanner,
  WorkbenchDataCell,
  WorkbenchLinkList,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";

type AuditEvidence = CatalogPrimaryWorkbenchReadModel["auditEvidence"];
type AuditFilter = AuditEvidence["filters"][number];
type AuditTimelineRow = AuditEvidence["timeline"][number];
type AuditEvidenceLink = AuditEvidence["evidenceLinks"][number];
type ReleaseChecklistRow = AuditEvidence["releaseChecklist"][number];
type BadgeTone = "success" | "warning" | "danger" | "neutral" | "info" | "accent";

export function CatalogIntegrationAuditEvidenceWorkspace({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const audit = readModel.auditEvidence;

  return (
    <WorkbenchStack element="section" data-catalog-audit-evidence-workspace="true">
      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.auditEvidence.title")}
        description={t("catalog.features.sourceObservations.ui.auditEvidence.description")}
        status={<Badge tone={statusTone(audit.status)}>{stateLabel(audit.status)}</Badge>}
        headingLevel={2}
        density="compact"
      >
        <WorkbenchStack>
          <OperationalStatusBanner
            tone={audit.status === "blocked" ? "danger" : audit.status === "ready" ? "success" : "warning"}
            title={auditBannerTitle(audit)}
            description={auditBannerDescription(audit)}
          />
          <MetricStrip
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.auditEvidence.metric.timeline"),
                value: String(audit.summary.timelineEvents),
                trend: audit.freshness,
              },
              {
                label: t("catalog.features.sourceObservations.ui.auditEvidence.metric.links"),
                value: String(audit.summary.redactedEvidenceLinks),
                trend: t("catalog.features.sourceObservations.ui.auditEvidence.metric.linksTrend"),
              },
              {
                label: t("catalog.features.sourceObservations.ui.auditEvidence.metric.checklist"),
                value: String(audit.summary.releaseChecklistItems),
                trend: `${audit.summary.missingEvidence} ${t(
                  "catalog.features.sourceObservations.ui.auditEvidence.metric.missing",
                )}`,
              },
              {
                label: t("catalog.features.sourceObservations.ui.auditEvidence.metric.projection"),
                value: String(audit.summary.partialProjectionCount),
                trend: audit.projectionState.queryKey,
              },
            ]}
          />
          <KeyValueList
            density="compact"
            layout="grid"
            items={[
              {
                key: t("catalog.features.sourceObservations.ui.auditEvidence.key.projection"),
                value: audit.projectionState.statusMessage,
              },
              {
                key: t("catalog.features.sourceObservations.ui.auditEvidence.key.generatedAt"),
                value:
                  audit.projectionState.generatedAt ??
                  t("catalog.features.sourceObservations.ui.primaryWorkbench.none"),
              },
              {
                key: t("catalog.features.sourceObservations.ui.auditEvidence.key.sourcePayload"),
                value: audit.redactionPolicy.sourcePayloadAccess,
              },
              {
                key: t("catalog.features.sourceObservations.ui.auditEvidence.key.profileSnapshot"),
                value: audit.redactionPolicy.profileSnapshotAccess,
              },
              {
                key: t("catalog.features.sourceObservations.ui.auditEvidence.key.forbiddenRequests"),
                value: audit.redactionPolicy.forbiddenEvidenceRequests.join(", "),
              },
            ]}
          />
        </WorkbenchStack>
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.auditEvidence.filters.title")}
        description={t("catalog.features.sourceObservations.ui.auditEvidence.filters.description")}
        status={<Badge tone="neutral">{audit.filters.filter((filter) => filter.active).length}</Badge>}
        density="compact"
      >
        <DataTable
          rows={[...audit.filters]}
          columns={filterColumns}
          getRowId={(filter) => filter.key}
          density="compact"
          emptyTitle={t("catalog.features.sourceObservations.ui.auditEvidence.filters.emptyTitle")}
          emptyDescription={t("catalog.features.sourceObservations.ui.auditEvidence.filters.emptyDescription")}
        />
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.auditEvidence.timeline.title")}
        description={t("catalog.features.sourceObservations.ui.auditEvidence.timeline.description")}
        status={<Badge tone={statusTone(audit.status)}>{audit.timeline.length}</Badge>}
        density="compact"
      >
        {audit.timeline.length > 0 ? (
          <DataTable
            rows={[...audit.timeline]}
            columns={timelineColumns}
            getRowId={(row) => row.eventId}
            density="compact"
          />
        ) : (
          <EmptyState
            title={t("catalog.features.sourceObservations.ui.auditEvidence.timeline.emptyTitle")}
            description={t("catalog.features.sourceObservations.ui.auditEvidence.timeline.emptyDescription")}
          />
        )}
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.auditEvidence.links.title")}
        description={t("catalog.features.sourceObservations.ui.auditEvidence.links.description")}
        status={<Badge tone="neutral">{audit.evidenceLinks.length}</Badge>}
        density="compact"
      >
        <DataTable
          rows={[...audit.evidenceLinks]}
          columns={linkColumns}
          getRowId={(link) => link.key}
          density="compact"
          emptyTitle={t("catalog.features.sourceObservations.ui.auditEvidence.links.emptyTitle")}
          emptyDescription={t("catalog.features.sourceObservations.ui.auditEvidence.links.emptyDescription")}
        />
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.auditEvidence.release.title")}
        description={t("catalog.features.sourceObservations.ui.auditEvidence.release.description")}
        status={<Badge tone={releaseSummaryTone(audit)}>{audit.summary.missingEvidence}</Badge>}
        density="compact"
      >
        <DataTable
          rows={[...audit.releaseChecklist]}
          columns={releaseColumns}
          getRowId={(row) => row.workflowKey}
          density="compact"
          emptyTitle={t("catalog.features.sourceObservations.ui.auditEvidence.release.emptyTitle")}
          emptyDescription={t("catalog.features.sourceObservations.ui.auditEvidence.release.emptyDescription")}
        />
      </WorkflowModule>
    </WorkbenchStack>
  );
}

const filterColumns: DataColumn<AuditFilter>[] = [
  {
    key: "filter",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.filter"),
    sortable: true,
    cell: (filter) => <WorkbenchDataCell title={filter.label} description={filter.key} />,
  },
  {
    key: "value",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.value"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.value"),
    cell: (filter) => filter.value ?? t("catalog.features.sourceObservations.ui.auditEvidence.filters.notApplied"),
  },
  {
    key: "options",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.options"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.options"),
    cell: (filter) =>
      filter.options.length > 0
        ? filter.options.slice(0, 4).join(", ")
        : t("catalog.features.sourceObservations.ui.primaryWorkbench.none"),
  },
  {
    key: "state",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.state"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.state"),
    cell: (filter) => (
      <Badge tone={filter.active ? "accent" : "neutral"}>
        {filter.active
          ? t("catalog.features.sourceObservations.ui.auditEvidence.filters.active")
          : t("catalog.features.sourceObservations.ui.auditEvidence.filters.available")}
      </Badge>
    ),
  },
];

const timelineColumns: DataColumn<AuditTimelineRow>[] = [
  {
    key: "event",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.event"),
    sortable: true,
    cell: (row) => <WorkbenchDataCell title={row.eventName} description={row.eventId} detail={row.occurredAt} />,
  },
  {
    key: "target",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.target"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.target"),
    cell: (row) => (
      <WorkbenchDataCell
        title={row.targetId}
        titleWeight="regular"
        description={stateLabel(row.targetType)}
        detail={row.providerKey ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}
      />
    ),
  },
  {
    key: "category",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.category"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.category"),
    cell: (row) => (
      <WorkbenchStack gap="sm">
        <Badge tone={categoryTone(row.category)}>{stateLabel(row.category)}</Badge>
        <WorkbenchText size="xs">{row.actorLabel}</WorkbenchText>
      </WorkbenchStack>
    ),
  },
  {
    key: "summary",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.summary"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.summary"),
    cell: (row) => (
      <WorkbenchDataCell
        title={row.summary}
        titleWeight="regular"
        description={
          row.diagnosticCodes.length > 0
            ? row.diagnosticCodes.slice(0, 3).join(", ")
            : t("catalog.features.sourceObservations.ui.primaryWorkbench.none")
        }
      />
    ),
  },
  {
    key: "evidence",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.evidence"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.evidence"),
    align: "right",
    cell: (row) => <EvidenceLinkList links={row.evidenceLinks} />,
  },
];

const linkColumns: DataColumn<AuditEvidenceLink>[] = [
  {
    key: "link",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.evidence"),
    sortable: true,
    cell: (link) => (
      <WorkbenchStack gap="sm">
        <LinkText href={link.href}>{link.label}</LinkText>
        <WorkbenchText size="xs">{link.key}</WorkbenchText>
      </WorkbenchStack>
    ),
  },
  {
    key: "kind",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.kind"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.kind"),
    cell: (link) => <Badge tone={linkTone(link.kind)}>{stateLabel(link.kind)}</Badge>,
  },
  {
    key: "redaction",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.redaction"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.redaction"),
    cell: (link) => (
      <WorkbenchStack gap="sm">
        <Badge tone={redactionTone(link.redactionState)}>{stateLabel(link.redactionState)}</Badge>
        <WorkbenchText size="xs">{link.sourcePayloadAccess}</WorkbenchText>
        <WorkbenchText size="xs">{link.profileSnapshotAccess}</WorkbenchText>
      </WorkbenchStack>
    ),
  },
  {
    key: "summary",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.summary"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.summary"),
    cell: (link) => link.summary,
  },
];

const releaseColumns: DataColumn<ReleaseChecklistRow>[] = [
  {
    key: "workflow",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.workflow"),
    sortable: true,
    cell: (row) => <WorkbenchDataCell title={row.workflowLabel} description={row.workflowKey} detail={row.owner} />,
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.status"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.status"),
    cell: (row) => (
      <WorkbenchStack gap="sm">
        <Badge tone={checklistTone(row.status)}>{stateLabel(row.status)}</Badge>
        <WorkbenchText size="xs">
          {row.blocksRelease
            ? t("catalog.features.sourceObservations.ui.auditEvidence.release.blocks")
            : t("catalog.features.sourceObservations.ui.auditEvidence.release.nonBlocking")}
        </WorkbenchText>
      </WorkbenchStack>
    ),
  },
  {
    key: "requiredEvidence",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.requiredEvidence"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.requiredEvidence"),
    cell: (row) => row.requiredEvidence.slice(0, 4).join(", "),
  },
  {
    key: "proof",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.proof"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.proof"),
    cell: (row) => (
      <WorkbenchStack gap="sm">
        <EvidenceLinkList links={row.proofLinks} />
        <WorkbenchText size="xs">{row.e2eProof}</WorkbenchText>
        <WorkbenchText size="xs">{row.smokeProof}</WorkbenchText>
      </WorkbenchStack>
    ),
  },
  {
    key: "releaseNote",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.releaseNote"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.releaseNote"),
    cell: (row) => (
      <WorkbenchDataCell
        title={row.releaseNote}
        titleWeight="regular"
        description={
          row.residualDebt.length > 0
            ? row.residualDebt.join(", ")
            : t("catalog.features.sourceObservations.ui.auditEvidence.release.noResidualDebt")
        }
        detail={row.tests.slice(0, 2).join(", ")}
      />
    ),
  },
];

function EvidenceLinkList({ links }: Readonly<{ links: readonly AuditEvidenceLink[] }>) {
  return (
    <WorkbenchLinkList align="end">
      {links.slice(0, 2).map((link) => (
        <LinkText key={link.key} href={link.href}>
          {link.label}
        </LinkText>
      ))}
    </WorkbenchLinkList>
  );
}

function auditBannerTitle(audit: AuditEvidence): string {
  if (audit.status === "blocked") {
    return t("catalog.features.sourceObservations.ui.auditEvidence.banner.blocked.title");
  }
  if (audit.status === "unavailable") {
    return t("catalog.features.sourceObservations.ui.auditEvidence.banner.unavailable.title");
  }
  if (audit.status === "partial") {
    return t("catalog.features.sourceObservations.ui.auditEvidence.banner.partial.title");
  }

  return t("catalog.features.sourceObservations.ui.auditEvidence.banner.ready.title");
}

function auditBannerDescription(audit: AuditEvidence): string {
  if (audit.status === "blocked") {
    return t("catalog.features.sourceObservations.ui.auditEvidence.banner.blocked.description");
  }
  if (audit.status === "unavailable") {
    return audit.projectionState.statusMessage;
  }
  if (audit.status === "partial") {
    return t("catalog.features.sourceObservations.ui.auditEvidence.banner.partial.description", {
      count: String(audit.summary.partialProjectionCount),
    });
  }

  return audit.redactionPolicy.summary;
}

function statusTone(status: string): BadgeTone {
  switch (status) {
    case "ready":
    case "not-needed":
      return "success";
    case "partial":
    case "degraded":
    case "missing":
    case "redacted":
      return "warning";
    case "blocked":
    case "unavailable":
    case "excluded":
      return "danger";
    default:
      return "neutral";
  }
}

function categoryTone(category: string): BadgeTone {
  if (category === "promotion" || category === "source-observation" || category === "import-job") {
    return "accent";
  }
  if (category === "diagnostic") {
    return "warning";
  }
  return "neutral";
}

function linkTone(kind: AuditEvidenceLink["kind"]): BadgeTone {
  switch (kind) {
    case "proof":
    case "test":
      return "accent";
    case "diagnostic":
      return "warning";
    case "release-note":
      return "info";
    default:
      return "neutral";
  }
}

function redactionTone(state: AuditEvidenceLink["redactionState"]): BadgeTone {
  return state === "not-needed" ? "success" : state === "excluded" ? "danger" : "warning";
}

function checklistTone(status: ReleaseChecklistRow["status"]): BadgeTone {
  switch (status) {
    case "ready":
      return "success";
    case "partial":
    case "missing":
      return "warning";
    case "blocked":
      return "danger";
  }
}

function releaseSummaryTone(audit: AuditEvidence): BadgeTone {
  return audit.summary.missingEvidence > 0 ? "warning" : "success";
}

function stateLabel(value: string): string {
  return value.replace(/-/g, " ");
}
