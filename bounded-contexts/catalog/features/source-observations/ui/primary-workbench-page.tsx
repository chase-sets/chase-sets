import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Badge,
  BulkActionBar,
  BulkActionPanel,
  BulkActionSurface,
  Button,
  DataTable,
  DenseAdminWorkbench,
  DenseAdminWorkbenchHeader,
  DenseAdminWorkbenchLayout,
  EmptyState,
  FilterArea,
  BadgeCluster,
  EvidenceStringList,
  HiddenInput,
  KeyValueList,
  LinkButton,
  LinkText,
  MetricStrip,
  OperationalStatusBanner,
  SideSheet,
  StatusReasonList,
  TextInput,
  WorkbenchActionRow,
  WorkbenchDataCell,
  WorkbenchDetailPanel,
  WorkbenchForm,
  WorkbenchGrid,
  WorkbenchGridSpan,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
  WorkflowReadinessChecklist,
  type DataColumn,
  type ButtonProps,
  type SectionNavigationGroup,
  type WorkflowReadinessItem,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchActionReadModel,
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchProviderTransportCategory,
  CatalogPrimaryWorkbenchReadModel,
} from "../api/primary-workbench-admin-contracts";
import {
  CATALOG_CONTROL_PLANE_NAVIGATION_GROUPS,
  CATALOG_CONTROL_PLANE_WORKSPACES,
} from "./admin-control-plane/information-architecture";
import { CatalogIntegrationConflictResolutionWorkspace } from "./admin-control-plane/conflicts/conflict-resolution-workspace";
import { CatalogIntegrationAuditEvidenceWorkspace } from "./admin-control-plane/evidence/audit-evidence-workspace";
import { CatalogIntegrationCleanResetReleaseWorkspace } from "./admin-control-plane/evidence/clean-reset-release-workspace";
import { CatalogIntegrationGovernanceControlsWorkspace } from "./admin-control-plane/governance/governance-controls-workspace";
import { CatalogIntegrationHealthTriageWorkspace } from "./admin-control-plane/health/integration-health-dashboard";
import { CatalogIntegrationLifecycleRecoveryWorkspace } from "./admin-control-plane/lifecycle/lifecycle-recovery-workspace";
import { CatalogIntegrationProfileAuthoringWorkspace } from "./admin-control-plane/profiles/profile-authoring-workspace";
import { CatalogIntegrationValidationReadinessWorkspace } from "./admin-control-plane/validation/validation-readiness-workspace";
import {
  catalogPrimaryWorkbenchHref,
  catalogPrimaryWorkbenchSupportingHref,
  normalizeCatalogPrimaryWorkbenchSection,
} from "./primary-workbench-route-context";
import {
  catalogPrimaryWorkbenchProviderTransportSummary,
  getCatalogPrimaryWorkbenchBlockerCopy,
  getCatalogPrimaryWorkbenchProviderTransportCopy,
} from "./primary-workbench-copy";

type PrimaryWorkbenchStepKey = "provider" | "import" | "review" | "preview" | "promote";

type PrimaryWorkbenchStep = Readonly<{
  key: PrimaryWorkbenchStepKey;
  label: string;
  evidence: string;
  action: string;
  state: CatalogPrimaryWorkbenchActionState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
}>;

type ImportJobRow = CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"][number];
type SourceObservationReviewRow = CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number];
type CatalogPrimaryWorkbenchSubmitIntent = Extract<
  CatalogPrimaryWorkbenchActionReadModel["key"],
  | "start-provider-import"
  | "retry-import-job"
  | "resume-import-job"
  | "cancel-import-job"
  | "preview-promotion"
  | "execute-promotion"
  | "reject-source-observations"
  | "defer-source-observations"
  | "rollback-provider-profile"
  | "deprecate-provider-profile"
  | "retire-provider-profile"
  | "start-reapply"
  | "start-replay"
>;

export type CatalogPrimaryWorkbenchCommandFeedback = Readonly<{
  status: "success" | "error";
  intent: string;
  result:
    | "job-queued"
    | "job-cancelled"
    | "preview-ready"
    | "draft-created"
    | "profile-activated"
    | "profile-rolled-back"
    | "profile-deprecated"
    | "profile-retired"
    | "section-saved"
    | "section-conflict"
    | "section-invalid"
    | "lifecycle-conflict"
    | "confirmation-required"
    | "preview-required"
    | "job-required"
    | "reason-required"
    | "unsupported-command"
    | "invalid-intent"
    | "command-failed";
}>;

export interface CatalogPrimaryWorkbenchPageProps {
  readModel: CatalogPrimaryWorkbenchReadModel;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
}

