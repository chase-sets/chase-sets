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
  StatusReasonList,
  WorkbenchDataCell,
  WorkbenchForm,
  WorkbenchGrid,
  WorkbenchStack,
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
type BadgeTone = "success" | "warning" | "danger" | "neutral" | "info" | "accent";

// Version history table + row lifecycle actions for the v2 Provider detail page.
// Rollback/deprecate/retire are actions on the version-history rows,
// with the existing confirm gates — replacing the deleted standalone lifecycle
// recovery workspace. Selecting a row (its href carries ?profileVersion=) is the
// durable page-state selection the linear activate/rollback/deprecate/retire
// flow acts on; the lifecycle action panels below the table always describe the
// currently selected version.
export function ProviderVersionHistory({
  readModel,
  providerKey,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  providerKey: string | null;
}>) {
  const lifecycle = readModel.lifecycleRecovery;

  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.lifecycleRecovery.profileCandidates.title")}
      description={t("catalog.features.sourceObservations.ui.lifecycleRecovery.profileCandidates.description")}
      status={<Badge tone="neutral">{lifecycle.profiles.length} versions</Badge>}
      density="compact"
    >
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
        ]}
      />
      <DataTable
        rows={[...lifecycle.profiles]}
        columns={profileColumns(providerKey)}
        caption={t("catalog.features.sourceObservations.ui.lifecycleRecovery.profileCandidates.title")}
        getRowId={(profile) => `${profile.providerKey}:${profile.profileVersion}`}
        density="compact"
        emptyTitle={t("catalog.features.sourceObservations.ui.lifecycleRecovery.profileCandidates.emptyTitle")}
        emptyDescription={t(
          "catalog.features.sourceObservations.ui.lifecycleRecovery.profileCandidates.emptyDescription",
        )}
      />

      <WorkbenchGrid columns="two">
        {lifecycle.operations
          .filter((operation) => operation.operation !== "activation")
          .map((operation) => (
            <LifecycleOperationRowAction key={operation.operation} operation={operation} />
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
        <KeyValueList
          density="compact"
          layout="grid"
          items={[
            { key: "Required disposition", value: lifecycle.strictRetirement.requiredDisposition },
            { key: "Forbidden support paths", value: lifecycle.strictRetirement.forbiddenSupportPaths.join(", ") },
          ]}
        />
      </WorkflowModule>

      {lifecycle.recentAuditEvents.length > 0 ? (
        <EvidenceStringList
          title={t("catalog.features.sourceObservations.ui.lifecycleRecovery.audit.title")}
          items={lifecycle.recentAuditEvents.map((event) => `${event.eventName}: ${event.summary}`)}
          emptyLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}
          emptyTone="neutral"
        />
      ) : (
        <EmptyState
          title={t("catalog.features.sourceObservations.ui.lifecycleRecovery.audit.emptyTitle")}
          description={t("catalog.features.sourceObservations.ui.lifecycleRecovery.audit.emptyDescription")}
        />
      )}
    </WorkflowModule>
  );
}

function profileColumns(providerKey: string | null): DataColumn<LifecycleProfile>[] {
  return [
    {
      key: "profile",
      header: t("catalog.features.sourceObservations.ui.lifecycleRecovery.table.profile"),
      sortable: true,
      cell: (profile) => (
        <WorkbenchDataCell
          title={profile.displayName}
          description={`${profile.profileKey}@${profile.profileVersion}`}
        />
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
            ...(providerKey && profile.providerKey === providerKey
              ? [
                  {
                    key: "selected",
                    label: t("catalog.features.sourceObservations.ui.lifecycleRecovery.badge.selectedProvider"),
                    tone: "neutral" as const,
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
}

function LifecycleOperationRowAction({ operation }: Readonly<{ operation: LifecycleOperation }>) {
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
              label: t("catalog.features.sourceObservations.ui.lifecycleRecovery.operation.metric.catalogItems"),
              value: String(operation.impact.impactedCatalogItemCount),
              trend: `${operation.impact.externalReferenceCount} external refs`,
            },
          ]}
        />
        <BlockerBadges blockers={operation.blockers} />
        <WorkbenchForm
          variant="plain"
          method="post"
          action={operation.submitHref}
          data-catalog-lifecycle-command={operation.operation}
          data-catalog-primary-workbench-command={operation.commandKey}
        >
          <HiddenInput name="_intent" value={operation.commandKey} />
          <HiddenInput name="providerKey" value={operation.providerKey ?? ""} />
          <HiddenInput name="profileVersion" value={operation.profileVersion ?? ""} />
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
      </WorkbenchStack>
    </WorkflowModule>
  );
}

function BlockerBadges({ blockers }: Readonly<{ blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] }>) {
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
  if (lifecycle === "active") return "success";
  if (lifecycle === "retired") return "danger";
  if (lifecycle === "deprecated") return "warning";
  return "neutral";
}

function actionTone(state: CatalogPrimaryWorkbenchActionState): BadgeTone {
  if (state === "available") return "success";
  if (state === "denied" || state === "unsafe" || state === "blocked") return "danger";
  if (state === "degraded") return "warning";
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
