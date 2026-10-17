import { useState } from "react";
import {
  Badge,
  BadgeCluster,
  Button,
  DataTable,
  DenseAdminWorkbench,
  DenseAdminWorkbenchHeader,
  EmptyState,
  KeyValueList,
  OperationalStatusBanner,
  ProgressiveDisclosure,
  TextInput,
  WorkbenchDataCell,
  WorkbenchForm,
  WorkbenchGrid,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
  type DataColumn,
} from "@chase-sets/design-system";
import { formatDateTime, t } from "@chase-sets/localization";
import { operatorSessionProviderKey } from "../../../../operator-session/ui/admin-panel/operator-session-admin-types";
import { OperatorSessionPanel } from "../../../../operator-session/ui/admin-panel/operator-session-panel";
import {
  ProviderRefreshSchedulePanel,
  type ProviderRefreshSchedulePanelItem,
} from "../../../../provider-scope-discovery/ui/provider-refresh-schedule-panel";
import type {
  CatalogPrimaryWorkbenchProviderTransportCategory,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../primary-workbench-command-feedback";
import { getCatalogPrimaryWorkbenchProviderTransportCopy } from "../../primary-workbench-copy";
import {
  commandErrorTitle,
  commandFeedbackDescription,
  commandSuccessTitle,
} from "../../primary-workbench-command-feedback";
import { actionTone, stateLabel } from "../import-to-promotion/workbench-formatting";
import { ProfileBlockerList } from "../profiles/profile-blocker-list";
import { ProfileAuthoringHiddenInputs } from "../profiles/profile-hidden-inputs";
import { ProfileOverviewEvidence } from "../profiles/profile-overview-evidence";
import { ProfileSectionWorkspaces } from "../profiles/profile-section-workspaces";
import { ActivationDecisionModule, ActivationReadinessSection } from "../validation/activation-evidence-section";
import { DryRunSection } from "../validation/dry-run-section";
import { FixtureSection } from "../validation/fixture-section";
import { ProviderReadinessSection } from "../validation/provider-readiness-section";
import { SemanticCompareSection } from "../validation/semantic-checks-section";
import { catalogProviderDetailHref } from "./provider-detail-links";
import { ProviderDetailHeader } from "./provider-detail-header";
import { ProviderVersionHistory } from "./provider-version-history";
import { SectionDirtySummary } from "./section-dirty-summary";

// The v2 Provider detail page (/catalog/providers/:providerKey): profile,
// validation, lifecycle, health, and schedule for one provider, on one page.
// Clone -> edit sections -> validate -> activate is one linear flow — draft and
// validation readiness render in page order rather than as separate stacked
// workspaces, and rollback/deprecate/retire are row actions on the version
// history table below. Every command form on this page submits back to this
// same route (see provider-detail-links.ts / provider-detail-action.ts): there
// is no cross-surface redirect anywhere on this page.
export function CatalogProviderDetailPage({
  readModel,
  commandFeedback = null,
  providerRefreshSchedules = null,
  operatorSessionKey = null,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
  providerRefreshSchedules?: readonly ProviderRefreshSchedulePanelItem[] | null;
  /** Set only for platform-admin actors on TCGplayer; keys the Operator session panel. */
  operatorSessionKey?: string | null;
}>) {
  const authoring = readModel.profileAuthoring;
  const selectedProfile = authoring.selectedProfile;
  const providerKey = readModel.routeContext.providerKey ?? selectedProfile?.providerKey ?? null;
  const cloneDraft = authoring.cloneDraft;
  const cloneDisabled = cloneDraft.state !== "available" && cloneDraft.state !== "degraded";
  const submitHref = catalogProviderDetailHref(providerKey);
  const scheduleActionHref = catalogProviderDetailHref(providerKey, {
    profileVersion: selectedProfile?.profileVersion ?? null,
  });
  const canManageCatalog = !cloneDraft.blockers.includes("permission-denied");

  return (
    <DenseAdminWorkbench data-catalog-provider-detail="true">
      <DenseAdminWorkbenchHeader
        eyebrow={t("catalog.features.sourceObservations.ui.providerDetail.eyebrow")}
        title={providerKey ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected")}
        description={t("catalog.features.sourceObservations.ui.providerDetail.description")}
      />

      {commandFeedback ? <CommandFeedbackBanner feedback={commandFeedback} /> : null}

      <ProviderDetailHeader readModel={readModel} providerKey={providerKey} />

      {operatorSessionKey && providerKey === operatorSessionProviderKey ? (
        <OperatorSessionPanel key={operatorSessionKey} />
      ) : null}

      {providerRefreshSchedules ? (
        <ProviderRefreshSchedulePanel
          items={providerRefreshSchedules}
          actionHref={scheduleActionHref}
          canManageCatalog={canManageCatalog}
        />
      ) : null}

      {selectedProfile ? (
        <ProfileOverviewEvidence profile={selectedProfile} />
      ) : (
        <EmptyState
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.empty.title")}
          description={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.empty.description")}
        />
      )}

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.draft.title")}
        description={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.draft.description")}
        status={<Badge tone={actionTone(cloneDraft.state)}>{stateLabel(cloneDraft.state)}</Badge>}
        density="compact"
      >
        <WorkbenchGrid columns="detail">
          <WorkbenchStack>
            <ProfileBlockerList blockers={cloneDraft.blockers} />
          </WorkbenchStack>
          <WorkbenchForm
            method="post"
            action={submitHref}
            data-catalog-primary-workbench-command="provider-profile.clone"
          >
            <ProfileAuthoringHiddenInputs readModel={readModel} authoring={authoring} />
            <TextInput
              label={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.draft.target.label")}
              description={
                cloneDraft.state === "denied"
                  ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.draft.denied")
                  : t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.draft.help")
              }
              name="targetProfileVersion"
              defaultValue={cloneDraft.targetProfileVersion ?? ""}
              disabled={cloneDisabled}
              required
            />
            <Button type="submit" leadingIcon="plus" disabled={cloneDisabled}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.draft.submit")}
            </Button>
          </WorkbenchForm>
        </WorkbenchGrid>
      </WorkflowModule>

      {authoring.sectionWorkspaces.length > 0 ? (
        <WorkflowModule
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.title")}
          description={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.description")}
          status={
            <Badge tone="neutral">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.count", {
                count: authoring.sectionWorkspaces.length,
              })}
            </Badge>
          }
        >
          <SectionDirtySummary>
            <ProfileSectionWorkspaces readModel={readModel} authoring={authoring} />
          </SectionDirtySummary>
        </WorkflowModule>
      ) : null}

      <ProviderReadinessSection readModel={readModel} />
      <FixtureSection validation={readModel.validationReadiness} />
      <DryRunSection validation={readModel.validationReadiness} />
      <SemanticCompareSection validation={readModel.validationReadiness} />
      <ActivationReadinessSection validation={readModel.validationReadiness} />
      <ActivationDecisionModule readModel={readModel} />

      <ProviderVersionHistory readModel={readModel} providerKey={providerKey} />

      <ProviderParticipatingUnits readModel={readModel} providerKey={providerKey} />
      <ProviderRecentJobs readModel={readModel} providerKey={providerKey} />
    </DenseAdminWorkbench>
  );
}

function CommandFeedbackBanner({ feedback }: Readonly<{ feedback: CatalogPrimaryWorkbenchCommandFeedback }>) {
  return (
    <OperationalStatusBanner
      tone={feedback.status === "success" ? "success" : "warning"}
      title={feedback.status === "success" ? commandSuccessTitle(feedback.result) : commandErrorTitle(feedback.result)}
      description={commandFeedbackDescription(feedback)}
    />
  );
}

// Participating units with their scopes (m88 provider-scope-mapping units) — the
// remaining "one page" content item from the issue's "what to do" list.
function ProviderParticipatingUnits({
  readModel,
  providerKey,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  providerKey: string | null;
}>) {
  const provider = providerKey
    ? readModel.providerScope.providers.find((candidate) => candidate.providerKey === providerKey)
    : null;
  const units = provider?.units ?? [];

  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.providerDetail.units.title")}
      description={t("catalog.features.sourceObservations.ui.providerDetail.units.description")}
      status={<Badge tone="neutral">{units.length}</Badge>}
      density="compact"
    >
      {units.length === 0 ? (
        <EmptyState
          title={t("catalog.features.sourceObservations.ui.providerDetail.units.emptyTitle")}
          description={t("catalog.features.sourceObservations.ui.providerDetail.units.emptyDescription")}
        />
      ) : (
        <WorkbenchStack gap="sm">
          {units.map((unit) => (
            <ProviderParticipatingUnit key={unit.unitKey} readModel={readModel} unit={unit} />
          ))}
        </WorkbenchStack>
      )}
    </WorkflowModule>
  );
}

function ProviderParticipatingUnit({
  readModel,
  unit,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  unit: CatalogPrimaryWorkbenchReadModel["providerScope"]["providers"][number]["units"][number];
}>) {
  const health = readModel.healthTriage.units.find((candidate) => candidate.unitKey === unit.unitKey);
  const none = t("catalog.features.sourceObservations.ui.primaryWorkbench.none");

  return (
    <KeyValueList
      density="compact"
      variant="surface"
      items={[
        { key: unit.unitKey, value: `${unit.productDomain}/${unit.productForm}` },
        {
          key: t("catalog.features.sourceObservations.ui.providerDetail.units.scopes"),
          value: unit.importScopes.join(", ") || none,
        },
        {
          key: t("catalog.features.sourceObservations.ui.providerDetail.units.activeProfile"),
          value:
            unit.activeProfile?.profileVersion ??
            t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.catalog.semantic"),
          value: health ? stateLabel(health.semanticReadiness) : none,
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.provider.transport"),
          value: health ? stateLabel(health.transportReadiness) : none,
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.freshness"),
          value: `${stateLabel(readModel.healthTriage.freshness)} · ${formatDateTime(readModel.healthTriage.generatedAt)}`,
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.diagnostics"),
          value: health?.latestDiagnosticText ?? none,
        },
      ]}
    />
  );
}

type ProviderRecentJob = CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"][number];

// Open disclosures are remembered by provider and job ID, never by row
// position, so a refreshed or reordered snapshot keeps each one attached to
// its own retained job.
type OpenProviderJobs = Readonly<{ providerKey: string; jobIds: readonly string[] }>;

function ProviderRecentJobs({
  readModel,
  providerKey,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  providerKey: string | null;
}>) {
  const jobs = providerKey ? readModel.importJobs.jobs.filter((job) => job.providerKey === providerKey) : [];
  const lastJob = jobs[0] ?? null;
  const inspectable = providerKey === operatorSessionProviderKey;
  const [openJobs, setOpenJobs] = useState<OpenProviderJobs | null>(null);
  const openJobIds =
    openJobs && openJobs.providerKey === providerKey
      ? openJobs.jobIds.filter((jobId) => jobs.some((job) => job.jobId === jobId))
      : [];
  if (openJobs && openJobIds.length !== openJobs.jobIds.length) {
    // A job that left the retained window, or a provider change, closes its
    // disclosure for good rather than reopening if the ID comes back.
    setOpenJobs(providerKey && openJobIds.length > 0 ? { providerKey, jobIds: openJobIds } : null);
  }
  const setJobOpen = (jobId: string, open: boolean) => {
    if (!providerKey) return;
    setOpenJobs((current) => {
      const currentIds = current?.providerKey === providerKey ? current.jobIds.filter((id) => id !== jobId) : [];
      const nextIds = open ? [...currentIds, jobId] : currentIds;
      return nextIds.length > 0 ? { providerKey, jobIds: nextIds } : null;
    });
  };
  const columns: DataColumn<ProviderRecentJob>[] = [
    {
      key: "job",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.job"),
      cell: (job) =>
        inspectable ? (
          <ProgressiveDisclosure
            title={job.jobId}
            description={job.summary}
            open={openJobIds.includes(job.jobId)}
            onOpenChange={(open) => setJobOpen(job.jobId, open)}
            data-catalog-provider-job-disclosure={job.jobId}
          >
            <ProviderJobOutcome job={job} />
          </ProgressiveDisclosure>
        ) : (
          <WorkbenchDataCell title={job.jobId} description={job.summary} />
        ),
    },
    {
      key: "state",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.status"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.status"),
      cell: (job) => <Badge tone={jobStateTone(job.state)}>{stateLabel(job.operatorStatus)}</Badge>,
    },
    {
      key: "scope",
      header: t("catalog.features.sourceObservations.ui.providerDetail.jobs.scope"),
      mobileLabel: t("catalog.features.sourceObservations.ui.providerDetail.jobs.scope"),
      cell: (job) => job.importScope ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
    },
    {
      key: "created",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.generated"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.generated"),
      cell: (job) => formatDateTime(job.createdAt),
    },
  ];

  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.providerDetail.jobs.title")}
      description={t("catalog.features.sourceObservations.ui.providerDetail.jobs.description")}
      status={
        <Badge tone="neutral">
          {lastJob
            ? formatDateTime(lastJob.createdAt)
            : t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected")}
        </Badge>
      }
      density="compact"
      data-catalog-provider-recent-jobs="true"
    >
      <DataTable
        rows={jobs}
        columns={columns}
        caption={t("catalog.features.sourceObservations.ui.providerDetail.jobs.title")}
        getRowId={(job) => job.jobId}
        density="compact"
        emptyTitle={t("catalog.features.sourceObservations.ui.providerDetail.jobs.emptyTitle")}
        emptyDescription={t("catalog.features.sourceObservations.ui.providerDetail.jobs.emptyDescription")}
      />
    </WorkflowModule>
  );
}