export function CatalogPrimaryWorkbenchPage({ readModel, commandFeedback = null }: CatalogPrimaryWorkbenchPageProps) {
  const navigation = useMemo(() => navigationGroups(readModel), [readModel]);
  const [activeSection, setActiveSection] = useState(() => normalizeActiveWorkspace(readModel.routeContext.section));
  useEffect(() => {
    setActiveSection(normalizeActiveWorkspace(readModel.routeContext.section));
  }, [readModel.routeContext.section]);
  useEffect(() => {
    const handlePopState = () => {
      setActiveSection(
        normalizeActiveWorkspace(new URL(window.location.href).searchParams.get("section") ?? undefined),
      );
    };

    window.addEventListener("popstate", handlePopState);

    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
  const handleSectionSelect = (key: string) => {
    const normalized = normalizeActiveWorkspace(key);
    setActiveSection(normalized);
    if (typeof window === "undefined") {
      return;
    }

    const href = findNavigationHref(navigation, key) ?? findNavigationHref(navigation, normalized);
    if (href) {
      window.history.pushState({ catalogPrimaryWorkbenchSection: normalized }, "", href);
    }
  };
  const steps = useMemo(() => [...buildSteps(readModel)], [readModel]);
  const selectableStepKeys = useMemo(
    () =>
      new Set<string>(
        steps.filter((step) => step.state === "available" || step.state === "degraded").map((step) => step.key),
      ),
    [steps],
  );
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set(["review", "preview"]));
  const selectedCount = [...selectedKeys].filter((key) => selectableStepKeys.has(key)).length;
  const [selectedObservationKeys, setSelectedObservationKeys] = useState<Set<string>>(
    () => new Set(readModel.sourceObservationReview.selectedObservationIds),
  );
  const selectedObservationRouteKey = readModel.sourceObservationReview.selectedObservationIds.join("\u001f");
  useEffect(() => {
    setSelectedObservationKeys(
      new Set(selectedObservationRouteKey.length > 0 ? selectedObservationRouteKey.split("\u001f") : []),
    );
  }, [selectedObservationRouteKey]);
  const selectedObservationRows = readModel.sourceObservationReview.rows.filter((row) =>
    selectedObservationKeys.has(row.observationId),
  );
  const selectedEligibleObservationCount = selectedObservationRows.filter(
    (row) => row.promotionReadiness.state === "eligible",
  ).length;
  const selectedReviewableObservationCount = selectedObservationRows.filter(isReviewableObservationRow).length;
  const implementedSupportWorkspace =
    activeSection === "health-triage" ? (
      <CatalogIntegrationHealthTriageWorkspace readModel={readModel} />
    ) : activeSection === "profile-authoring" ? (
      <CatalogIntegrationProfileAuthoringWorkspace readModel={readModel} />
    ) : activeSection === "validation-readiness" ? (
      <CatalogIntegrationValidationReadinessWorkspace readModel={readModel} />
    ) : activeSection === "conflict-resolution" ? (
      <CatalogIntegrationConflictResolutionWorkspace readModel={readModel} />
    ) : activeSection === "lifecycle-recovery" ? (
      <CatalogIntegrationLifecycleRecoveryWorkspace readModel={readModel} />
    ) : activeSection === "governance-controls" ? (
      <CatalogIntegrationGovernanceControlsWorkspace readModel={readModel} />
    ) : activeSection === "clean-reset-release" ? (
      <CatalogIntegrationCleanResetReleaseWorkspace readModel={readModel} />
    ) : activeSection === "audit-evidence" ? (
      <CatalogIntegrationAuditEvidenceWorkspace readModel={readModel} />
    ) : null;
  const columns = useMemo<DataColumn<PrimaryWorkbenchStep>[]>(
    () => [
      {
        key: "step",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.primary.step"),
        sortable: true,
        cell: (step) => (
          <WorkbenchDataCell title={step.label} description={step.evidence} descriptionTone="secondary" />
        ),
      },
      {
        key: "state",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.state"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.state"),
        cell: (step) => <Badge tone={actionTone(step.state)}>{stateLabel(step.state)}</Badge>,
      },
      {
        key: "blockers",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.blockers"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.blockers"),
        cell: (step) => <BlockerList blockers={step.blockers} />,
      },
      {
        key: "action",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.action"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.action"),
        align: "right",
        cell: (step) => (
          <WorkbenchActionRow>
            <StepEvidenceSheet step={step} readModel={readModel} />
            <PrimaryStepAction readModel={readModel} step={step} />
          </WorkbenchActionRow>
        ),
      },
    ],
    [readModel],
  );
  const jobColumns = useMemo<DataColumn<ImportJobRow>[]>(
    () => [
      {
        key: "job",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.job"),
        sortable: true,
        cell: (job) => (
          <WorkbenchDataCell
            title={job.summary}
            description={t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.profile", {
              profile: profileSnapshotLabel(job.profileSnapshot, job.profileVersion),
            })}
            detail={t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.context.unit", {
              unit: job.unitKey ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
            })}
            badges={
              <BadgeCluster
                items={[
                  {
                    key: "scope-route",
                    label: job.scopeMatchesRoute
                      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.context.current.scope")
                      : t(
                          "catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.context.overlapping.scope",
                        ),
                    tone: job.scopeMatchesRoute ? "success" : "warning",
                  },
                  {
                    key: "scope",
                    label: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.context.scope", {
                      scope:
                        job.importScope ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
                    }),
                    tone: "neutral",
                  },
                ]}
              />
            }
          />
        ),
      },
      {
        key: "progress",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.progress"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.progress"),
        cell: (job) => (
          <WorkbenchStack gap="sm">
            <Badge tone={jobStateTone(job.state)}>{stateLabel(job.state)}</Badge>
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
            <WorkbenchText size="xs">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.created", {
                value: job.createdAt,
              })}
            </WorkbenchText>
            <WorkbenchText size="xs">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.started", {
                value:
                  job.startedAt ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.not.started"),
              })}
            </WorkbenchText>
          </WorkbenchStack>
        ),
      },
      {
        key: "consistency",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.consistency"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.consistency"),
        cell: (job) => (
          <WorkbenchStack gap="sm">
            <WorkbenchText size="xs">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.profile.snapshot", {
                profile: profileSnapshotLabel(job.profileSnapshot, job.profileVersion),
              })}
            </WorkbenchText>
            <BadgeCluster
              items={[
                { key: "duplicate", label: stateLabel(job.consistency.duplicateSubmissionPolicy), tone: "neutral" },
                { key: "retry", label: stateLabel(job.consistency.retryResumePolicy), tone: "neutral" },
                { key: "partial", label: stateLabel(job.consistency.partialFailurePolicy), tone: "neutral" },
                { key: "claim", label: stateLabel(job.consistency.workUnitClaimPolicy), tone: "neutral" },
              ]}
            />
            <BlockerList blockers={job.blockers} compact hideWhenEmpty />
          </WorkbenchStack>
        ),
      },
      {
        key: "failures",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.failures"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.failures"),
        cell: (job) =>
          job.failureGroups.length > 0 ? (
            <BadgeCluster
              items={job.failureGroups.map((group) => ({
                key: group.key,
                tone: group.severity === "error" ? "danger" : "warning",
                label: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.failure.group", {
                  label: failureGroupLabel(group),
                  count: group.count,
                }),
              }))}
            />
          ) : (
            <Badge tone="success">{t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}</Badge>
          ),
      },
      {
        key: "actions",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.action"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.action"),
        align: "right",
        cell: (job) => (
          <WorkbenchActionRow>
            {job.retryAvailable ? (
              <ImportJobLifecycleAction readModel={readModel} job={job} intent="retry-import-job">
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.retry")}
              </ImportJobLifecycleAction>
            ) : null}
            {job.resumeAvailable ? (
              <ImportJobLifecycleAction readModel={readModel} job={job} intent="resume-import-job">
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.resume")}
              </ImportJobLifecycleAction>
            ) : null}
            {job.cancelAvailable ? (
              <ImportJobLifecycleAction readModel={readModel} job={job} intent="cancel-import-job" tone="danger">
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.cancel")}
              </ImportJobLifecycleAction>
            ) : null}
            <LinkText href={job.sourceObservationReviewHref}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.review.link")}
            </LinkText>
            <LinkText href={job.auditEvidenceUrl}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.evidence.link")}
            </LinkText>
          </WorkbenchActionRow>
        ),
      },
    ],
    [readModel],
  );
  const reviewColumns = useMemo<DataColumn<SourceObservationReviewRow>[]>(
    () => [
      {
        key: "observation",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.table.observation"),
        sortable: true,
        cell: (row) => (
          <WorkbenchDataCell
            title={row.displayName}
            truncateTitle
            description={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.table.external", {
              provider: row.providerKey,
              external: row.externalKey,
            })}
            badges={
              <BadgeCluster
                items={row.normalizedFactSummaries.slice(0, 3).map((fact) => ({
                  key: fact,
                  label: fact,
                  tone: "neutral",
                }))}
              />
            }
          />
        ),
      },
      {
        key: "status",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.table.status"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.table.status"),
        cell: (row) => (
          <WorkbenchStack gap="sm">
            <Badge tone={sourceObservationStatusTone(row.status)}>{stateLabel(row.status)}</Badge>
            <WorkbenchText size="xs">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.table.changed", {
                value: row.sourceUpdatedAt ?? row.changedAt,
              })}
            </WorkbenchText>
          </WorkbenchStack>
        ),
      },
      {
        key: "evidence",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.table.evidence"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.table.evidence"),
        cell: (row) => (
          <WorkbenchDataCell
            title={row.payloadSummary}
            titleWeight="regular"
            detail={row.redactionSummary}
            badges={
              row.duplicateEvidence.length > 0 ? (
                <Badge tone="warning">
                  {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.duplicate.count", {
                    count: row.duplicateEvidence.length,
                  })}
                </Badge>
              ) : null
            }
          />
        ),
      },
      {
        key: "readiness",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.table.readiness"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.table.readiness"),
        cell: (row) => (
          <WorkbenchStack gap="sm">
            <Badge tone={row.promotionReadiness.state === "eligible" ? "success" : "warning"}>
              {stateLabel(row.promotionReadiness.state)}
            </Badge>
            <BlockerList blockers={row.promotionReadiness.blockers} />
          </WorkbenchStack>
        ),
      },
      {
        key: "actions",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.action"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.action"),
        align: "right",
        cell: (row) => {
          const rowActionBlockers = uniqueBlockers(row.actions.flatMap((actionEntry) => actionEntry.blockers));

          return (
            <WorkbenchStack gap="sm">
              <WorkbenchActionRow>
                <SourceObservationEvidenceSheet row={row} />
                {row.actions
                  .filter((actionEntry) => actionEntry.key !== "view-source-observation")
                  .map((actionEntry) => (
                    <RowCommandAction key={actionEntry.key} actionEntry={actionEntry} readModel={readModel} row={row} />
                  ))}
              </WorkbenchActionRow>
              <BlockerList blockers={rowActionBlockers} compact hideWhenEmpty />
            </WorkbenchStack>
          );
        },
      },
    ],
    [readModel],
  );

  return (
    <DenseAdminWorkbench data-catalog-primary-workbench="true">
      <DenseAdminWorkbenchHeader
        eyebrow={t("catalog.features.sourceObservations.ui.primaryWorkbench.eyebrow")}
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.title")}
        description={t("catalog.features.sourceObservations.ui.primaryWorkbench.description")}
        actions={
          <>
            <CommandFormButton readModel={readModel} intent="start-provider-import" leadingIcon="refreshCcw">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.pull.provider.data")}
            </CommandFormButton>
            <CommandFormButton readModel={readModel} intent="preview-promotion" tone="secondary" leadingIcon="check">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.promotion")}
            </CommandFormButton>
          </>
        }
      />

      {commandFeedback ? <CommandFeedbackBanner feedback={commandFeedback} /> : null}

      <MetricStrip
        items={[
          {
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.observed"),
            value: String(readModel.sourceObservationReview.counts.observed),
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.changed", {
              count: readModel.sourceObservationReview.counts.changed,
            }),
          },
          {
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.ready.for.preview"),
            value: String(readModel.sourceObservationReview.promotionReadyCount),
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.promotion.candidates"),
          },
          {
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.active.jobs"),
            value: String(readModel.importJobs.activeJobCount),
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.job.view", {
              freshness: readModel.importJobs.freshness,
            }),
          },
          {
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.blockers"),
            value: String(readModel.readiness.blockers.length + readModel.promotionPreview.blockers.length),
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.fail.closed"),
          },
        ]}
      />

      <DenseAdminWorkbenchLayout
        navigationGroups={navigation}
        activeNavigationKey={activeSection}
        navigationLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.navigation.label")}
        mobileNavigationLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.navigation.mobile.label")}
        onNavigationSelect={handleSectionSelect}
      >
        <BulkActionSurface>
          <WorkbenchStack>
            {implementedSupportWorkspace ?? (
              <>
                <OperationalStatusBanner
                  tone={readModel.readiness.blockers.length > 0 ? "warning" : "success"}
                  title={
                    readModel.readiness.blockers.length > 0
                      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.banner.blocked.title")
                      : t("catalog.features.sourceObservations.ui.primaryWorkbench.banner.ready.title")
                  }
                  description={
                    readModel.readiness.blockers.length > 0
                      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.banner.blocked.description")
                      : t("catalog.features.sourceObservations.ui.primaryWorkbench.banner.ready.description")
                  }
                  action={
                    <LinkButton
                      size="sm"
                      tone="secondary"
                      leadingIcon="externalLink"
                      href={
                        readModel.readiness.auditEvidenceUrl ??
                        catalogPrimaryWorkbenchSupportingHref(readModel.routeContext, "audit-evidence")
                      }
                    >
                      {t("catalog.features.sourceObservations.ui.primaryWorkbench.view.supporting.evidence")}
                    </LinkButton>
                  }
                />

                <WorkflowModule
                  title={t("catalog.features.sourceObservations.ui.primaryWorkbench.module.title")}
                  description={t("catalog.features.sourceObservations.ui.primaryWorkbench.module.description")}
                  status={
                    <Badge tone="accent">
                      {t("catalog.features.sourceObservations.ui.primaryWorkbench.default.workspace")}
                    </Badge>
                  }
                  actions={
                    <>
                      <LinkButton
                        size="sm"
                        tone="secondary"
                        leadingIcon="filter"
                        href={catalogPrimaryWorkbenchHref(readModel.routeContext, "source-observation-review")}
                      >
                        {t("catalog.features.sourceObservations.ui.primaryWorkbench.save.context")}
                      </LinkButton>
                      <CommandFormButton
                        readModel={readModel}
                        intent="start-provider-import"
                        size="sm"
                        leadingIcon="refreshCcw"
                      >
                        {t("catalog.features.sourceObservations.ui.primaryWorkbench.pull.provider.data")}
                      </CommandFormButton>
                    </>
                  }
                  headingLevel={2}
                  density="compact"
                >
                  <FilterArea
                    sticky={false}
                    activeFilterCount={activeFilterCount(readModel)}
                    panelTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.context.preservation.title")}
                    panelDescription={t(
                      "catalog.features.sourceObservations.ui.primaryWorkbench.context.preservation.description",
                    )}
                    actions={
                      <LinkButton
                        size="sm"
                        tone="secondary"
                        href={catalogPrimaryWorkbenchHref(
                          {
                            ...readModel.routeContext,
                            sourceObservationFilters: {},
                            selectedObservationIds: [],
                            promotionPreviewId: null,
                          },
                          "import-to-promotion",
                        )}
                      >
                        {t("catalog.features.sourceObservations.ui.primaryWorkbench.reset.view")}
                      </LinkButton>
                    }
                  >
                    <Badge tone="info">
                      {t("catalog.features.sourceObservations.ui.primaryWorkbench.context.provider", {
                        value:
                          readModel.routeContext.providerKey ??
                          t("catalog.features.sourceObservations.ui.primaryWorkbench.choose.provider"),
                      })}
                    </Badge>
                    <Badge tone="info">
                      {t("catalog.features.sourceObservations.ui.primaryWorkbench.context.unit", {
                        value:
                          readModel.routeContext.unitKey ??
                          t("catalog.features.sourceObservations.ui.primaryWorkbench.choose.unit"),
                      })}
                    </Badge>
                    <Badge tone="neutral">
                      {t("catalog.features.sourceObservations.ui.primaryWorkbench.context.scope", {
                        value:
                          readModel.routeContext.importScope ??
                          t("catalog.features.sourceObservations.ui.primaryWorkbench.choose.scope"),
                      })}
                    </Badge>
                    <Badge tone="neutral">
                      {t("catalog.features.sourceObservations.ui.primaryWorkbench.context.profile", {
                        value:
                          readModel.routeContext.profileVersion ??
                          t("catalog.features.sourceObservations.ui.primaryWorkbench.no.active.profile"),
                      })}
                    </Badge>
                  </FilterArea>

                  {readModel.providerScope.providers.length === 0 ? (
                    <EmptyState
                      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.empty.provider.scopes.title")}
                      description={t(
                        "catalog.features.sourceObservations.ui.primaryWorkbench.empty.provider.scopes.description",
                      )}
                      actions={
                        <Button tone="secondary">
                          {t("catalog.features.sourceObservations.ui.primaryWorkbench.open.profile.authoring")}
                        </Button>
                      }
                    />
                  ) : null}

                  <DataTable
                    rows={steps}
                    columns={columns}
                    getRowId={(step) => step.key}
                    selectedKeys={selectedKeys}
                    onSelectionChange={setSelectedKeys}
                    isRowSelectable={(step) => selectableStepKeys.has(step.key)}
                    density="compact"
                    emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.empty.steps.title")}
                    emptyDescription={t(
                      "catalog.features.sourceObservations.ui.primaryWorkbench.empty.steps.description",
                    )}
                  />

                  {selectedCount > 0 ? (
                    <BulkActionBar
                      count={selectedCount}
                      formatSelectedLabel={(count) => `${count} primary step${count === 1 ? "" : "s"} selected`}
                      primaryActions={
                        <BulkActionPanel
                          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.panel.title")}
                          description={t(
                            "catalog.features.sourceObservations.ui.primaryWorkbench.preview.panel.description",
                          )}
                          triggerLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.configure.preview")}
                          footer={
                            <CommandFormButton readModel={readModel} intent="preview-promotion" size="sm">
                              {t("catalog.features.sourceObservations.ui.primaryWorkbench.queue.preview")}
                            </CommandFormButton>
                          }
                        >
                          <KeyValueList
                            items={[
                              {
                                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.eligible.observations"),
                                value: readModel.sourceObservationReview.promotionReadyCount,
                              },
                              {
                                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.plan"),
                                value:
                                  readModel.promotionPreview.commandPlanHash ??
                                  t("catalog.features.sourceObservations.ui.primaryWorkbench.review.preview.required"),
                              },
                              {
                                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.failure.mode"),
                                value: t("catalog.features.sourceObservations.ui.primaryWorkbench.failure.mode.value"),
                              },
                            ]}
                          />
                        </BulkActionPanel>
                      }
                      secondaryActions={
                        <Button size="sm" tone="secondary" onClick={() => setSelectedKeys(new Set())}>
                          {t("catalog.features.sourceObservations.ui.primaryWorkbench.clear.selection")}
                        </Button>
                      }
                      overflowActions={[
                        {
                          key: "copy-context",
                          label: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.route.context"),
                          icon: "copy",
                        },
                        {
                          key: "audit-evidence",
                          label: t("catalog.features.sourceObservations.ui.primaryWorkbench.open.audit.evidence"),
                          icon: "externalLink",
                        },
                      ]}
                    />
                  ) : null}
                </WorkflowModule>

                <WorkflowModule
                  title={t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.title")}
                  description={t(
                    "catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.description",
                  )}
                  status={
                    <Badge tone={readModel.importJobs.activeJobCount > 0 ? "warning" : "success"}>
                      {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.status", {
                        count: readModel.importJobs.activeJobCount,
                      })}
                    </Badge>
                  }
                  actions={
                    <CommandFormButton
                      readModel={readModel}
                      intent="start-provider-import"
                      size="sm"
                      leadingIcon="refreshCcw"
                    >
                      {t("catalog.features.sourceObservations.ui.primaryWorkbench.pull.provider.data")}
                    </CommandFormButton>
                  }
                  headingLevel={2}
                  density="compact"
                >
                  {readModel.importJobs.selectedScope ? (
                    <WorkbenchGrid columns="equalDetail">
                      <KeyValueList
                        items={[
                          {
                            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.provider"),
                            value: readModel.importJobs.selectedScope.providerKey,
                          },
                          {
                            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.unit"),
                            value:
                              readModel.importJobs.selectedScope.unitKey ??
                              t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
                          },
                          {
                            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.scope"),
                            value: readModel.importJobs.selectedScope.importScope,
                          },
                          {
                            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.profile"),
                            value:
                              readModel.importJobs.selectedScope.profileVersion ??
                              t("catalog.features.sourceObservations.ui.primaryWorkbench.no.active.profile"),
                          },
                          {
                            key: t(
                              "catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.profile.snapshot",
                            ),
                            value: profileSnapshotLabel(
                              readModel.importJobs.selectedScope.profileSnapshot,
                              readModel.importJobs.selectedScope.profileVersion,
                            ),
                          },
                        ]}
                      />
                      <KeyValueList
                        items={[
                          {
                            key: t(
                              "catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.expected",
                            ),
                            value: readModel.importJobs.selectedScope.expectedObservationVolume,
                          },
                          {
                            key: t(
                              "catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.observed",
                            ),
                            value: readModel.importJobs.selectedScope.observedCount,
                          },
                          {
                            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.changed"),
                            value: readModel.importJobs.selectedScope.changedCount,
                          },
                          {
                            key: t(
                              "catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.promoted",
                            ),
                            value: readModel.importJobs.selectedScope.promotedCount,
                          },
                          {
                            key: t(
                              "catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.rejected",
                            ),
                            value: readModel.importJobs.selectedScope.rejectedCount,
                          },
                        ]}
                      />
                      <KeyValueList
                        items={[
                          {
                            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.adapter"),
                            value: stateLabel(readModel.importJobs.selectedScope.readiness.adapterReadiness),
                          },
                          {
                            key: t(
                              "catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.credentials",
                            ),
                            value: stateLabel(readModel.importJobs.selectedScope.readiness.credentialReadiness),
                          },
                          {
                            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.rollout"),
                            value: readModel.importJobs.selectedScope.readiness.rolloutEnabled
                              ? t("catalog.features.sourceObservations.ui.primaryWorkbench.ready")
                              : t("catalog.features.sourceObservations.ui.primaryWorkbench.blocked"),
                          },
                          {
                            key: t(
                              "catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.transport",
                            ),
                            value:
                              readModel.importJobs.selectedScope.readiness.providerTransport.length > 0
                                ? catalogPrimaryWorkbenchProviderTransportSummary(
                                    readModel.importJobs.selectedScope.readiness.providerTransport,
                                  )
                                : t(
                                    "catalog.features.sourceObservations.ui.primaryWorkbench.readiness.transport.ready.description",
                                  ),
                          },
                          {
                            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.blockers"),
                            value:
                              readModel.importJobs.selectedScope.readiness.blockers.length > 0
                                ? readModel.importJobs.selectedScope.readiness.blockers.length
                                : t("catalog.features.sourceObservations.ui.primaryWorkbench.none"),
                          },
                        ]}
                      />
                      <WorkbenchGridSpan>
                        <BlockerList blockers={readModel.importJobs.selectedScope.readiness.blockers} compact />
                      </WorkbenchGridSpan>
                    </WorkbenchGrid>
                  ) : (
                    <EmptyState
                      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.empty.title")}
                      description={t(
                        "catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.empty.description",
                      )}
                    />
                  )}

                  <DataTable
                    rows={[...readModel.importJobs.jobs]}
                    columns={jobColumns}
                    getRowId={(job) => job.jobId}
                    density="compact"
                    emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.empty.title")}
                    emptyDescription={t(
                      "catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.empty.description",
                    )}
                  />
                </WorkflowModule>

                <WorkflowModule
                  title={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.title")}
                  description={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.description")}
                  status={
                    <Badge tone={readModel.sourceObservationReview.rows.length > 0 ? "success" : "warning"}>
                      {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.status", {
                        count: readModel.sourceObservationReview.pagination.total,
                      })}
                    </Badge>
                  }
                  actions={
                    <>
                      <LinkButton
                        size="sm"
                        tone="secondary"
                        leadingIcon="filter"
                        href={catalogPrimaryWorkbenchHref(readModel.routeContext, "source-observation-review")}
                      >
                        {t("catalog.features.sourceObservations.ui.primaryWorkbench.save.context")}
                      </LinkButton>
                      <CommandFormButton readModel={readModel} intent="preview-promotion" size="sm" leadingIcon="check">
                        {t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.promotion")}
                      </CommandFormButton>
                    </>
                  }
                  headingLevel={2}
                  density="compact"
                >
                  <FilterArea
                    sticky={false}
                    activeFilterCount={
                      readModel.sourceObservationReview.filters.filter((filterEntry) => filterEntry.value).length
                    }
                    panelTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filters.title")}
                    panelDescription={t(
                      "catalog.features.sourceObservations.ui.primaryWorkbench.review.filters.description",
                    )}
                  >
                    {readModel.sourceObservationReview.filters.map((filterEntry) => (
                      <Badge key={filterEntry.key} tone={filterEntry.serverApplied ? "info" : "warning"}>
                        {filterEntry.label}:{" "}
                        {filterEntry.value ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected")}
                      </Badge>
                    ))}
                  </FilterArea>

                  <BadgeCluster
                    items={readModel.sourceObservationReview.savedFilters.map((savedFilter) => ({
                      key: savedFilter.key,
                      label:
                        savedFilter.label +
                        (savedFilter.count === null
                          ? ""
                          : t("catalog.features.sourceObservations.ui.primaryWorkbench.review.saved.count", {
                              value: savedFilter.count,
                            })),
                      tone: "neutral",
                    }))}
                  />

                  <DataTable
                    rows={[...readModel.sourceObservationReview.rows]}
                    columns={reviewColumns}
                    getRowId={(row) => row.observationId}
                    selectedKeys={selectedObservationKeys}
                    onSelectionChange={setSelectedObservationKeys}
                    isRowSelectable={isReviewableObservationRow}
                    density="compact"
                    emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.empty.title")}
                    emptyDescription={t(
                      "catalog.features.sourceObservations.ui.primaryWorkbench.review.empty.description",
                    )}
                  />

                  {selectedObservationKeys.size > 0 ? (
                    <WorkbenchDetailPanel>
                      <WorkbenchActionRow align="between">
                        <WorkbenchText tone="foreground" weight="semibold">
                          {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.selected", {
                            count: selectedObservationKeys.size,
                          })}
                        </WorkbenchText>
                        <WorkbenchActionRow>
                          <CommandFormButton
                            readModel={readModel}
                            intent="preview-promotion"
                            size="sm"
                            selectedObservationIds={[...selectedObservationKeys]}
                            disabled={selectedEligibleObservationCount === 0}
                          >
                            {t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.promotion")}
                          </CommandFormButton>
                          <CommandFormButton
                            readModel={readModel}
                            intent="defer-source-observations"
                            size="sm"
                            tone="secondary"
                            selectedObservationIds={[...selectedObservationKeys]}
                            reason={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.defer.reason")}
                            disabled={
                              selectedReviewableObservationCount === 0 ||
                              !isActionAvailable(readModel, "defer-source-observations")
                            }
                          >
                            {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.defer")}
                          </CommandFormButton>
                          <Button size="sm" tone="secondary" onClick={() => setSelectedObservationKeys(new Set())}>
                            {t("catalog.features.sourceObservations.ui.primaryWorkbench.clear.selection")}
                          </Button>
                        </WorkbenchActionRow>
                      </WorkbenchActionRow>
                      <KeyValueList
                        items={[
                          {
                            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.reviewable.observations"),
                            value: selectedReviewableObservationCount,
                          },
                          {
                            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.eligible.observations"),
                            value: selectedEligibleObservationCount,
                          },
                          {
                            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.plan"),
                            value:
                              readModel.promotionPreview.commandPlanHash ??
                              t("catalog.features.sourceObservations.ui.primaryWorkbench.review.preview.required"),
                          },
                        ]}
                      />
                      <WorkbenchForm
                        variant="inline"
                        method="post"
                        action={catalogPrimaryWorkbenchHref(readModel.routeContext, "import-to-promotion")}
                        data-catalog-primary-workbench-command="reject-source-observations"
                      >
                        <CommandHiddenInputs
                          readModel={readModel}
                          intent="reject-source-observations"
                          selectedObservationIds={[...selectedObservationKeys]}
                        />
                        <TextInput
                          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.reject.reason")}
                          name="reason"
                          required
                          disabled={
                            selectedReviewableObservationCount === 0 ||
                            !isActionAvailable(readModel, "reject-source-observations")
                          }
                        />
                        <Button
                          type="submit"
                          size="sm"
                          tone="secondary"
                          disabled={
                            selectedReviewableObservationCount === 0 ||
                            !isActionAvailable(readModel, "reject-source-observations")
                          }
                        >
                          {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.reject")}
                        </Button>
                      </WorkbenchForm>
                    </WorkbenchDetailPanel>
                  ) : null}
                </WorkflowModule>

                <WorkflowModule
                  title={t("catalog.features.sourceObservations.ui.primaryWorkbench.command.plan.title")}
                  description={t("catalog.features.sourceObservations.ui.primaryWorkbench.command.plan.description")}
                  status={
                    <Badge tone={readModel.promotionPreview.freshness === "stale" ? "warning" : "success"}>
                      {stateLabel(readModel.promotionPreview.freshness)}
                    </Badge>
                  }
                  actions={
                    <CommandFormButton readModel={readModel} intent="execute-promotion" size="sm" leadingIcon="check">
                      {t("catalog.features.sourceObservations.ui.primaryWorkbench.promote.catalog.facts")}
                    </CommandFormButton>
                  }
                  headingLevel={2}
                  density="compact"
                >
                  <WorkbenchGrid columns="detail">
                    <KeyValueList
                      items={[
                        {
                          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.scope"),
                          value: readModel.promotionPreview.scope.label,
                        },
                        {
                          key: t(
                            "catalog.features.sourceObservations.ui.primaryWorkbench.command.requested.observations",
                          ),
                          value: readModel.promotionPreview.scope.requestedCount,
                        },
                        {
                          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.eligible.observations"),
                          value: readModel.promotionPreview.scope.eligibleCount,
                        },
                        {
                          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.plan"),
                          value:
                            readModel.promotionPreview.commandPlanHash ??
                            t("catalog.features.sourceObservations.ui.primaryWorkbench.review.preview.required"),
                        },
                        {
                          key: t(
                            "catalog.features.sourceObservations.ui.primaryWorkbench.command.execution.preview.fresh",
                          ),
                          value: readModel.promotionPreview.executionSafeguards.previewFresh
                            ? t("catalog.features.sourceObservations.ui.primaryWorkbench.ready")
                            : t("catalog.features.sourceObservations.ui.primaryWorkbench.review.preview.required"),
                        },
                      ]}
                    />
                    <KeyValueList
                      items={[
                        {
                          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.eligible"),
                          value: readModel.promotionPreview.outcomeCounts.eligible,
                        },
                        {
                          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.blocked"),
                          value: readModel.promotionPreview.outcomeCounts.blocked,
                        },
                        {
                          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.skipped"),
                          value: readModel.promotionPreview.outcomeCounts.skipped,
                        },
                        {
                          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.conflicting"),
                          value: readModel.promotionPreview.outcomeCounts.conflicting,
                        },
                        {
                          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.failed"),
                          value: readModel.promotionPreview.outcomeCounts.failed,
                        },
                      ]}
                    />
                  </WorkbenchGrid>

                  <KeyValueList
                    items={[
                      {
                        key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.reject.key"),
                        value: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.reject.value"),
                      },
                      {
                        key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.defer.key"),
                        value: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.defer.value"),
                      },
                      {
                        key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.profile.reapply.key"),
                        value: t(
                          "catalog.features.sourceObservations.ui.primaryWorkbench.command.profile.reapply.value",
                        ),
                      },
                      {
                        key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.profile.replay.key"),
                        value: t(
                          "catalog.features.sourceObservations.ui.primaryWorkbench.command.profile.replay.value",
                        ),
                      },
                      {
                        key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.execution.stale.guard"),
                        value: t(
                          "catalog.features.sourceObservations.ui.primaryWorkbench.command.execution.stale.value",
                        ),
                      },
                      {
                        key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.partial.failure.key"),
                        value: t(
                          "catalog.features.sourceObservations.ui.primaryWorkbench.command.partial.failure.value",
                        ),
                      },
                      {
                        key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.idempotency.key"),
                        value: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.idempotency.value"),
                      },
                    ]}
                  />

                  <WorkbenchStack gap="sm">
                    <WorkbenchText tone="foreground" weight="semibold">
                      {t("catalog.features.sourceObservations.ui.primaryWorkbench.table.blockers")}
                    </WorkbenchText>
                    <BlockerList blockers={readModel.promotionPreview.blockers} />
                  </WorkbenchStack>
                </WorkflowModule>

                <WorkbenchGrid columns="detail">
                  <WorkflowModule
                    title={t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.recovery.title")}
                    description={t(
                      "catalog.features.sourceObservations.ui.primaryWorkbench.readiness.recovery.description",
                    )}
                    density="compact"
                    status={
                      <Badge tone={readModel.readiness.blockers.length > 0 ? "warning" : "success"}>
                        {t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness")}
                      </Badge>
                    }
                  >
                    <WorkflowReadinessChecklist items={readinessItems(readModel)} />
                  </WorkflowModule>

                  <WorkflowModule
                    title={t("catalog.features.sourceObservations.ui.primaryWorkbench.context.preservation.title")}
                    description={t(
                      "catalog.features.sourceObservations.ui.primaryWorkbench.context.preservation.description",
                    )}
                    density="compact"
                    status={<Badge tone="info">#1057 handoff</Badge>}
                  >
                    <KeyValueList
                      items={[
                        {
                          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.provider"),
                          value:
                            readModel.routeContext.providerKey ??
                            t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
                        },
                        {
                          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.unit"),
                          value:
                            readModel.routeContext.unitKey ??
                            t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
                        },
                        {
                          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.selected.observations"),
                          value: readModel.routeContext.selectedObservationIds.length,
                        },
                        {
                          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.promotion.preview"),
                          value:
                            readModel.routeContext.promotionPreviewId ??
                            t("catalog.features.sourceObservations.ui.primaryWorkbench.not.queued"),
                        },
                        {
                          key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.return.path"),
                          value:
                            readModel.routeContext.returnPath ??
                            t("catalog.features.sourceObservations.ui.primaryWorkbench.primary.workbench"),
                        },
                      ]}
                    />
                  </WorkflowModule>
                </WorkbenchGrid>
              </>
            )}
          </WorkbenchStack>
        </BulkActionSurface>
      </DenseAdminWorkbenchLayout>
    </DenseAdminWorkbench>
  );
}

function CommandFeedbackBanner({ feedback }: { feedback: CatalogPrimaryWorkbenchCommandFeedback }) {
  return (
    <OperationalStatusBanner
      tone={feedback.status === "success" ? "success" : "warning"}
      title={
        feedback.status === "success"
          ? commandSuccessTitle(feedback.result)
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.error.title")
      }
      description={commandFeedbackDescription(feedback)}
    />
  );
}

function PrimaryStepAction({
  readModel,
  step,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  step: PrimaryWorkbenchStep;
}) {
  if (step.key === "provider" || step.key === "review") {
    return (
      <LinkButton
        size="sm"
        tone="secondary"
        href={catalogPrimaryWorkbenchHref(
          readModel.routeContext,
          step.key === "provider" ? "provider-scope-selection" : "source-observation-review",
        )}
      >
        {step.action}
      </LinkButton>
    );
  }

  const intentByStep: Record<
    Exclude<PrimaryWorkbenchStepKey, "provider" | "review">,
    CatalogPrimaryWorkbenchSubmitIntent
  > = {
    import: "start-provider-import",
    preview: "preview-promotion",
    promote: "execute-promotion",
  };

  return (
    <CommandFormButton
      readModel={readModel}
      intent={intentByStep[step.key]}
      size="sm"
      tone={step.key === "import" || step.key === "promote" ? "primary" : "secondary"}
      disabled={step.state !== "available" && step.state !== "degraded"}
    >
      {step.action}
    </CommandFormButton>
  );
}

function RowCommandAction({
  actionEntry,
  readModel,
  row,
}: {
  actionEntry: SourceObservationReviewRow["actions"][number];
  readModel: CatalogPrimaryWorkbenchReadModel;
  row: SourceObservationReviewRow;
}) {
  const disabled = actionEntry.state !== "available" && actionEntry.state !== "degraded";
  const ariaLabel = t("catalog.features.sourceObservations.ui.primaryWorkbench.review.action.aria", {
    action: rowActionLabel(actionEntry.key),
    observation: row.displayName,
  });

  if (
    actionEntry.key === "preview-promotion" ||
    actionEntry.key === "defer-source-observations" ||
    actionEntry.key === "start-reapply" ||
    actionEntry.key === "start-replay"
  ) {
    return (
      <CommandFormButton
        readModel={readModel}
        intent={actionEntry.key}
        selectedObservationIds={[row.observationId]}
        size="sm"
        tone={actionEntry.key === "preview-promotion" ? "primary" : "secondary"}
        reason={
          actionEntry.key === "defer-source-observations"
            ? t("catalog.features.sourceObservations.ui.primaryWorkbench.review.defer.reason")
            : undefined
        }
        disabled={disabled}
        aria-label={ariaLabel}
      >
        {rowActionLabel(actionEntry.key)}
      </CommandFormButton>
    );
  }

  return (
    <Button size="sm" tone="secondary" disabled aria-label={ariaLabel}>
      {rowActionLabel(actionEntry.key)}
    </Button>
  );
}

function isReviewableObservationRow(row: SourceObservationReviewRow): boolean {
  return row.status === "observed" || row.status === "changed";
}

function ImportJobLifecycleAction({
  readModel,
  job,
  intent,
  tone = "secondary",
  children,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  job: ImportJobRow;
  intent: Extract<CatalogPrimaryWorkbenchSubmitIntent, "retry-import-job" | "resume-import-job" | "cancel-import-job">;
  tone?: ButtonProps["tone"];
  children: ReactNode;
}) {
  return (
    <WorkbenchForm
      variant="button"
      method="post"
      action={catalogPrimaryWorkbenchHref({ ...readModel.routeContext, jobId: job.jobId }, "import-to-promotion")}
      data-catalog-primary-workbench-command={intent}
    >
      <CommandHiddenInputs readModel={readModel} intent={intent} jobId={job.jobId} />
      <Button type="submit" size="sm" tone={tone}>
        {children}
      </Button>
    </WorkbenchForm>
  );
}

type CommandFormButtonProps = Omit<ButtonProps, "type" | "disabled"> & {
  readModel: CatalogPrimaryWorkbenchReadModel;
  intent: CatalogPrimaryWorkbenchSubmitIntent;
  selectedObservationIds?: readonly string[];
  reason?: string;
  disabled?: boolean;
};

function CommandFormButton({
  readModel,
  intent,
  selectedObservationIds,
  reason,
  disabled = false,
  children,
  ...buttonProps
}: CommandFormButtonProps) {
  return (
    <WorkbenchForm
      variant="button"
      method="post"
      action={catalogPrimaryWorkbenchHref(readModel.routeContext, "import-to-promotion")}
      data-catalog-primary-workbench-command={intent}
    >
      <CommandHiddenInputs readModel={readModel} intent={intent} selectedObservationIds={selectedObservationIds} />
      {reason ? <HiddenInput name="reason" value={reason} /> : null}
      <Button type="submit" disabled={disabled || !isActionAvailable(readModel, intent)} {...buttonProps}>
        {children}
      </Button>
    </WorkbenchForm>
  );
}

function CommandHiddenInputs({
  readModel,
  intent,
  selectedObservationIds,
  jobId,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  intent: CatalogPrimaryWorkbenchSubmitIntent;
  selectedObservationIds?: readonly string[];
  jobId?: string | null;
}) {
  const context = readModel.routeContext;
  const observationIds = selectedObservationIds ?? context.selectedObservationIds;
  const jobIdValue = jobId ?? context.jobId ?? "";

  return (
    <>
      <HiddenInput name="_intent" value={intent} />
      <HiddenInput name="providerKey" value={context.providerKey ?? ""} />
      <HiddenInput name="unitKey" value={context.unitKey ?? ""} />
      <HiddenInput name="importScope" value={context.importScope ?? ""} />
      <HiddenInput name="profileVersion" value={context.profileVersion ?? ""} />
      <HiddenInput name="selectedObservationIds" value={observationIds.join(",")} />
      <HiddenInput name="jobId" value={jobIdValue} />
      <HiddenInput name="promotionPreviewId" value={context.promotionPreviewId ?? ""} />
    </>
  );
}

function navigationGroups(readModel: CatalogPrimaryWorkbenchReadModel): SectionNavigationGroup[] {
  const workspaces = new Map(CATALOG_CONTROL_PLANE_WORKSPACES.map((workspace) => [workspace.key, workspace]));

  return CATALOG_CONTROL_PLANE_NAVIGATION_GROUPS.map((group) => ({
    key: group.key,
    label: group.accessibleName,
    items: group.items.map((workspaceKey) => {
      const workspace = workspaces.get(workspaceKey);
      const supportState = workspace?.primaryPathRole === "default" ? "default" : supportNavigationState(readModel);

      return {
        key: workspaceKey,
        label: workspace?.accessibleName ?? workspaceKey,
        href:
          workspace?.primaryPathRole === "supporting-detour"
            ? catalogPrimaryWorkbenchSupportingHref(readModel.routeContext, workspace.key)
            : catalogPrimaryWorkbenchHref(readModel.routeContext, workspace?.key),
        description: workspace?.operatorJob,
        count:
          workspaceKey === "import-to-promotion" ? readModel.sourceObservationReview.promotionReadyCount : undefined,
        state: supportState,
        statusLabel: supportState === "warning" ? "Detour" : undefined,
      };
    }),
  }));
}

function buildSteps(readModel: CatalogPrimaryWorkbenchReadModel): readonly PrimaryWorkbenchStep[] {
  return [
    {
      key: "provider",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.provider.label"),
      evidence: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.provider.evidence", {
        count: readModel.providerScope.providers.length,
      }),
      action: t("catalog.features.sourceObservations.ui.primaryWorkbench.choose.context"),
      state: actionState(readModel, "select-provider-scope"),
      blockers: actionBlockers(readModel, "select-provider-scope"),
    },
    {
      key: "import",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.import.label"),
      evidence: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.import.evidence", {
        count: readModel.importJobs.jobs.length,
      }),
      action: t("catalog.features.sourceObservations.ui.primaryWorkbench.pull.provider.data"),
      state: actionState(readModel, "start-provider-import"),
      blockers: actionBlockers(readModel, "start-provider-import"),
    },
    {
      key: "review",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.review.label"),
      evidence: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.review.evidence", {
        changed: readModel.sourceObservationReview.counts.changed,
        rejected: readModel.sourceObservationReview.counts.rejected,
        promoted: readModel.sourceObservationReview.counts.promoted,
      }),
      action: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.observations"),
      state: actionState(readModel, "select-source-observations"),
      blockers: actionBlockers(readModel, "select-source-observations"),
    },
    {
      key: "preview",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.preview.label"),
      evidence: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.preview.evidence", {
        eligible: readModel.promotionPreview.dispositions.eligible,
        blocked: readModel.promotionPreview.dispositions.blocked,
        destructive: readModel.promotionPreview.destructiveCount,
      }),
      action: t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.promotion"),
      state: actionState(readModel, "preview-promotion"),
      blockers: actionBlockers(readModel, "preview-promotion"),
    },
    {
      key: "promote",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.step.promote.label"),
      evidence: readModel.promotionResult
        ? t("catalog.features.sourceObservations.ui.primaryWorkbench.step.promote.evidence.done", {
            count: readModel.promotionResult.promotedCatalogItemIds.length,
          })
        : t("catalog.features.sourceObservations.ui.primaryWorkbench.step.promote.evidence.pending"),
      action: t("catalog.features.sourceObservations.ui.primaryWorkbench.promote.catalog.facts"),
      state: actionState(readModel, "execute-promotion"),
      blockers: actionBlockers(readModel, "execute-promotion"),
    },
  ];
}

