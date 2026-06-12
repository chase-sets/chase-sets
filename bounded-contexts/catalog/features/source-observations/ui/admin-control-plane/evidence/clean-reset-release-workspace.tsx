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
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";

type CleanResetRelease = CatalogPrimaryWorkbenchReadModel["cleanResetRelease"];
type CleanResetDecision = CleanResetRelease["decisions"][number];
type CleanResetFinding = CleanResetRelease["resetEvidence"]["findings"][number];
type CleanResetBackfill = CleanResetRelease["backfill"][number];
type CleanResetScaffolding = CleanResetRelease["temporaryScaffolding"][number];
type CleanResetProofLink = CleanResetRelease["releaseProofLinks"][number];
type BadgeTone = "success" | "warning" | "danger" | "neutral" | "info" | "accent";

export function CatalogIntegrationCleanResetReleaseWorkspace({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const cleanReset = readModel.cleanResetRelease;

  return (
    <section className="grid min-w-0 gap-4" data-catalog-clean-reset-release-workspace="true">
      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.cleanResetRelease.title")}
        description={t("catalog.features.sourceObservations.ui.cleanResetRelease.description")}
        status={<Badge tone={statusTone(cleanReset.status)}>{stateLabel(cleanReset.status)}</Badge>}
        actions={
          <div className="flex flex-wrap justify-end gap-2">
            <LinkButton size="sm" tone="secondary" leadingIcon="chevronLeft" href={cleanReset.returnToPrimaryHref}>
              {t("catalog.features.sourceObservations.ui.cleanResetRelease.backToWorkbench")}
            </LinkButton>
            <LinkButton size="sm" tone="secondary" leadingIcon="externalLink" href={cleanReset.auditEvidenceHref}>
              {t("catalog.features.sourceObservations.ui.cleanResetRelease.openAuditEvidence")}
            </LinkButton>
          </div>
        }
        headingLevel={2}
        density="compact"
      >
        <div className="grid gap-4">
          <OperationalStatusBanner
            tone={cleanReset.status === "blocked" ? "danger" : cleanReset.status === "complete" ? "success" : "warning"}
            title={bannerTitle(cleanReset)}
            description={bannerDescription(cleanReset)}
          />
          <MetricStrip
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.cleanResetRelease.metric.decisions"),
                value: String(cleanReset.summary.decisionCount),
                trend: `${cleanReset.summary.blockingDecisionCount} ${t(
                  "catalog.features.sourceObservations.ui.cleanResetRelease.metric.blocking",
                )}`,
              },
              {
                label: t("catalog.features.sourceObservations.ui.cleanResetRelease.metric.findings"),
                value: String(cleanReset.summary.findingCount),
                trend: `${cleanReset.summary.p0FindingCount} P0`,
              },
              {
                label: t("catalog.features.sourceObservations.ui.cleanResetRelease.metric.tables"),
                value: String(cleanReset.summary.targetTableCount),
                trend: cleanReset.environment,
              },
              {
                label: t("catalog.features.sourceObservations.ui.cleanResetRelease.metric.scaffolding"),
                value: String(cleanReset.summary.temporaryScaffoldingRemovalRequiredCount),
                trend: t("catalog.features.sourceObservations.ui.cleanResetRelease.metric.mustRemove"),
              },
            ]}
          />
          <KeyValueList
            density="compact"
            layout="grid"
            items={[
              {
                key: t("catalog.features.sourceObservations.ui.cleanResetRelease.key.mode"),
                value: cleanReset.environmentPlan.mode,
              },
              {
                key: t("catalog.features.sourceObservations.ui.cleanResetRelease.key.environment"),
                value: cleanReset.environment,
              },
              {
                key: t("catalog.features.sourceObservations.ui.cleanResetRelease.key.backup"),
                value: String(cleanReset.environmentPlan.requiresBackupDecision),
              },
              {
                key: t("catalog.features.sourceObservations.ui.cleanResetRelease.key.approval"),
                value: String(cleanReset.environmentPlan.requiresApprovalReference),
              },
              {
                key: t("catalog.features.sourceObservations.ui.cleanResetRelease.key.boundary"),
                value: cleanReset.environmentPlan.unrelatedDataBoundary,
              },
            ]}
          />
        </div>
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.cleanResetRelease.decisions.title")}
        description={t("catalog.features.sourceObservations.ui.cleanResetRelease.decisions.description")}
        status={
          <Badge tone={cleanReset.summary.blockingDecisionCount > 0 ? "danger" : "success"}>
            {cleanReset.summary.blockingDecisionCount}
          </Badge>
        }
        density="compact"
      >
        <DataTable
          rows={[...cleanReset.decisions]}
          columns={decisionColumns}
          getRowId={(decision) => decision.key}
          density="compact"
        />
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.cleanResetRelease.findings.title")}
        description={t("catalog.features.sourceObservations.ui.cleanResetRelease.findings.description")}
        status={
          <Badge tone={cleanReset.resetEvidence.findings.length > 0 ? "danger" : "success"}>
            {cleanReset.resetEvidence.findings.length}
          </Badge>
        }
        density="compact"
      >
        {cleanReset.resetEvidence.findings.length > 0 ? (
          <DataTable
            rows={[...cleanReset.resetEvidence.findings]}
            columns={findingColumns}
            getRowId={(finding) => finding.code}
            density="compact"
          />
        ) : (
          <EmptyState
            title={t("catalog.features.sourceObservations.ui.cleanResetRelease.findings.emptyTitle")}
            description={t("catalog.features.sourceObservations.ui.cleanResetRelease.findings.emptyDescription")}
          />
        )}
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.cleanResetRelease.backfill.title")}
        description={t("catalog.features.sourceObservations.ui.cleanResetRelease.backfill.description")}
        status={
          <Badge tone={cleanReset.summary.backfillRequiredCount > 0 ? "warning" : "success"}>
            {cleanReset.summary.backfillRequiredCount}
          </Badge>
        }
        density="compact"
      >
        <DataTable
          rows={[...cleanReset.backfill]}
          columns={backfillColumns}
          getRowId={(row) => row.key}
          density="compact"
        />
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.cleanResetRelease.scaffolding.title")}
        description={t("catalog.features.sourceObservations.ui.cleanResetRelease.scaffolding.description")}
        status={
          <Badge tone={cleanReset.summary.temporaryScaffoldingRemovalRequiredCount > 0 ? "danger" : "success"}>
            {cleanReset.summary.temporaryScaffoldingRemovalRequiredCount}
          </Badge>
        }
        density="compact"
      >
        <DataTable
          rows={[...cleanReset.temporaryScaffolding]}
          columns={scaffoldingColumns}
          getRowId={(row) => row.key}
          density="compact"
        />
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.cleanResetRelease.links.title")}
        description={t("catalog.features.sourceObservations.ui.cleanResetRelease.links.description")}
        status={<Badge tone="neutral">{cleanReset.releaseProofLinks.length}</Badge>}
        density="compact"
      >
        <DataTable
          rows={[...cleanReset.releaseProofLinks]}
          columns={proofLinkColumns}
          getRowId={(row) => row.key}
          density="compact"
        />
      </WorkflowModule>
    </section>
  );
}

