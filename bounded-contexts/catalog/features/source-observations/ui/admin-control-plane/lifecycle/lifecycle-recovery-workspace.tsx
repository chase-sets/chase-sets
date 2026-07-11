import {
  Badge,
  BadgeCluster,
  Button,
  Checkbox,
  DataTable,
  EmptyState,
  EvidenceStringList,
  HiddenInput,
  KeyValueList,
  LinkButton,
  MetricStrip,
  OperationalStatusBanner,
  StatusReasonList,
  WorkbenchDataCell,
  WorkbenchForm,
  WorkbenchGrid,
  WorkbenchStack,
  WorkflowModule,
  type DataColumn,
} from "@chase-sets/design-system";
import { formatDateTime, t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import { getCatalogPrimaryWorkbenchBlockerCopy } from "../../primary-workbench-copy";

type LifecycleRecovery = CatalogPrimaryWorkbenchReadModel["lifecycleRecovery"];
type LifecycleOperation = LifecycleRecovery["operations"][number];
type LifecycleProfile = LifecycleRecovery["profiles"][number];
type LifecycleAuditEvent = LifecycleRecovery["recentAuditEvents"][number];
type BadgeTone = "success" | "warning" | "danger" | "neutral" | "info" | "accent";

export function CatalogIntegrationLifecycleRecoveryWorkspace({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const lifecycle = readModel.lifecycleRecovery;

  return (
    <WorkbenchStack element="section" data-catalog-lifecycle-recovery-workspace="true">
      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.lifecycleRecovery.title")}
        description={t("catalog.features.sourceObservations.ui.lifecycleRecovery.description")}
        status={<Badge tone={statusTone(lifecycle.status)}>{stateLabel(lifecycle.status)}</Badge>}
        headingLevel={2}
        density="compact"
      >
        <WorkbenchStack>
          <OperationalStatusBanner
            tone={lifecycle.status === "ready" ? "success" : lifecycle.status === "blocked" ? "danger" : "warning"}
            title={lifecycleBannerTitle(lifecycle)}
            description={lifecycleBannerDescription(lifecycle)}
          />
          <MetricStrip
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.lifecycleRecovery.metric.affectedReferences"),
                value: String(lifecycle.summary.affectedReferences),
                trend: `${lifecycle.summary.downstreamProfileReferences} downstream profile refs`,
              },
              {
                label: t("catalog.features.sourceObservations.ui.lifecycleRecovery.metric.activeJobs"),
                value: String(lifecycle.summary.activeJobs),
                trend: lifecycle.freshness,
              },
              {
                label: t("catalog.features.sourceObservations.ui.lifecycleRecovery.metric.impactedCatalogItems"),
                value: String(lifecycle.summary.impactedCatalogItems),
                trend: `${lifecycle.summary.blockers} blockers`,
              },
              {
                label: t("catalog.features.sourceObservations.ui.lifecycleRecovery.metric.lifecycleAudit"),
                value: String(lifecycle.summary.recentLifecycleEvents),
                trend: lifecycle.selectedProfileVersion ?? "no profile selected",
              },
            ]}
          />
        </WorkbenchStack>
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.lifecycleRecovery.profileCandidates.title")}
        description={t("catalog.features.sourceObservations.ui.lifecycleRecovery.profileCandidates.description")}
        status={<Badge tone="neutral">{lifecycle.profiles.length} profiles</Badge>}
        density="compact"
      >
        <DataTable
          rows={[...lifecycle.profiles]}
          columns={profileColumns}
          caption={t("catalog.features.sourceObservations.ui.lifecycleRecovery.profileCandidates.title")}
          getRowId={(profile) => `${profile.providerKey}:${profile.profileVersion}`}
          density="compact"
          emptyTitle={t("catalog.features.sourceObservations.ui.lifecycleRecovery.profileCandidates.emptyTitle")}
          emptyDescription={t(
            "catalog.features.sourceObservations.ui.lifecycleRecovery.profileCandidates.emptyDescription",
          )}
        />
      </WorkflowModule>

      <WorkbenchGrid columns="two">
        {lifecycle.operations.map((operation) => (
          <LifecycleOperationModule key={operation.operation} readModel={readModel} operation={operation} />
        ))}
      </WorkbenchGrid>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.lifecycleRecovery.strictRetirement.title")}
        description={t("catalog.features.sourceObservations.ui.lifecycleRecovery.strictRetirement.description")}
        status={
          <Badge tone="danger">
            {t("catalog.features.sourceObservations.ui.lifecycleRecovery.strictRetirement.badge")}
          </Badge>
        }
        density="compact"
      >
        <WorkbenchStack>
          <OperationalStatusBanner
            tone="danger"
            title={t("catalog.features.sourceObservations.ui.lifecycleRecovery.strictRetirement.ruleTitle")}
            description={lifecycle.strictRetirement.summary}
          />
          <KeyValueList
            density="compact"
            layout="grid"
            items={[
              { key: "Required disposition", value: lifecycle.strictRetirement.requiredDisposition },
              { key: "Forbidden support paths", value: lifecycle.strictRetirement.forbiddenSupportPaths.join(", ") },
            ]}
          />
        </WorkbenchStack>
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.lifecycleRecovery.audit.title")}
        description={t("catalog.features.sourceObservations.ui.lifecycleRecovery.audit.description")}
        status={<Badge tone="neutral">{lifecycle.recentAuditEvents.length} events</Badge>}
        density="compact"
      >
        {lifecycle.recentAuditEvents.length > 0 ? (
          <DataTable
            rows={[...lifecycle.recentAuditEvents]}
            columns={auditColumns}
            caption={t("catalog.features.sourceObservations.ui.lifecycleRecovery.audit.title")}
            getRowId={(event) => event.eventId}
            density="compact"
          />
        ) : (
          <EmptyState
            title={t("catalog.features.sourceObservations.ui.lifecycleRecovery.audit.emptyTitle")}
            description={t("catalog.features.sourceObservations.ui.lifecycleRecovery.audit.emptyDescription")}
          />
        )}
      </WorkflowModule>
    </WorkbenchStack>
  );
}