function readinessItems(readModel: CatalogPrimaryWorkbenchReadModel): readonly WorkflowReadinessItem[] {
  return [
    {
      key: "rbac",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.rbac.label"),
      status: readModel.readiness.rbacAllowed && readModel.readiness.rolloutEnabled ? "passed" : "blocked",
      statusLabel:
        readModel.readiness.rbacAllowed && readModel.readiness.rolloutEnabled
          ? t("catalog.features.sourceObservations.ui.primaryWorkbench.ready")
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.blocked"),
      description: t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.rbac.description"),
    },
    {
      key: "transport",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.transport.label"),
      status: readModel.readiness.providerTransport.length > 0 ? "warning" : "passed",
      statusLabel:
        readModel.readiness.providerTransport.length > 0
          ? t("catalog.features.sourceObservations.ui.primaryWorkbench.degraded")
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.ready"),
      description:
        readModel.readiness.providerTransport.length > 0
          ? catalogPrimaryWorkbenchProviderTransportSummary(readModel.readiness.providerTransport)
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.transport.ready.description"),
    },
    {
      key: "redaction",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.redaction.label"),
      status: readModel.securityPrivacy.redactionApplied ? "passed" : "blocked",
      statusLabel: readModel.securityPrivacy.redactionApplied
        ? t("catalog.features.sourceObservations.ui.primaryWorkbench.applied")
        : t("catalog.features.sourceObservations.ui.primaryWorkbench.blocked"),
      description: t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.redaction.description"),
    },
    {
      key: "deploy-skew",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.deploy.skew.label"),
      status: readModel.deploySkew.supported ? "passed" : "blocked",
      statusLabel: readModel.deploySkew.supported
        ? t("catalog.features.sourceObservations.ui.primaryWorkbench.current")
        : t("catalog.features.sourceObservations.ui.primaryWorkbench.fail.closed"),
      description: t("catalog.features.sourceObservations.ui.primaryWorkbench.readiness.deploy.skew.description"),
    },
  ];
}