const decisionColumns: DataColumn<CleanResetDecision>[] = [
  {
    key: "decision",
    header: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.decision"),
    sortable: true,
    cell: (decision) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{decision.label}</span>
        <span className="text-xs text-secondary">{decision.key}</span>
      </div>
    ),
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.status"),
    mobileLabel: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.status"),
    cell: (decision) => <Badge tone={statusTone(decision.status)}>{stateLabel(decision.status)}</Badge>,
  },
  {
    key: "owner",
    header: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.owner"),
    mobileLabel: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.owner"),
    cell: (decision) => `${decision.owner} ${decision.ownerIssue}`,
  },
  {
    key: "evidence",
    header: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.evidence"),
    mobileLabel: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.evidence"),
    cell: (decision) => (
      <div className="grid gap-1">
        <span className="text-sm text-foreground">{decision.evidence}</span>
        <span className="text-xs text-secondary">{decision.requiredEvidence.join("; ")}</span>
      </div>
    ),
  },
  {
    key: "release",
    header: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.release"),
    mobileLabel: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.release"),
    cell: (decision) => (
      <Badge tone={decision.blocksRelease ? "danger" : "success"}>
        {decision.blocksRelease
          ? t("catalog.features.sourceObservations.ui.cleanResetRelease.blocksRelease")
          : t("catalog.features.sourceObservations.ui.cleanResetRelease.nonBlocking")}
      </Badge>
    ),
  },
];