function LifecycleOperationModule({
  readModel,
  operation,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  operation: LifecycleOperation;
}>) {
  const disabled = !isActionAvailable(operation.state);

  return (
    <WorkflowModule
      title={operation.label}
      description={operation.description}
      status={<Badge tone={actionTone(operation.state)}>{stateLabel(operation.state)}</Badge>}
      density="compact"
    >
      <WorkbenchStack>
        <KeyValueList
          density="compact"
          layout="grid"
          items={[
            { key: "Provider", value: operation.providerKey ?? "not selected" },
            { key: "Profile version", value: operation.profileVersion ?? "not selected" },
            { key: "Lifecycle", value: operation.lifecycle ?? "not selected" },
            { key: "Active profile", value: operation.active ? "yes" : "no" },
            { key: "Confirmation", value: operation.confirmationRequired ? "required" : "handled in readiness" },
            { key: "Audit event", value: operation.auditConsequences.eventName },
          ]}
        />
        <MetricStrip
          items={[
            {
              label: t(
                "catalog.features.sourceObservations.ui.lifecycleRecovery.operation.metric.referencedObservations",
              ),
              value: String(operation.impact.referencedObservationCount),
              trend: `${operation.impact.sampleObservationIds.length} samples`,
            },
            {
              label: t("catalog.features.sourceObservations.ui.lifecycleRecovery.operation.metric.profileReferences"),
              value: String(
                operation.impact.sourceProfileReferenceCount + operation.impact.promotionProfileReferenceCount,
              ),
              trend: "source and promotion",
            },
            {
              label: t("catalog.features.sourceObservations.ui.lifecycleRecovery.operation.metric.catalogItems"),
              value: String(operation.impact.impactedCatalogItemCount),
              trend: `${operation.impact.externalReferenceCount} external refs`,
            },
            {
              label: t("catalog.features.sourceObservations.ui.lifecycleRecovery.operation.metric.activeJobs"),
              value: String(operation.impact.impactedJobCount),
              trend: operation.impact.generatedAt ?? "partial impact",
            },
          ]}
        />
        <EvidenceList
          title={t("catalog.features.sourceObservations.ui.lifecycleRecovery.operation.evidence.replayRollback")}
          items={operation.nextSteps}
        />
        <EvidenceList
          title={t(
            "catalog.features.sourceObservations.ui.lifecycleRecovery.operation.evidence.impactedCatalogItemIds",
          )}
          items={
            operation.impact.impactedCatalogItemIds.length > 0
              ? operation.impact.impactedCatalogItemIds
              : [
                  t(
                    "catalog.features.sourceObservations.ui.lifecycleRecovery.operation.evidence.noImpactedCatalogItems",
                  ),
                ]
          }
        />
        <BlockerBadges blockers={operation.blockers} />
        {operation.operation === "activation" && operation.supportHref ? (
          <LinkButton size="sm" tone="secondary" leadingIcon="externalLink" href={operation.supportHref}>
            {t("catalog.features.sourceObservations.ui.lifecycleRecovery.operation.activation.open")}
          </LinkButton>
        ) : (
          <WorkbenchForm
            variant="plain"
            method="post"
            action={operation.submitHref}
            data-catalog-lifecycle-command={operation.operation}
            data-catalog-primary-workbench-command={operation.commandKey}
          >
            <LifecycleHiddenInputs readModel={readModel} operation={operation} />
            <Checkbox
              name="lifecycleConfirmation"
              value={lifecycleConfirmationValue(operation)}
              label={lifecycleConfirmationLabel(operation)}
              required={!disabled}
              disabled={disabled}
            />
            <Button
              type="submit"
              leadingIcon="check"
              tone={operation.operation === "retire" ? "danger" : "primary"}
              disabled={disabled}
            >
              {operation.label}
            </Button>
          </WorkbenchForm>
        )}
      </WorkbenchStack>
    </WorkflowModule>
  );
}