function StepEvidenceSheet({
  step,
  readModel,
}: {
  step: PrimaryWorkbenchStep;
  readModel: CatalogPrimaryWorkbenchReadModel;
}) {
  return (
    <SideSheet
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.evidence.sheet.title", { label: step.label })}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.evidence.sheet.description")}
      closeLabel="Close evidence"
      width="lg"
      trigger={
        <Button size="sm" tone="secondary" leadingIcon="eye">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.evidence")}
        </Button>
      }
      footer={
        <Button size="sm" tone="secondary" disabled={step.blockers.length > 0}>
          {step.blockers.length > 0
            ? t("catalog.features.sourceObservations.ui.primaryWorkbench.blocked")
            : t("catalog.features.sourceObservations.ui.primaryWorkbench.use.evidence")}
        </Button>
      }
    >
      <WorkbenchStack>
        <KeyValueList
          items={[
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.provider"),
              value:
                readModel.routeContext.providerKey ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.unit"),
              value:
                readModel.routeContext.unitKey ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.scope"),
              value:
                readModel.routeContext.importScope ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.profile"),
              value:
                readModel.routeContext.profileVersion ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.state"),
              value: stateLabel(step.state),
            },
          ]}
        />
        <BlockerList blockers={step.blockers} />
      </WorkbenchStack>
    </SideSheet>
  );
}

