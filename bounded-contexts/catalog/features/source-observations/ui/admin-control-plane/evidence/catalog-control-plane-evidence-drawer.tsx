import type { ReactNode } from "react";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  KeyValueList,
  LinkText,
  MetricStrip,
  OperationalStatusBanner,
  SideSheet,
  WorkbenchDataCell,
  WorkbenchLinkList,
  WorkbenchStack,
  WorkbenchText,
  type DataColumn,
} from "@chase-sets/design-system";
import { formatDateTime, t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";

type AuditEvidence = CatalogPrimaryWorkbenchReadModel["auditEvidence"];
type AuditTimelineRow = AuditEvidence["timeline"][number];
type AuditEvidenceLink = AuditEvidence["evidenceLinks"][number];
type BadgeTone = "success" | "warning" | "danger" | "neutral" | "info" | "accent";

// The Evidence drawer — a single component openable from any entity (scope,
// candidate, observation, job, profile version) that shows that entity's audit
// timeline, change attribution, and redaction state. Replaces the standalone
// audit-evidence workspace: this renders the same audit-evidence read model, but
// as a drawer over the current page instead of a page detour.
//
// The read boundary resolves membership before selecting rows or opening a deep link.
export function CatalogControlPlaneEvidenceDrawer({
  auditEvidence,
  trigger,
  deepLinkOpen = auditEvidence.selection.deepLinkOpen,
}: Readonly<{
  auditEvidence: AuditEvidence;
  trigger?: ReactNode;
  deepLinkOpen?: boolean;
}>) {
  const { timeline, evidenceLinks } = auditEvidence;

  return (
    <SideSheet
      title={t("catalog.features.sourceObservations.ui.auditEvidence.title")}
      description={t("catalog.features.sourceObservations.ui.auditEvidence.description")}
      closeLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.evidence.close")}
      width="lg"
      defaultOpen={deepLinkOpen && auditEvidence.selection.state === "resolved"}
      trigger={
        trigger ?? (
          <Button size="sm" tone="secondary" leadingIcon="clock">
            {t("catalog.features.sourceObservations.ui.auditEvidence.title")}
          </Button>
        )
      }
    >
      <WorkbenchStack data-catalog-evidence-drawer="true">
        <OperationalStatusBanner
          tone={
            auditEvidence.status === "blocked" ? "danger" : auditEvidence.status === "ready" ? "success" : "warning"
          }
          title={evidenceDrawerBannerTitle(auditEvidence)}
          description={evidenceDrawerBannerDescription(auditEvidence)}
        />
        <MetricStrip
          items={[
            {
              label: t("catalog.features.sourceObservations.ui.auditEvidence.metric.timeline"),
              value: String(timeline.length),
              trend: auditEvidence.freshness,
            },
            {
              label: t("catalog.features.sourceObservations.ui.auditEvidence.metric.links"),
              value: String(evidenceLinks.length),
              trend: t("catalog.features.sourceObservations.ui.auditEvidence.metric.linksTrend"),
            },
          ]}
        />
        <KeyValueList
          density="compact"
          layout="grid"
          items={[
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.status"),
              value: auditEvidence.status,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.freshness"),
              value: auditEvidence.freshness,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.generated"),
              value: formatDateTime(auditEvidence.generatedAt),
            },
            {
              key: t("catalog.features.sourceObservations.ui.healthFacts.source"),
              value: auditEvidence.projectionState.queryKey,
            },
            {
              key: t("catalog.features.sourceObservations.ui.healthFacts.projectionStatus"),
              value: auditEvidence.projectionState.missingProjection ? "unavailable" : "partial",
            },
            {
              key: t("catalog.features.sourceObservations.ui.healthFacts.projectionFreshness"),
              value: auditEvidence.projectionState.freshness,
            },
            {
              key: t("catalog.features.sourceObservations.ui.healthFacts.projectionGeneratedAt"),
              value: auditEvidence.projectionState.generatedAt
                ? formatDateTime(auditEvidence.projectionState.generatedAt)
                : "unavailable",
            },
            {
              key: t("catalog.features.sourceObservations.ui.healthFacts.projectionMessage"),
              value: auditEvidence.projectionState.statusMessage,
            },
            {
              key: t("catalog.features.sourceObservations.ui.governanceControls.table.metric"),
              value: "catalog.integration.audit.generated_at",
            },
            {
              key: t("catalog.features.sourceObservations.ui.auditEvidence.key.sourcePayload"),
              value: auditEvidence.redactionPolicy.sourcePayloadAccess,
            },
            {
              key: t("catalog.features.sourceObservations.ui.auditEvidence.key.profileSnapshot"),
              value: auditEvidence.redactionPolicy.profileSnapshotAccess,
            },
          ]}
        />
        {timeline.length > 0 ? (
          <DataTable
            rows={[...timeline]}
            columns={timelineColumns}
            caption={t("catalog.features.sourceObservations.ui.auditEvidence.timeline.title")}
            getRowId={(row) => row.eventId}
            density="compact"
          />
        ) : (
          <EmptyState
            title={
              auditEvidence.selection.state === "no-associated-evidence"
                ? t("catalog.features.sourceObservations.ui.auditEvidence.timeline.noAssociationTitle")
                : t("catalog.features.sourceObservations.ui.auditEvidence.timeline.emptyTitle")
            }
            description={
              auditEvidence.selection.state === "no-associated-evidence"
                ? t("catalog.features.sourceObservations.ui.auditEvidence.timeline.noAssociationDescription")
                : t("catalog.features.sourceObservations.ui.auditEvidence.timeline.emptyDescription")
            }
          />
        )}
        {evidenceLinks.length > 0 ? (
          <DataTable
            rows={[...evidenceLinks]}
            columns={linkColumns}
            caption={t("catalog.features.sourceObservations.ui.auditEvidence.links.title")}
            getRowId={(link) => link.key}
            density="compact"
          />
        ) : null}
      </WorkbenchStack>
    </SideSheet>
  );
}

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
        description={row.targetType.replace(/-/g, " ")}
        detail={
          [row.providerKey, row.unitKey].filter(Boolean).join(" / ") ||
          t("catalog.features.sourceObservations.ui.primaryWorkbench.none")
        }
      />
    ),
  },
  {
    key: "actor",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.category"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.category"),
    cell: (row) => (
      <WorkbenchStack gap="sm">
        <Badge tone={categoryTone(row.category)}>{row.category.replace(/-/g, " ")}</Badge>
        <WorkbenchText size="xs">{row.actorLabel}</WorkbenchText>
      </WorkbenchStack>
    ),
  },
  {
    key: "summary",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.summary"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.summary"),
    cell: (row) => <WorkbenchDataCell title={row.summary} titleWeight="regular" />,
  },
  {
    key: "evidence",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.evidence"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.evidence"),
    align: "right",
    cell: (row) => (
      <WorkbenchLinkList align="end">
        {row.evidenceLinks.slice(0, 2).map((link) => (
          <LinkText key={link.key} href={link.href}>
            {link.label}
          </LinkText>
        ))}
      </WorkbenchLinkList>
    ),
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
    key: "redaction",
    header: t("catalog.features.sourceObservations.ui.auditEvidence.table.redaction"),
    mobileLabel: t("catalog.features.sourceObservations.ui.auditEvidence.table.redaction"),
    cell: (link) => <Badge tone={redactionTone(link.redactionState)}>{link.redactionState.replace(/-/g, " ")}</Badge>,
  },
];

function evidenceDrawerBannerTitle(audit: AuditEvidence): string {
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

function evidenceDrawerBannerDescription(audit: AuditEvidence): string {
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

function categoryTone(category: string): BadgeTone {
  if (category === "promotion" || category === "source-observation" || category === "import-job") {
    return "accent";
  }
  if (category === "diagnostic") {
    return "warning";
  }
  return "neutral";
}

function redactionTone(state: AuditEvidenceLink["redactionState"]): BadgeTone {
  return state === "not-needed" ? "success" : state === "excluded" ? "danger" : "warning";
}