// Only the retained progress, failure groups, and result/usage counters render
// here. Missing result or usage evidence reads Unavailable, never zero.
function ProviderJobOutcome({ job }: Readonly<{ job: ProviderRecentJob }>) {
  const unavailable = t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.usage.unavailable");

  return (
    <KeyValueList
      density="compact"
      layout="grid"
      items={[
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.progress"),
          value: (
            <WorkbenchStack gap="sm">
              <WorkbenchText size="xs">
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.operator.status", {
                  status: stateLabel(job.operatorStatus),
                })}
              </WorkbenchText>
              <WorkbenchText size="xs">
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.progress.value", {
                  completed: job.completed,
                  total: job.total,
                  percent: job.progressPercent,
                })}
              </WorkbenchText>
            </WorkbenchStack>
          ),
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.failures"),
          value: (
            <BadgeCluster
              items={job.failureGroups.map((group) => ({
                key: group.key,
                tone: group.severity === "error" ? "danger" : "warning",
                label: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.failure.group", {
                  label: failureGroupLabel(group),
                  count: group.count,
                }),
              }))}
              emptyLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}
            />
          ),
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.observed"),
          value: job.result ? job.result.observedCount : unavailable,
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.skipped"),
          value: job.result ? job.result.skippedCount : unavailable,
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.failed"),
          value: job.result ? job.result.failedCount : unavailable,
        },
        {
          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.usage"),
          value: <ProviderJobUsage usage={job.result?.usage ?? null} unavailable={unavailable} />,
        },
      ]}
    />
  );
}