function SourceObservationEvidenceSheet({ row }: { row: SourceObservationReviewRow }) {
  return (
    <SideSheet
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.title", {
        name: row.displayName,
      })}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.description")}
      closeLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.evidence.close")}
      width="lg"
      trigger={
        <Button size="sm" tone="secondary" leadingIcon="eye">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.evidence")}
        </Button>
      }
      footer={
        <Button size="sm" disabled={row.promotionReadiness.state !== "eligible"}>
          {row.promotionReadiness.state === "eligible"
            ? t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.promotion")
            : t("catalog.features.sourceObservations.ui.primaryWorkbench.blocked")}
        </Button>
      }
    >
      <WorkbenchStack>
        <KeyValueList
          items={[
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.provider"),
              value: row.providerKey,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.external"),
              value: row.externalKey,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.source.url"),
              value: row.sourceUrl,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.hash"),
              value: row.sourceRecordHash,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.observed"),
              value: row.observedAt,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.changed"),
              value: row.sourceUpdatedAt ?? row.changedAt,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.profile"),
              value: row.sourceProfileVersion,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.promotion.profile"),
              value:
                row.promotionProfileVersion ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.payload"),
              value: row.payloadSummary,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.redaction"),
              value: row.redactionSummary,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.command.preview"),
              value:
                row.commandPreview.promotionPlanHash ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.review.preview.required"),
            },
          ]}
        />

        <EvidenceStringList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.normalized")}
          items={row.normalizedFactSummaries}
          emptyLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}
        />
        <EvidenceStringList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.duplicates")}
          items={row.duplicateEvidence}
          emptyLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.no.duplicates")}
        />
        <EvidenceStringList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.conflicts")}
          items={row.conflictEvidence}
          emptyLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.no.conflicts")}
        />
        <EvidenceStringList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.audit")}
          items={row.auditTrail}
          emptyLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}
        />
        <BlockerList blockers={row.promotionReadiness.blockers} />
      </WorkbenchStack>
    </SideSheet>
  );
}

