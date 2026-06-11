import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Badge,
  BulkActionBar,
  BulkActionPanel,
  BulkActionSurface,
  Button,
  DataTable,
  EmptyState,
  FilterArea,
  Form,
  KeyValueList,
  LinkButton,
  MetricStrip,
  OperationalStatusBanner,
  SectionNavigation,
  SideSheet,
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
import { CatalogIntegrationHealthTriageDashboard } from "./admin-control-plane/health/integration-health-dashboard";
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
  const columns = useMemo<DataColumn<PrimaryWorkbenchStep>[]>(
    () => [
      {
        key: "step",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.primary.step"),
        sortable: true,
        cell: (step) => (
          <div className="grid min-w-0 gap-1">
            <div className="text-sm font-semibold text-foreground">{step.label}</div>
            <div className="text-sm leading-6 text-secondary">{step.evidence}</div>
          </div>
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
          <div className="flex flex-wrap justify-end gap-2">
            <StepEvidenceSheet step={step} readModel={readModel} />
            <PrimaryStepAction readModel={readModel} step={step} />
          </div>
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
          <div className="grid min-w-0 gap-1">
            <div className="text-sm font-semibold text-foreground">{job.summary}</div>
            <div className="text-xs text-secondary">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.profile", {
                profile: profileSnapshotLabel(job.profileSnapshot, job.profileVersion),
              })}
            </div>
            <div className="text-xs leading-5 text-secondary">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.context.unit", {
                unit: job.unitKey ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
              })}
            </div>
            <div className="flex min-w-0 flex-wrap gap-1">
              <Badge tone={job.scopeMatchesRoute ? "success" : "warning"}>
                {job.scopeMatchesRoute
                  ? t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.context.current.scope")
                  : t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.context.overlapping.scope")}
              </Badge>
              <Badge tone="neutral">
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.context.scope", {
                  scope: job.importScope ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
                })}
              </Badge>
            </div>
          </div>
        ),
      },
      {
        key: "progress",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.progress"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.progress"),
        cell: (job) => (
          <div className="grid min-w-0 gap-1">
            <Badge tone={jobStateTone(job.state)}>{stateLabel(job.state)}</Badge>
            <div className="text-xs text-secondary">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.operator.status", {
                status: stateLabel(job.operatorStatus),
              })}
            </div>
            <div className="text-xs text-secondary">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.progress.value", {
                completed: job.completed,
                total: job.total,
                percent: job.progressPercent,
              })}
            </div>
            <div className="text-xs leading-5 text-secondary">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.created", {
                value: job.createdAt,
              })}
            </div>
            <div className="text-xs leading-5 text-secondary">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.started", {
                value:
                  job.startedAt ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.not.started"),
              })}
            </div>
          </div>
        ),
      },
      {
        key: "consistency",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.consistency"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.consistency"),
        cell: (job) => (
          <div className="grid min-w-0 gap-2">
            <div className="text-xs leading-5 text-secondary">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.profile.snapshot", {
                profile: profileSnapshotLabel(job.profileSnapshot, job.profileVersion),
              })}
            </div>
            <div className="flex min-w-0 flex-wrap gap-1.5">
              <Badge tone="neutral">{stateLabel(job.consistency.duplicateSubmissionPolicy)}</Badge>
              <Badge tone="neutral">{stateLabel(job.consistency.retryResumePolicy)}</Badge>
              <Badge tone="neutral">{stateLabel(job.consistency.partialFailurePolicy)}</Badge>
              <Badge tone="neutral">{stateLabel(job.consistency.workUnitClaimPolicy)}</Badge>
            </div>
            <BlockerList blockers={job.blockers} compact hideWhenEmpty />
          </div>
        ),
      },
      {
        key: "failures",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.failures"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.table.failures"),
        cell: (job) =>
          job.failureGroups.length > 0 ? (
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {job.failureGroups.map((group) => (
                <Badge key={group.key} tone={group.severity === "error" ? "danger" : "warning"}>
                  {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.failure.group", {
                    label: failureGroupLabel(group),
                    count: group.count,
                  })}
                </Badge>
              ))}
            </div>
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
          <div className="flex flex-wrap justify-end gap-2">
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
            <a className="text-sm font-semibold text-accent hover:underline" href={job.sourceObservationReviewHref}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.review.link")}
            </a>
            <a className="text-sm font-semibold text-accent hover:underline" href={job.auditEvidenceUrl}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.evidence.link")}
            </a>
          </div>
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
          <div className="grid min-w-0 gap-1">
            <div className="truncate text-sm font-semibold text-foreground">{row.displayName}</div>
            <div className="text-xs leading-5 text-secondary">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.table.external", {
                provider: row.providerKey,
                external: row.externalKey,
              })}
            </div>
            <div className="flex min-w-0 flex-wrap gap-1">
              {row.normalizedFactSummaries.slice(0, 3).map((fact) => (
                <Badge key={fact} tone="neutral">
                  {fact}
                </Badge>
              ))}
            </div>
          </div>
        ),
      },
      {
        key: "status",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.table.status"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.table.status"),
        cell: (row) => (
          <div className="grid gap-1">
            <Badge tone={sourceObservationStatusTone(row.status)}>{stateLabel(row.status)}</Badge>
            <span className="text-xs text-secondary">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.table.changed", {
                value: row.sourceUpdatedAt ?? row.changedAt,
              })}
            </span>
          </div>
        ),
      },
      {
        key: "evidence",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.table.evidence"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.table.evidence"),
        cell: (row) => (
          <div className="grid min-w-0 gap-1">
            <span className="text-sm text-foreground">{row.payloadSummary}</span>
            <span className="text-xs leading-5 text-secondary">{row.redactionSummary}</span>
            {row.duplicateEvidence.length > 0 ? (
              <Badge tone="warning">
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.duplicate.count", {
                  count: row.duplicateEvidence.length,
                })}
              </Badge>
            ) : null}
          </div>
        ),
      },
      {
        key: "readiness",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.table.readiness"),
        mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.table.readiness"),
        cell: (row) => (
          <div className="grid gap-1">
            <Badge tone={row.promotionReadiness.state === "eligible" ? "success" : "warning"}>
              {stateLabel(row.promotionReadiness.state)}
            </Badge>
            <BlockerList blockers={row.promotionReadiness.blockers} />
          </div>
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
            <div className="grid justify-items-end gap-2">
              <div className="flex flex-wrap justify-end gap-2">
                <SourceObservationEvidenceSheet row={row} />
                {row.actions
                  .filter((actionEntry) => actionEntry.key !== "view-source-observation")
                  .map((actionEntry) => (
                    <RowCommandAction key={actionEntry.key} actionEntry={actionEntry} readModel={readModel} row={row} />
                  ))}
              </div>
              <BlockerList blockers={rowActionBlockers} compact hideWhenEmpty />
            </div>
          );
        },
      },
    ],
    [readModel],
  );

  return (
    <section className="grid gap-5" data-catalog-primary-workbench="true">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-normal text-accent">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.eyebrow")}
          </div>
          <h1 className="mt-1 font-heading text-2xl font-semibold leading-tight text-foreground md:text-3xl">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.title")}
          </h1>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-secondary">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.description")}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:justify-end">
          <CommandFormButton readModel={readModel} intent="start-provider-import" leadingIcon="refreshCcw">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.pull.provider.data")}
          </CommandFormButton>
          <CommandFormButton readModel={readModel} intent="preview-promotion" tone="secondary" leadingIcon="check">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.promotion")}
          </CommandFormButton>
        </div>
      </div>

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

      <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start">
        <div className="lg:sticky lg:top-20">
          <SectionNavigation
            groups={navigation}
            activeKey={activeSection}
            label={t("catalog.features.sourceObservations.ui.primaryWorkbench.navigation.label")}
            mobileLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.navigation.mobile.label")}
            onSelect={handleSectionSelect}
          />
        </div>

        <BulkActionSurface>
          <div className="grid min-w-0 gap-4">
            {activeSection === "health-triage" ? (
              <CatalogIntegrationHealthTriageDashboard readModel={readModel} />
            ) : null}

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
                emptyDescription={t("catalog.features.sourceObservations.ui.primaryWorkbench.empty.steps.description")}
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
              description={t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.description")}
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
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(18rem,24rem)]">
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
                        key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.expected"),
                        value: readModel.importJobs.selectedScope.expectedObservationVolume,
                      },
                      {
                        key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.observed"),
                        value: readModel.importJobs.selectedScope.observedCount,
                      },
                      {
                        key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.changed"),
                        value: readModel.importJobs.selectedScope.changedCount,
                      },
                      {
                        key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.promoted"),
                        value: readModel.importJobs.selectedScope.promotedCount,
                      },
                      {
                        key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.rejected"),
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
                        key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.credentials"),
                        value: stateLabel(readModel.importJobs.selectedScope.readiness.credentialReadiness),
                      },
                      {
                        key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.rollout"),
                        value: readModel.importJobs.selectedScope.readiness.rolloutEnabled
                          ? t("catalog.features.sourceObservations.ui.primaryWorkbench.ready")
                          : t("catalog.features.sourceObservations.ui.primaryWorkbench.blocked"),
                      },
                      {
                        key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.transport"),
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
                  <div className="xl:col-span-3">
                    <BlockerList blockers={readModel.importJobs.selectedScope.readiness.blockers} compact />
                  </div>
                </div>
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

              <div className="flex min-w-0 flex-wrap gap-2">
                {readModel.sourceObservationReview.savedFilters.map((savedFilter) => (
                  <Badge key={savedFilter.key} tone="neutral">
                    {savedFilter.label}
                    {savedFilter.count === null
                      ? ""
                      : t("catalog.features.sourceObservations.ui.primaryWorkbench.review.saved.count", {
                          value: savedFilter.count,
                        })}
                  </Badge>
                ))}
              </div>

              <DataTable
                rows={[...readModel.sourceObservationReview.rows]}
                columns={reviewColumns}
                getRowId={(row) => row.observationId}
                selectedKeys={selectedObservationKeys}
                onSelectionChange={setSelectedObservationKeys}
                isRowSelectable={isReviewableObservationRow}
                density="compact"
                emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.empty.title")}
                emptyDescription={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.empty.description")}
              />

              {selectedObservationKeys.size > 0 ? (
                <div className="grid gap-3 rounded-tokenMd border border-border bg-surface-2 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-foreground">
                      {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.selected", {
                        count: selectedObservationKeys.size,
                      })}
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
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
                    </div>
                  </div>
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
                  <Form
                    spacing="none"
                    method="post"
                    action={catalogPrimaryWorkbenchHref(readModel.routeContext, "import-to-promotion")}
                    className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
                    data-catalog-primary-workbench-command="reject-source-observations"
                  >
                    <CommandHiddenInputs
                      readModel={readModel}
                      intent="reject-source-observations"
                      selectedObservationIds={[...selectedObservationKeys]}
                    />
                    <label className="grid min-w-0 gap-1 text-sm text-secondary">
                      <span className="font-semibold text-foreground">
                        {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.reject.reason")}
                      </span>
                      <input
                        className="min-h-10 rounded-tokenSm border border-border bg-surface px-3 py-2 text-sm text-foreground"
                        name="reason"
                        required
                        disabled={
                          selectedReviewableObservationCount === 0 ||
                          !isActionAvailable(readModel, "reject-source-observations")
                        }
                      />
                    </label>
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
                  </Form>
                </div>
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
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
                <KeyValueList
                  items={[
                    {
                      key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.scope"),
                      value: readModel.promotionPreview.scope.label,
                    },
                    {
                      key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.requested.observations"),
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
                      key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.execution.preview.fresh"),
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
              </div>

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
                    value: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.profile.reapply.value"),
                  },
                  {
                    key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.profile.replay.key"),
                    value: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.profile.replay.value"),
                  },
                  {
                    key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.execution.stale.guard"),
                    value: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.execution.stale.value"),
                  },
                  {
                    key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.partial.failure.key"),
                    value: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.partial.failure.value"),
                  },
                  {
                    key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.idempotency.key"),
                    value: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.idempotency.value"),
                  },
                ]}
              />

              <div className="grid gap-2">
                <div className="text-sm font-semibold text-foreground">
                  {t("catalog.features.sourceObservations.ui.primaryWorkbench.table.blockers")}
                </div>
                <BlockerList blockers={readModel.promotionPreview.blockers} />
              </div>
            </WorkflowModule>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
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
            </div>
          </div>
        </BulkActionSurface>
      </div>
    </section>
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
    <Form
      spacing="none"
      method="post"
      action={catalogPrimaryWorkbenchHref({ ...readModel.routeContext, jobId: job.jobId }, "import-to-promotion")}
      className="inline-flex"
      data-catalog-primary-workbench-command={intent}
    >
      <CommandHiddenInputs readModel={readModel} intent={intent} jobId={job.jobId} />
      <Button type="submit" size="sm" tone={tone}>
        {children}
      </Button>
    </Form>
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
    <Form
      spacing="none"
      method="post"
      action={catalogPrimaryWorkbenchHref(readModel.routeContext, "import-to-promotion")}
      className="inline-flex"
      data-catalog-primary-workbench-command={intent}
    >
      <CommandHiddenInputs readModel={readModel} intent={intent} selectedObservationIds={selectedObservationIds} />
      {reason ? <input type="hidden" name="reason" value={reason} /> : null}
      <Button type="submit" disabled={disabled || !isActionAvailable(readModel, intent)} {...buttonProps}>
        {children}
      </Button>
    </Form>
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
      <input type="hidden" name="_intent" value={intent} />
      <input type="hidden" name="providerKey" value={context.providerKey ?? ""} />
      <input type="hidden" name="unitKey" value={context.unitKey ?? ""} />
      <input type="hidden" name="importScope" value={context.importScope ?? ""} />
      <input type="hidden" name="profileVersion" value={context.profileVersion ?? ""} />
      <input type="hidden" name="selectedObservationIds" value={observationIds.join(",")} />
      <input type="hidden" name="jobId" value={jobIdValue} />
      <input type="hidden" name="promotionPreviewId" value={context.promotionPreviewId ?? ""} />
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
      <div className="grid gap-4">
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
      </div>
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
      <div className="grid gap-4">
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

        <EvidenceList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.normalized")}
          items={row.normalizedFactSummaries}
          empty={t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}
        />
        <EvidenceList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.duplicates")}
          items={row.duplicateEvidence}
          empty={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.no.duplicates")}
        />
        <EvidenceList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.conflicts")}
          items={row.conflictEvidence}
          empty={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.no.conflicts")}
        />
        <EvidenceList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.audit")}
          items={row.auditTrail}
          empty={t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}
        />
        <BlockerList blockers={row.promotionReadiness.blockers} />
      </div>
    </SideSheet>
  );
}

function EvidenceList({ title, items, empty }: { title: string; items: readonly string[]; empty: string }) {
  return (
    <div className="grid gap-2">
      <div className="text-sm font-semibold text-foreground">{title}</div>
      {items.length > 0 ? (
        <ul className="grid gap-1 text-sm leading-6 text-secondary">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <Badge tone="success">{empty}</Badge>
      )}
    </div>
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
    <div className={compact ? "grid min-w-0 gap-1 text-left" : "grid min-w-0 gap-2 text-left"}>
      {visibleBlockers.map((blocker) => {
        const copy = getCatalogPrimaryWorkbenchBlockerCopy(blocker);

        return (
          <div key={blocker} className={compact ? "grid min-w-0 gap-1" : "grid min-w-0 gap-1.5"}>
            <div className="flex min-w-0 flex-wrap gap-1.5">
              <Badge tone={blockerTone(blocker)}>{copy.label}</Badge>
            </div>
            <div className={compact ? "max-w-72 text-xs leading-5 text-secondary" : "text-xs leading-5 text-secondary"}>
              {copy.reason} {t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.next.prefix")}{" "}
              {copy.nextStep}
            </div>
          </div>
        );
      })}
    </div>
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

    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.queued.description");
  }

  switch (feedback.result) {
    case "preview-required":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.preview.required");
    case "job-required":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.job.required");
    case "reason-required":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.reason.required");
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
