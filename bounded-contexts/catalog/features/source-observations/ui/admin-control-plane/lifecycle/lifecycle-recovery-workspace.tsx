import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  EmptyState,
  Form,
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
    <section className="grid min-w-0 gap-4" data-catalog-lifecycle-recovery-workspace="true">
      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.lifecycleRecovery.title")}
        description={t("catalog.features.sourceObservations.ui.lifecycleRecovery.description")}
        status={<Badge tone={statusTone(lifecycle.status)}>{stateLabel(lifecycle.status)}</Badge>}
        actions={
          <LinkButton size="sm" tone="secondary" leadingIcon="chevronLeft" href={lifecycle.returnToPrimaryHref}>
            {t("catalog.features.sourceObservations.ui.lifecycleRecovery.backToImportWorkbench")}
          </LinkButton>
        }
        headingLevel={2}
        density="compact"
      >
        <div className="grid gap-4">
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
        </div>
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
          getRowId={(profile) => `${profile.providerKey}:${profile.profileVersion}`}
          density="compact"
          emptyTitle={t("catalog.features.sourceObservations.ui.lifecycleRecovery.profileCandidates.emptyTitle")}
          emptyDescription={t(
            "catalog.features.sourceObservations.ui.lifecycleRecovery.profileCandidates.emptyDescription",
          )}
        />
      </WorkflowModule>

      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        {lifecycle.operations.map((operation) => (
          <LifecycleOperationModule key={operation.operation} readModel={readModel} operation={operation} />
        ))}
      </div>

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
        <div className="grid gap-4">
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
        </div>
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
    </section>
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
      <div className="grid min-w-0 gap-4">
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
          <Form
            spacing="none"
            method="post"
            action={operation.submitHref}
            className="grid gap-3 sm:max-w-md"
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
          </Form>
        )}
      </div>
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
      <input type="hidden" name="_intent" value={operation.commandKey} />
      <input type="hidden" name="providerKey" value={operation.providerKey ?? context.providerKey ?? ""} />
      <input type="hidden" name="unitKey" value={context.unitKey ?? ""} />
      <input type="hidden" name="importScope" value={context.importScope ?? ""} />
      <input type="hidden" name="profileVersion" value={operation.profileVersion ?? context.profileVersion ?? ""} />
      <input type="hidden" name="selectedObservationIds" value={context.selectedObservationIds.join(",")} />
      <input type="hidden" name="jobId" value={context.jobId ?? ""} />
      <input type="hidden" name="promotionPreviewId" value={context.promotionPreviewId ?? ""} />
    </>
  );
}

const profileColumns: DataColumn<LifecycleProfile>[] = [
  {
    key: "profile",
    header: t("catalog.features.sourceObservations.ui.lifecycleRecovery.table.profile"),
    sortable: true,
    cell: (profile) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{profile.displayName}</span>
        <span className="text-xs text-secondary">
          {profile.profileKey}@{profile.profileVersion}
        </span>
      </div>
    ),
  },
  {
    key: "lifecycle",
    header: t("catalog.features.sourceObservations.ui.lifecycleRecovery.table.lifecycle"),
    mobileLabel: t("catalog.features.sourceObservations.ui.lifecycleRecovery.table.lifecycle"),
    cell: (profile) => (
      <div className="flex min-w-0 flex-wrap gap-1.5">
        <Badge tone={profile.active ? "success" : lifecycleTone(profile.lifecycle)}>
          {stateLabel(profile.lifecycle)}
        </Badge>
        {profile.active ? (
          <Badge tone="accent">{t("catalog.features.sourceObservations.ui.lifecycleRecovery.badge.active")}</Badge>
        ) : null}
      </div>
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
    cell: (event) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{event.eventName}</span>
        <span className="text-xs text-secondary">{event.summary}</span>
      </div>
    ),
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
    cell: (event) => formatDateTime(event.occurredAt),
  },
];

function BlockerBadges({ blockers }: { blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] }) {
  if (blockers.length === 0) {
    return <Badge tone="success">{t("catalog.features.sourceObservations.ui.lifecycleRecovery.blockers.none")}</Badge>;
  }

  return (
    <div className="grid min-w-0 gap-2">
      <h3 className="text-sm font-semibold text-foreground">
        {t("catalog.features.sourceObservations.ui.lifecycleRecovery.blockers.title")}
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

function EvidenceList({ title, items }: Readonly<{ title: string; items: readonly string[] }>) {
  return (
    <div className="grid min-w-0 gap-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <ul className="grid min-w-0 gap-1 text-sm leading-6 text-secondary">
        {items.map((item, index) => (
          <li key={`${title}-${index}`} className="break-words">
            {item}
          </li>
        ))}
      </ul>
    </div>
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

function formatDateTime(value: string | null): string {
  if (!value) {
    return t("catalog.features.sourceObservations.ui.lifecycleRecovery.audit.notRecorded");
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
