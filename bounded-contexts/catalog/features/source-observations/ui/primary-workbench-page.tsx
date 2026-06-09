import { useMemo, useState } from "react";
import {
  Badge,
  BulkActionBar,
  BulkActionPanel,
  BulkActionSurface,
  Button,
  DataTable,
  EmptyState,
  FilterArea,
  KeyValueList,
  MetricStrip,
  OperationalStatusBanner,
  SectionNavigation,
  SideSheet,
  WorkflowModule,
  WorkflowReadinessChecklist,
  type DataColumn,
  type SectionNavigationGroup,
  type WorkflowReadinessItem,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchActionReadModel,
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
} from "../api/primary-workbench-admin-contracts";
import {
  CATALOG_CONTROL_PLANE_NAVIGATION_GROUPS,
  CATALOG_CONTROL_PLANE_WORKSPACES,
} from "./admin-control-plane/information-architecture";
import { catalogPrimaryWorkbenchHref } from "./primary-workbench-route-context";

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

export interface CatalogPrimaryWorkbenchPageProps {
  readModel: CatalogPrimaryWorkbenchReadModel;
  initialSection?: string;
}

export function CatalogPrimaryWorkbenchPage({ readModel, initialSection }: CatalogPrimaryWorkbenchPageProps) {
  const [activeSection, setActiveSection] = useState(() => normalizeInitialSection(initialSection));
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
            <Button
              size="sm"
              tone={step.key === "import" || step.key === "promote" ? "primary" : "secondary"}
              disabled={step.state !== "available" && step.state !== "degraded"}
              aria-label={t("catalog.features.sourceObservations.ui.primaryWorkbench.action.aria", {
                action: step.action,
                label: step.label,
              })}
            >
              {step.action}
            </Button>
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
                profile:
                  job.profileVersion ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
              })}
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
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.progress.value", {
                completed: job.completed,
                total: job.total,
                percent: job.progressPercent,
              })}
            </div>
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
            <a className="text-sm font-semibold text-accent hover:underline" href={job.sourceObservationReviewHref}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.review.link")}
            </a>
            <a className="text-sm font-semibold text-accent hover:underline" href={job.auditEvidenceUrl}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.evidence.link")}
            </a>
            <Button size="sm" tone="secondary" disabled={!job.retryAvailable}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.retry")}
            </Button>
            <Button size="sm" tone="secondary" disabled={!job.resumeAvailable}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.resume")}
            </Button>
            <Button size="sm" tone="secondary" disabled={!job.cancelAvailable}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.cancel")}
            </Button>
          </div>
        ),
      },
    ],
    [],
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
          <Button leadingIcon="refreshCcw" disabled={!isActionAvailable(readModel, "start-provider-import")}>
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.pull.provider.data")}
          </Button>
          <Button tone="secondary" leadingIcon="check" disabled={!isActionAvailable(readModel, "preview-promotion")}>
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.promotion")}
          </Button>
        </div>
      </div>

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
            groups={navigationGroups(readModel)}
            activeKey={activeSection}
            label={t("catalog.features.sourceObservations.ui.primaryWorkbench.navigation.label")}
            mobileLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.navigation.mobile.label")}
            onSelect={setActiveSection}
          />
        </div>

        <BulkActionSurface>
          <div className="grid min-w-0 gap-4">
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
                <Button size="sm" tone="secondary" leadingIcon="externalLink">
                  {t("catalog.features.sourceObservations.ui.primaryWorkbench.view.supporting.evidence")}
                </Button>
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
                  <Button size="sm" tone="secondary" leadingIcon="filter">
                    {t("catalog.features.sourceObservations.ui.primaryWorkbench.save.context")}
                  </Button>
                  <Button
                    size="sm"
                    leadingIcon="refreshCcw"
                    disabled={!isActionAvailable(readModel, "start-provider-import")}
                  >
                    {t("catalog.features.sourceObservations.ui.primaryWorkbench.pull.provider.data")}
                  </Button>
                </>
              }
              headingLevel={2}
              density="compact"
            >
              <FilterArea
                sticky={false}
                activeFilterCount={activeFilterCount(readModel)}
                panelTitle="Primary workbench context"
                panelDescription="These canonical route keys preserve provider, unit, scope, profile, filters, selections, jobs, previews, and return paths."
                actions={
                  <Button size="sm" tone="secondary">
                    {t("catalog.features.sourceObservations.ui.primaryWorkbench.reset.view")}
                  </Button>
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
                        <Button size="sm" disabled={!isActionAvailable(readModel, "preview-promotion")}>
                          {t("catalog.features.sourceObservations.ui.primaryWorkbench.queue.preview")}
                        </Button>
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
                            value: readModel.promotionPreview.commandPlanHash ?? "Preview required",
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
                <Button
                  size="sm"
                  leadingIcon="refreshCcw"
                  disabled={!isActionAvailable(readModel, "start-provider-import")}
                >
                  {t("catalog.features.sourceObservations.ui.primaryWorkbench.pull.provider.data")}
                </Button>
              }
              headingLevel={2}
              density="compact"
            >
              {readModel.importJobs.selectedScope ? (
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
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
                        key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.expected"),
                        value: readModel.importJobs.selectedScope.expectedObservationVolume,
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
                            ? readModel.importJobs.selectedScope.readiness.providerTransport.join(", ")
                            : t(
                                "catalog.features.sourceObservations.ui.primaryWorkbench.readiness.transport.ready.description",
                              ),
                      },
                      {
                        key: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.blockers"),
                        value: readModel.importJobs.selectedScope.readiness.blockers.length,
                      },
                    ]}
                  />
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
        href: catalogPrimaryWorkbenchHref(readModel.routeContext, workspace?.routeSegment),
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
          ? readModel.readiness.providerTransport.join(", ")
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

function BlockerList({ blockers }: { blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] }) {
  if (blockers.length === 0) {
    return <Badge tone="success">{t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}</Badge>;
  }

  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {blockers.map((blocker) => (
        <Badge key={blocker} tone={blocker.includes("denied") || blocker.includes("blocked") ? "danger" : "warning"}>
          {blocker}
        </Badge>
      ))}
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
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.failure.transport", {
      category: stateLabel(group.key.replace(/^provider-transport-/, "")),
    });
  }

  return group.label;
}

function stateLabel(state: string): string {
  return state
    .split("-")
    .join(" ")
    .replace(/^\w/, (char) => char.toUpperCase());
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

function normalizeInitialSection(initialSection: string | undefined): string {
  if (
    initialSection &&
    CATALOG_CONTROL_PLANE_WORKSPACES.some((workspace) => workspace.routeSegment === initialSection)
  ) {
    return (
      CATALOG_CONTROL_PLANE_WORKSPACES.find((workspace) => workspace.routeSegment === initialSection)?.key ??
      "import-to-promotion"
    );
  }
  if (initialSection && CATALOG_CONTROL_PLANE_WORKSPACES.some((workspace) => workspace.key === initialSection)) {
    return initialSection;
  }

  return "import-to-promotion";
}