function ProviderJobUsage({
  usage,
  unavailable,
}: Readonly<{
  usage: NonNullable<ProviderRecentJob["result"]>["usage"];
  unavailable: string;
}>) {
  if (!usage) {
    return <WorkbenchText size="xs">{unavailable}</WorkbenchText>;
  }

  // The cache line needs both counters, so it is hidden rather than half-filled
  // when either one was not retained.
  const hasCacheCounts = usage.cacheHitCount !== null && usage.cacheMissCount !== null;

  return (
    <WorkbenchStack gap="sm">
      <WorkbenchText size="xs">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.usage.requests", {
          count: usage.actualRequestCount ?? unavailable,
        })}
      </WorkbenchText>
      <WorkbenchText size="xs">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.usage.pages", {
          count: usage.pageCount ?? unavailable,
        })}
      </WorkbenchText>
      {hasCacheCounts ? (
        <WorkbenchText size="xs">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.usage.cache", {
            hits: usage.cacheHitCount,
            misses: usage.cacheMissCount,
          })}
        </WorkbenchText>
      ) : null}
    </WorkbenchStack>
  );
}

// Private copy of the import-jobs module mapper: the DTO label is the raw
// machine key, so groups are localized by key with the approved copy.
function failureGroupLabel(group: ProviderRecentJob["failureGroups"][number]): string {
  if (group.key === "durable-job-cancelled") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.failure.cancelled");
  }
  if (group.key === "durable-job-failed") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.failure.durable");
  }
  if (group.key === "partial-provider-data") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.failure.partial");
  }
  if (group.key === "stale-replay") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.failure.stale.replay");
  }
  if (group.key.startsWith("provider-transport-")) {
    const category = group.key.replace(/^provider-transport-/, "") as CatalogPrimaryWorkbenchProviderTransportCategory;

    return t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.failure.transport", {
      category: getCatalogPrimaryWorkbenchProviderTransportCopy(category).label,
    });
  }

  return group.label;
}

function jobStateTone(state: string): "success" | "danger" | "warning" | "neutral" {
  if (state === "completed") return "success";
  if (state === "failed" || state === "cancelled") return "danger";
  if (state === "queued" || state === "running") return "warning";
  return "neutral";
}