function BlockerList({
  blockers,
  compact = false,
  hideWhenEmpty = false,
}: {
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  compact?: boolean;
  hideWhenEmpty?: boolean;
}) {
  const visibleBlockers = uniqueBlockers(blockers);
  if (visibleBlockers.length === 0) {
    if (hideWhenEmpty) {
      return null;
    }

    return <Badge tone="success">{t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}</Badge>;
  }

  return (
    <StatusReasonList
      compact={compact}
      nextStepPrefix={t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.next.prefix")}
      items={visibleBlockers.map((blocker) => {
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

function actionState(
  readModel: CatalogPrimaryWorkbenchReadModel,
  key: CatalogPrimaryWorkbenchActionReadModel["key"],
): CatalogPrimaryWorkbenchActionState {
  return readModel.actions.find((action) => action.key === key)?.state ?? "unavailable";
}

function actionBlockers(
  readModel: CatalogPrimaryWorkbenchReadModel,
  key: CatalogPrimaryWorkbenchActionReadModel["key"],
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  return readModel.actions.find((action) => action.key === key)?.blockers ?? ["unsupported-command"];
}

function isActionAvailable(
  readModel: CatalogPrimaryWorkbenchReadModel,
  key: CatalogPrimaryWorkbenchActionReadModel["key"],
): boolean {
  const state = actionState(readModel, key);
  return state === "available" || state === "degraded";
}

function actionTone(state: CatalogPrimaryWorkbenchActionState) {
  if (state === "available") {
    return "success";
  }
  if (state === "denied" || state === "blocked" || state === "unsafe") {
    return "danger";
  }
  if (state === "degraded") {
    return "warning";
  }
  return "neutral";
}

function sourceObservationStatusTone(status: string) {
  if (status === "promoted") {
    return "success";
  }
  if (status === "rejected") {
    return "danger";
  }
  if (status === "changed") {
    return "warning";
  }

  return "info";
}

function rowActionLabel(key: SourceObservationReviewRow["actions"][number]["key"]): string {
  switch (key) {
    case "view-source-observation":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.view");
    case "preview-promotion":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.promotion");
    case "reject-source-observations":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.reject");
    case "defer-source-observations":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.defer");
    case "start-reapply":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.reapply");
    case "start-replay":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.replay");
  }
}

function jobStateTone(state: ImportJobRow["state"]) {
  if (state === "completed") {
    return "success";
  }
  if (state === "failed" || state === "cancelled") {
    return "danger";
  }
  if (state === "running" || state === "queued") {
    return "warning";
  }

  return "neutral";
}

function failureGroupLabel(group: ImportJobRow["failureGroups"][number]): string {
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

function blockerTone(blocker: CatalogPrimaryWorkbenchBlockerCategory) {
  const group = getCatalogPrimaryWorkbenchBlockerCopy(blocker).group;
  if (group === "permission" || group === "rollout" || group === "security-privacy" || group === "retirement") {
    return "danger";
  }
  if (group === "provider-transport" || group === "resilience" || group === "job") {
    return "warning";
  }

  return blocker.includes("blocked") ? "danger" : "warning";
}

function profileSnapshotLabel(
  profileSnapshot: ImportJobRow["profileSnapshot"],
  fallbackVersion: string | null,
): string {
  if (profileSnapshot) {
    return `${profileSnapshot.profileKey}@${profileSnapshot.profileVersion}`;
  }

  return fallbackVersion ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected");
}

function stateLabel(state: string): string {
  return state
    .split("-")
    .join(" ")
    .replace(/^\w/, (char) => char.toUpperCase());
}

function commandSuccessTitle(result: CatalogPrimaryWorkbenchCommandFeedback["result"]): string {
  if (result === "preview-ready") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.preview.title");
  }
  if (result === "job-cancelled") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.cancelled.title");
  }
  if (result === "draft-created") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.draft.title");
  }
  if (result === "profile-activated") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.activation.title");
  }
  if (result === "profile-rolled-back") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.rollback.title");
  }
  if (result === "profile-deprecated") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.deprecated.title");
  }
  if (result === "profile-retired") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.retired.title");
  }
  if (result === "section-saved") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.section.title");
  }

  return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.queued.title");
}