const findingColumns: DataColumn<CleanResetFinding>[] = [
  {
    key: "finding",
    header: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.finding"),
    sortable: true,
    cell: (finding) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{finding.code}</span>
        <span className="text-xs text-secondary">{finding.message}</span>
      </div>
    ),
  },
  {
    key: "severity",
    header: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.severity"),
    mobileLabel: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.severity"),
    cell: (finding) => <Badge tone={finding.severity === "p0" ? "danger" : "warning"}>{finding.severity}</Badge>,
  },
];

const backfillColumns: DataColumn<CleanResetBackfill>[] = [
  {
    key: "backfill",
    header: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.backfill"),
    sortable: true,
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{row.key}</span>
        <span className="text-xs text-secondary">{row.reason}</span>
      </div>
    ),
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.status"),
    mobileLabel: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.status"),
    cell: (row) => <Badge tone={statusTone(row.status)}>{stateLabel(row.status)}</Badge>,
  },
  {
    key: "evidence",
    header: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.evidence"),
    mobileLabel: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.evidence"),
    cell: (row) => row.evidence,
  },
];

const scaffoldingColumns: DataColumn<CleanResetScaffolding>[] = [
  {
    key: "scaffold",
    header: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.scaffolding"),
    sortable: true,
    cell: (row) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{row.label}</span>
        <span className="text-xs text-secondary">{row.key}</span>
      </div>
    ),
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.status"),
    mobileLabel: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.status"),
    cell: (row) => <Badge tone={statusTone(row.status)}>{stateLabel(row.status)}</Badge>,
  },
  {
    key: "owner",
    header: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.owner"),
    mobileLabel: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.owner"),
    cell: (row) => row.ownerIssue,
  },
  {
    key: "removal",
    header: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.removal"),
    mobileLabel: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.removal"),
    cell: (row) => (
      <div className="grid gap-1">
        <span className="text-sm text-foreground">{row.removalEvidence}</span>
        <LinkButton size="sm" tone="secondary" leadingIcon="externalLink" href={row.evidenceUrl}>
          {t("catalog.features.sourceObservations.ui.cleanResetRelease.openEvidence")}
        </LinkButton>
      </div>
    ),
  },
];

const proofLinkColumns: DataColumn<CleanResetProofLink>[] = [
  {
    key: "link",
    header: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.proof"),
    sortable: true,
    cell: (row) => (
      <div className="grid gap-1">
        <LinkButton size="sm" tone="secondary" leadingIcon="externalLink" href={row.href}>
          {row.label}
        </LinkButton>
        <span className="text-xs text-secondary">{row.summary}</span>
      </div>
    ),
  },
  {
    key: "kind",
    header: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.kind"),
    mobileLabel: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.kind"),
    cell: (row) => <Badge tone="neutral">{row.kind}</Badge>,
  },
  {
    key: "redaction",
    header: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.redaction"),
    mobileLabel: t("catalog.features.sourceObservations.ui.cleanResetRelease.table.redaction"),
    cell: (row) => <Badge tone="success">{row.redactionState}</Badge>,
  },
];

function bannerTitle(cleanReset: CleanResetRelease): string {
  if (cleanReset.status === "blocked") {
    return t("catalog.features.sourceObservations.ui.cleanResetRelease.banner.blocked.title");
  }
  if (cleanReset.status === "complete") {
    return t("catalog.features.sourceObservations.ui.cleanResetRelease.banner.complete.title");
  }

  return t("catalog.features.sourceObservations.ui.cleanResetRelease.banner.partial.title");
}

function bannerDescription(cleanReset: CleanResetRelease): string {
  if (cleanReset.status === "blocked") {
    return t("catalog.features.sourceObservations.ui.cleanResetRelease.banner.blocked.description", {
      count: String(cleanReset.summary.findingCount + cleanReset.summary.blockingDecisionCount),
    });
  }
  if (cleanReset.status === "complete") {
    return t("catalog.features.sourceObservations.ui.cleanResetRelease.banner.complete.description");
  }

  return t("catalog.features.sourceObservations.ui.cleanResetRelease.banner.partial.description");
}

function statusTone(status: string): BadgeTone {
  if (
    status === "complete" ||
    status === "ready" ||
    status === "removed" ||
    status === "not-used" ||
    status === "skipped-clean-reset"
  ) {
    return "success";
  }
  if (status === "blocked" || status === "removal-required") {
    return "danger";
  }
  if (status === "missing" || status === "required" || status === "partial") {
    return "warning";
  }

  return "neutral";
}

function stateLabel(value: string): string {
  return value.replace(/-/g, " ");
}