function LifecycleHiddenInputs({
  readModel,
  operation,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  operation: LifecycleOperation;
}>) {
  const context = readModel.routeContext;

  return (
    <>
      <HiddenInput name="_intent" value={operation.commandKey} />
      <HiddenInput name="providerKey" value={operation.providerKey ?? context.providerKey ?? ""} />
      <HiddenInput name="unitKey" value={context.unitKey ?? ""} />
      <HiddenInput name="importScope" value={context.importScope ?? ""} />
      <HiddenInput name="profileVersion" value={operation.profileVersion ?? context.profileVersion ?? ""} />
      <HiddenInput name="selectedObservationIds" value={context.selectedObservationIds.join(",")} />
      <HiddenInput name="jobId" value={context.jobId ?? ""} />
      <HiddenInput name="promotionPreviewId" value={context.promotionPreviewId ?? ""} />
    </>
  );
}

const profileColumns: DataColumn<LifecycleProfile>[] = [
  {
    key: "profile",
    header: t("catalog.features.sourceObservations.ui.lifecycleRecovery.table.profile"),
    sortable: true,
    cell: (profile) => (
      <WorkbenchDataCell title={profile.displayName} description={`${profile.profileKey}@${profile.profileVersion}`} />
    ),
  },
  {
    key: "lifecycle",
    header: t("catalog.features.sourceObservations.ui.lifecycleRecovery.table.lifecycle"),
    mobileLabel: t("catalog.features.sourceObservations.ui.lifecycleRecovery.table.lifecycle"),
    cell: (profile) => (
      <BadgeCluster
        items={[
          {
            key: "lifecycle",
            label: stateLabel(profile.lifecycle),
            tone: profile.active ? "success" : lifecycleTone(profile.lifecycle),
          },
          ...(profile.active
            ? [
                {
                  key: "active",
                  label: t("catalog.features.sourceObservations.ui.lifecycleRecovery.badge.active"),
                  tone: "accent" as const,
                },
              ]
            : []),
        ]}
      />
    ),
  },
  {
    key: "references",
    header: t("catalog.features.sourceObservations.ui.lifecycleRecovery.table.references"),
    mobileLabel: t("catalog.features.sourceObservations.ui.lifecycleRecovery.table.references"),
    cell: (profile) => String(profile.referenceCount),
  },
  {
    key: "action",
    header: t("catalog.features.sourceObservations.ui.lifecycleRecovery.table.action"),
    mobileLabel: t("catalog.features.sourceObservations.ui.lifecycleRecovery.table.action"),
    align: "right",
    cell: (profile) => (
      <LinkButton size="sm" tone="secondary" href={profile.href}>
        {t("catalog.features.sourceObservations.ui.lifecycleRecovery.table.inspect")}
      </LinkButton>
    ),
  },
];