function commandFeedbackDescription(feedback: CatalogPrimaryWorkbenchCommandFeedback): string {
  if (feedback.status === "success") {
    if (feedback.result === "preview-ready") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.preview.description");
    }
    if (feedback.result === "job-cancelled") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.cancelled.description");
    }
    if (feedback.result === "draft-created") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.draft.description");
    }
    if (feedback.result === "profile-activated") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.activation.description");
    }
    if (feedback.result === "profile-rolled-back") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.rollback.description");
    }
    if (feedback.result === "profile-deprecated") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.deprecated.description");
    }
    if (feedback.result === "profile-retired") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.retired.description");
    }
    if (feedback.result === "section-saved") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.section.description");
    }

    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.queued.description");
  }

  switch (feedback.result) {
    case "preview-required":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.preview.required");
    case "job-required":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.job.required");
    case "reason-required":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.reason.required");
    case "section-conflict":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.section.conflict");
    case "section-invalid":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.section.invalid");
    case "lifecycle-conflict":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.lifecycle.conflict");
    case "confirmation-required":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.confirmation.required");
    case "unsupported-command":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.unsupported");
    case "invalid-intent":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.invalid.intent");
    case "command-failed":
    default:
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.failed");
  }
}

function supportNavigationState(readModel: CatalogPrimaryWorkbenchReadModel) {
  return readModel.readiness.blockers.length > 0 || readModel.promotionPreview.blockers.length > 0
    ? ("warning" as const)
    : ("default" as const);
}

function activeFilterCount(readModel: CatalogPrimaryWorkbenchReadModel): number {
  return [
    readModel.routeContext.providerKey,
    readModel.routeContext.unitKey,
    readModel.routeContext.importScope,
    readModel.routeContext.profileVersion,
    ...Object.values(readModel.routeContext.sourceObservationFilters),
  ].filter(Boolean).length;
}

function uniqueBlockers(
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  return [...new Set(blockers)];
}

function findNavigationHref(groups: SectionNavigationGroup[], key: string): string | undefined {
  return groups.flatMap((group) => group.items).find((item) => item.key === key)?.href;
}

function normalizeActiveWorkspace(section: string | undefined): string {
  const normalizedSection = normalizeCatalogPrimaryWorkbenchSection(section);
  if (CATALOG_CONTROL_PLANE_WORKSPACES.some((workspace) => workspace.key === normalizedSection)) {
    return normalizedSection;
  }

  return "import-to-promotion";
}
