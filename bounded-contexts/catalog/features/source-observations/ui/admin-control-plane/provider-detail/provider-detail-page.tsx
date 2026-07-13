import {
  Badge,
  Button,
  DataTable,
  DenseAdminWorkbench,
  DenseAdminWorkbenchHeader,
  EmptyState,
  KeyValueList,
  OperationalStatusBanner,
  TextInput,
  WorkbenchDataCell,
  WorkbenchForm,
  WorkbenchGrid,
  WorkbenchStack,
  WorkflowModule,
  type DataColumn,
} from "@chase-sets/design-system";
import { formatDateTime, t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../primary-workbench-command-feedback";
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
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
}>) {
  const authoring = readModel.profileAuthoring;
  const selectedProfile = authoring.selectedProfile;
  const providerKey = readModel.routeContext.providerKey ?? selectedProfile?.providerKey ?? null;
  const cloneDraft = authoring.cloneDraft;
  const cloneDisabled = cloneDraft.state !== "available" && cloneDraft.state !== "degraded";
  const submitHref = catalogProviderDetailHref(providerKey);

  return (
    <DenseAdminWorkbench data-catalog-provider-detail="true">
      <DenseAdminWorkbenchHeader
        eyebrow={t("catalog.features.sourceObservations.ui.providerDetail.eyebrow")}
        title={providerKey ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected")}
        description={t("catalog.features.sourceObservations.ui.providerDetail.description")}
      />

      {commandFeedback ? <CommandFeedbackBanner feedback={commandFeedback} /> : null}

      <ProviderDetailHeader readModel={readModel} providerKey={providerKey} />

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
            data-catalog-primary-workbench-command="clone-provider-profile"
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
            <KeyValueList
              key={unit.unitKey}
              density="compact"
              variant="surface"
              items={[
                { key: unit.unitKey, value: `${unit.productDomain}/${unit.productForm}` },
                {
                  key: t("catalog.features.sourceObservations.ui.providerDetail.units.scopes"),
                  value:
                    unit.importScopes.join(", ") || t("catalog.features.sourceObservations.ui.primaryWorkbench.none"),
                },
                {
                  key: t("catalog.features.sourceObservations.ui.providerDetail.units.activeProfile"),
                  value:
                    unit.activeProfile?.profileVersion ??
                    t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
                },
              ]}
            />
          ))}
        </WorkbenchStack>
      )}
    </WorkflowModule>
  );
}

// Recent jobs for this provider — the "recent jobs" content item. There is no
// provider option-sync schedule/cadence capability anywhere in the codebase
// today (verified before implementing this page), so this section reports the
// most recent import activity as the honest "last refresh" signal rather than
// fabricating a schedule feature that does not exist.
function ProviderRecentJobs({
  readModel,
  providerKey,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  providerKey: string | null;
}>) {
  const jobs = providerKey ? readModel.importJobs.jobs.filter((job) => job.providerKey === providerKey) : [];
  const lastJob = jobs[0] ?? null;
  const columns: DataColumn<(typeof jobs)[number]>[] = [
    {
      key: "job",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.job"),
      cell: (job) => <WorkbenchDataCell title={job.jobId} description={job.summary} />,
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

function jobStateTone(state: string): "success" | "danger" | "warning" | "neutral" {
  if (state === "completed") return "success";
  if (state === "failed" || state === "cancelled") return "danger";
  if (state === "queued" || state === "running") return "warning";
  return "neutral";
}