const auditColumns: DataColumn<LifecycleAuditEvent>[] = [
  {
    key: "event",
    header: t("catalog.features.sourceObservations.ui.lifecycleRecovery.table.event"),
    sortable: true,
    cell: (event) => <WorkbenchDataCell title={event.eventName} description={event.summary} />,
  },
  {
    key: "profile",
    header: t("catalog.features.sourceObservations.ui.lifecycleRecovery.table.profile"),
    mobileLabel: t("catalog.features.sourceObservations.ui.lifecycleRecovery.table.profile"),
    cell: (event) => event.profileVersion ?? "not selected",
  },
  {
    key: "occurred",
    header: t("catalog.features.sourceObservations.ui.lifecycleRecovery.table.occurred"),
    mobileLabel: t("catalog.features.sourceObservations.ui.lifecycleRecovery.table.occurred"),
    cell: (event) => formatWorkspaceDateTime(event.occurredAt),
  },
];

function BlockerBadges({ blockers }: { blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] }) {
  if (blockers.length === 0) {
    return <Badge tone="success">{t("catalog.features.sourceObservations.ui.lifecycleRecovery.blockers.none")}</Badge>;
  }

  return (
    <StatusReasonList
      nextStepPrefix={t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.next.prefix")}
      items={[...new Set(blockers)].map((blocker) => {
        const copy = getCatalogPrimaryWorkbenchBlockerCopy(blocker);

        return {
          key: blocker,
          label: copy.label,
          reason: copy.reason,
          nextStep: copy.nextStep,
          tone: blockerTone(blocker),
        };
      })}
    />
  );
}

function EvidenceList({ title, items }: Readonly<{ title: string; items: readonly string[] }>) {
  return (
    <EvidenceStringList
      title={title}
      items={items}
      emptyLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}
      emptyTone="neutral"
    />
  );
}

function lifecycleBannerTitle(lifecycle: LifecycleRecovery): string {
  if (lifecycle.status === "ready") {
    return t("catalog.features.sourceObservations.ui.lifecycleRecovery.banner.readyTitle");
  }
  if (lifecycle.status === "blocked") {
    return t("catalog.features.sourceObservations.ui.lifecycleRecovery.banner.blockedTitle");
  }

  return t("catalog.features.sourceObservations.ui.lifecycleRecovery.banner.unavailableTitle");
}

function lifecycleBannerDescription(lifecycle: LifecycleRecovery): string {
  if (lifecycle.status === "ready") {
    return t("catalog.features.sourceObservations.ui.lifecycleRecovery.banner.readyDescription");
  }
  if (lifecycle.status === "blocked") {
    return t("catalog.features.sourceObservations.ui.lifecycleRecovery.banner.blockedDescription");
  }

  return t("catalog.features.sourceObservations.ui.lifecycleRecovery.banner.unavailableDescription");
}

function statusTone(status: LifecycleRecovery["status"]): BadgeTone {
  if (status === "ready") {
    return "success";
  }
  if (status === "blocked") {
    return "danger";
  }

  return "warning";
}

function actionTone(state: CatalogPrimaryWorkbenchActionState): BadgeTone {
  if (state === "available") {
    return "success";
  }
  if (state === "denied" || state === "unsafe" || state === "blocked") {
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
  if (group === "job" || group === "resilience") {
    return "warning";
  }

  return blocker.includes("conflict") ? "danger" : "warning";
}

function lifecycleTone(lifecycle: string): BadgeTone {
  if (lifecycle === "active") {
    return "success";
  }
  if (lifecycle === "retired") {
    return "danger";
  }
  if (lifecycle === "deprecated") {
    return "warning";
  }

  return "neutral";
}

function isActionAvailable(state: CatalogPrimaryWorkbenchActionState): boolean {
  return state === "available" || state === "degraded";
}

function lifecycleConfirmationValue(operation: LifecycleOperation): string {
  return `confirm:${operation.commandKey}:${operation.providerKey ?? ""}:${operation.profileVersion ?? ""}`;
}

function lifecycleConfirmationLabel(operation: LifecycleOperation): string {
  if (operation.operation === "retire") {
    return t("catalog.features.sourceObservations.ui.lifecycleRecovery.confirmation.retire");
  }
  return t("catalog.features.sourceObservations.ui.lifecycleRecovery.confirmation.default", {
    action: operation.label.toLowerCase(),
  });
}

function stateLabel(state: string): string {
  return state
    .split("-")
    .join(" ")
    .replace(/^\w/, (char) => char.toUpperCase());
}

function formatWorkspaceDateTime(value: string | null): string {
  if (!value) {
    return t("catalog.features.sourceObservations.ui.lifecycleRecovery.audit.notRecorded");
  }
  try {
    return formatDateTime(value);
  } catch {
    return value;
  }
}
