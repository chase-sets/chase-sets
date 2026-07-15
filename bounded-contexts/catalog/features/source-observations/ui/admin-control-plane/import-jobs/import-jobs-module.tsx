import { Suspense, useMemo, type ReactNode } from "react";
import { Await } from "react-router";
import {
  Badge,
  BadgeCluster,
  Button,
  ConnectionStatusIndicator,
  DataTable,
  EmptyState,
  KeyValueList,
  LinkText,
  Show,
  WorkbenchDetailPanel,
  WorkbenchActionRow,
  WorkbenchDataCell,
  WorkbenchForm,
  WorkbenchGrid,
  WorkbenchGridSpan,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
  type ButtonProps,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchProviderTransportCategory,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import type {
  SourceObservationIntegrationImportPreview,
  SourceObservationIntegrationImportPreviewTarget,
  SourceObservationProviderUsageEstimate,
} from "../../contracts";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../primary-workbench-command-feedback";
import { DeferredSupplementaryPanel } from "../../deferred-supplementary-panel";
import {
  catalogPrimaryWorkbenchProviderTransportSummary,
  getCatalogPrimaryWorkbenchProviderTransportCopy,
} from "../../primary-workbench-copy";
import { useCatalogIntegrationCommandHref } from "../import-to-promotion/command-action-context";
import { scopeContextFromImportScope, scopeDisplayLabel } from "../../primary-workbench-scope-context";
import { CommandHiddenInputs, type CatalogPrimaryWorkbenchSubmitIntent } from "../import-to-promotion/command-controls";
import { BlockerList, profileSnapshotLabel, stateLabel } from "../import-to-promotion/workbench-formatting";
import { useLiveImportJobs } from "./use-live-import-jobs";

type ImportJobRow = CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"][number];
const importJobDiscoveryIntents = new Set([
  "scope.import",
  "observation.reapply",
  "observation.replay",
  "job.retry",
  "job.resume",
]);

export function CatalogIntegrationImportJobsModule({
  readModel,
  commandFeedback = null,
  deferredImportPreview = null,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
  deferredImportPreview?: Promise<SourceObservationIntegrationImportPreview | null> | null;
}>) {
  // Live progress: while a durable import is active and the tab is visible, the
  // loader revalidates on a bounded interval and `jobProgress` carries the
  // monotonic-gated completed/total/percent so a row never visibly counts backward.
  const pendingJobDiscoveryKey = pendingImportJobDiscoveryKey(readModel, commandFeedback);
  const { live, jobProgress } = useLiveImportJobs(readModel, {
    pendingJobDiscovery: pendingJobDiscoveryKey !== null,
    pendingJobDiscoveryKey,
  });

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
                      scope: importScopeDisplayLabel(job.importScope, job.providerKey),
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
        cell: (job) => {
          // Render the monotonic-gated progress when present so a live refresh
          // never shows the row counting backward; fall back to the server snapshot.
          const progress = jobProgress.get(job.jobId);
          return (
            <WorkbenchStack gap="sm">
              <Badge tone={jobStateTone(job.state)}>{stateLabel(job.state)}</Badge>
              <WorkbenchText size="xs">
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.operator.status", {
                  status: stateLabel(job.operatorStatus),
                })}
              </WorkbenchText>
              <WorkbenchText size="xs">
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.progress.value", {
                  completed: progress?.completed ?? job.completed,
                  total: progress?.total ?? job.total,
                  percent: progress?.progressPercent ?? job.progressPercent,
                })}
              </WorkbenchText>
              <Show above="sm">
                <WorkbenchText size="xs">
                  {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.created", {
                    value: job.createdAt,
                  })}
                </WorkbenchText>
              </Show>
              <Show above="sm">
                <WorkbenchText size="xs">
                  {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.started", {
                    value:
                      job.startedAt ??
                      t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.not.started"),
                  })}
                </WorkbenchText>
              </Show>
            </WorkbenchStack>
          );
        },
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
              <ImportJobLifecycleAction readModel={readModel} job={job} intent="job.retry">
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.retry")}
              </ImportJobLifecycleAction>
            ) : null}
            {job.resumeAvailable ? (
              <ImportJobLifecycleAction readModel={readModel} job={job} intent="job.resume">
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.resume")}
              </ImportJobLifecycleAction>
            ) : null}
            {job.cancelAvailable ? (
              <ImportJobLifecycleAction readModel={readModel} job={job} intent="job.cancel" tone="danger">
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
    [readModel, jobProgress],
  );

  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.title")}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.description")}
      status={
        <>
          <BadgeCluster
            items={[
              {
                key: "active",
                tone: readModel.importJobs.activeJobCount > 0 ? "warning" : "success",
                label: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.status", {
                  count: readModel.importJobs.activeJobCount,
                }),
              },
            ]}
          />
          {/* The live indicator renders only while the bounded poll is actually
              refreshing (active job + visible tab), so operators can tell at a
              glance that the table is advancing on its own. This poll-driven
              surface never goes "stale", so it only ever passes the "live"
              state to the shared DS pattern. */}
          {live ? (
            <ConnectionStatusIndicator
              status="live"
              liveLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.live")}
            />
          ) : null}
        </>
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
                value: importScopeDisplayLabel(
                  readModel.importJobs.selectedScope.importScope,
                  readModel.importJobs.selectedScope.providerKey,
                ),
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.profile"),
                value:
                  readModel.importJobs.selectedScope.profileVersion ??
                  t("catalog.features.sourceObservations.ui.primaryWorkbench.no.active.profile"),
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.profile.snapshot"),
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
          <WorkbenchGridSpan>
            <BlockerList blockers={readModel.importJobs.selectedScope.readiness.blockers} compact />
          </WorkbenchGridSpan>
          <WorkbenchGridSpan>
            <DeferredImportPreviewEvidence
              deferredImportPreview={deferredImportPreview}
              previewKey={importPreviewRouteKey(readModel.routeContext)}
              routeContext={readModel.routeContext}
            />
          </WorkbenchGridSpan>
        </WorkbenchGrid>
      ) : (
        <EmptyState
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.empty.title")}
          description={t("catalog.features.sourceObservations.ui.primaryWorkbench.import.operations.empty.description")}
        />
      )}

      <DataTable
        rows={[...readModel.importJobs.jobs]}
        columns={jobColumns}
        caption={t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.supporting.jobs")}
        getRowId={(job) => job.jobId}
        getRowProps={(job) => ({
          "data-catalog-import-job-row": "true",
          "data-catalog-import-job-id": job.jobId,
          "data-catalog-import-job-provider": job.providerKey,
          "data-catalog-import-job-unit": job.unitKey ?? "",
          "data-catalog-import-job-scope": job.importScope ?? "",
          "data-catalog-import-job-state": job.state,
          "data-catalog-import-job-operator-status": job.operatorStatus,
          "data-catalog-import-job-scope-route": job.scopeMatchesRoute ? "current" : "overlapping",
        })}
        density="compact"
        emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.empty.title")}
        emptyDescription={t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.empty.description")}
      />
    </WorkflowModule>
  );
}

function pendingImportJobDiscoveryKey(
  readModel: CatalogPrimaryWorkbenchReadModel,
  commandFeedback: CatalogPrimaryWorkbenchCommandFeedback | null,
): string | null {
  if (commandFeedback?.status !== "success" || commandFeedback.result !== "job-queued") {
    return null;
  }
  if (!importJobDiscoveryIntents.has(commandFeedback.intent)) {
    return null;
  }

  const parts = [
    commandFeedback.intent,
    readModel.routeContext.providerKey,
    readModel.routeContext.unitKey,
    readModel.routeContext.importScope,
    readModel.routeContext.profileVersion,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(":") : null;
}

function DeferredImportPreviewEvidence({
  deferredImportPreview,
  previewKey,
  routeContext,
}: Readonly<{
  deferredImportPreview: Promise<SourceObservationIntegrationImportPreview | null> | null;
  previewKey: string;
  routeContext: CatalogPrimaryWorkbenchReadModel["routeContext"];
}>) {
  if (!deferredImportPreview) {
    return null;
  }

  return (
    <Suspense
      key={previewKey}
      fallback={
        <DeferredSupplementaryPanel
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.title")}
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.loading")}
        />
      }
    >
      <Await key={previewKey} resolve={deferredImportPreview}>
        {(preview) =>
          preview && importPreviewMatchesRouteContext(preview, routeContext) ? (
            <ImportPreviewEvidence preview={preview} />
          ) : null
        }
      </Await>
    </Suspense>
  );
}

function ImportPreviewEvidence({
  preview,
}: Readonly<{
  preview: SourceObservationIntegrationImportPreview;
}>) {
  const usage = previewUsageSummary(preview.targets);
  const transportSteps = uniqueStrings(preview.targets.flatMap((target) => target.transportSteps));

  return (
    <WorkbenchDetailPanel
      data-catalog-import-preview="ready"
      data-catalog-import-preview-provider={preview.providerKey}
      data-catalog-import-preview-unit={preview.scope.ingestionUnitKey ?? ""}
      data-catalog-import-preview-scope={importPreviewScopeKey(preview.scope)}
      data-catalog-import-preview-strategy={usage.requestStrategy ?? "none"}
      data-catalog-import-preview-usage-state={usage.usageCheckState ?? "none"}
    >
      <WorkbenchStack>
        <WorkbenchActionRow align="between" stackOnMobile>
          <WorkbenchStack gap="sm">
            <WorkbenchText tone="foreground" weight="semibold">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.title")}
            </WorkbenchText>
            <WorkbenchText size="sm" tone="secondary">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.description")}
            </WorkbenchText>
          </WorkbenchStack>
          <BadgeCluster
            items={[
              {
                key: "targets",
                tone: "info",
                label: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.targets", {
                  count: preview.targetCount,
                }),
              },
              {
                key: "strategy",
                tone: usageStrategyTone(usage.requestStrategy),
                label: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.strategy", {
                  value: usage.requestStrategy ? stateLabel(usage.requestStrategy) : stateLabel("unknown"),
                }),
              },
              {
                key: "usage-check",
                tone: usageCheckTone(usage.usageCheckState),
                label: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.usageCheck", {
                  value: usage.usageCheckState ? stateLabel(usage.usageCheckState) : stateLabel("unknown"),
                }),
              },
            ]}
          />
        </WorkbenchActionRow>
        <WorkbenchGrid columns="equalDetail">
          <KeyValueList
            items={[
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.estimatedRequests"),
                value: formatEstimatedRequests(usage),
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.estimatedPayloads"),
                value: formatEstimatedPayloads(preview.targets),
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.pageSize"),
                value: usage.pageSize ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
              },
            ]}
          />
          <KeyValueList
            items={[
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.selectedFields"),
                value:
                  usage.selectedFields.length > 0
                    ? usage.selectedFields.join(", ")
                    : t("catalog.features.sourceObservations.ui.primaryWorkbench.none"),
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.fallback"),
                value:
                  usage.perRecordFallbackReason ??
                  t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.bulkFirst"),
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.transportSteps"),
                value:
                  transportSteps.length > 0
                    ? transportSteps.join(" / ")
                    : t("catalog.features.sourceObservations.ui.primaryWorkbench.none"),
              },
            ]}
          />
          <KeyValueList
            items={[
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.creditDiagnostic"),
                value:
                  usage.creditDiagnostic ??
                  t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.noCreditDiagnostic"),
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.degradedDiagnostic"),
                value:
                  usage.degradedDiagnostic ??
                  t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.noDegradedDiagnostic"),
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.planKeys"),
                value: preview.targets.map((target) => target.planKey).join(", "),
              },
            ]}
          />
        </WorkbenchGrid>
      </WorkbenchStack>
    </WorkbenchDetailPanel>
  );
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
  intent: Extract<CatalogPrimaryWorkbenchSubmitIntent, "job.retry" | "job.resume" | "job.cancel">;
  tone?: ButtonProps["tone"];
  children: ReactNode;
}) {
  const actionHref = useCatalogIntegrationCommandHref({ ...readModel.routeContext, jobId: job.jobId });

  return (
    <WorkbenchForm variant="button" method="post" action={actionHref} data-catalog-primary-workbench-command={intent}>
      <CommandHiddenInputs readModel={readModel} intent={intent} jobId={job.jobId} />
      <Button type="submit" size="sm" tone={tone}>
        {children}
      </Button>
    </WorkbenchForm>
  );
}

function importPreviewRouteKey(routeContext: CatalogPrimaryWorkbenchReadModel["routeContext"]): string {
  return [
    routeContext.providerKey ?? "provider:none",
    routeContext.unitKey ?? "unit:none",
    routeContext.importScope ?? "scope:none",
    routeContext.profileVersion ?? "profile:none",
  ].join("|");
}

function importPreviewScopeKey(scope: SourceObservationIntegrationImportPreview["scope"]): string {
  return [
    scope.language ?? "",
    scope.productLineId ?? "",
    scope.seriesId ?? "",
    scope.setId ?? scope.setName ?? "",
    scope.productId ?? "",
  ]
    .filter(Boolean)
    .join(":");
}

function importPreviewMatchesRouteContext(
  preview: SourceObservationIntegrationImportPreview,
  routeContext: CatalogPrimaryWorkbenchReadModel["routeContext"],
): boolean {
  return (
    scopeFieldMatches(preview.providerKey, routeContext.providerKey) &&
    scopeFieldMatches(preview.scope.provider, routeContext.providerKey) &&
    scopeFieldMatches(preview.scope.ingestionUnitKey, routeContext.unitKey) &&
    scopeFieldMatches(preview.scope.language, routeContext.scope?.languageCode) &&
    scopeFieldMatches(preview.scope.productLineId, routeContext.scope?.productLineId) &&
    scopeFieldMatches(preview.scope.seriesId, routeContext.scope?.seriesId) &&
    scopeAnyFieldMatches(
      [preview.scope.setId, preview.scope.setName],
      [routeContext.scope?.expansionId, routeContext.scope?.expansionName],
    )
  );
}

function scopeFieldMatches(actual: string | null | undefined, expected: string | null | undefined): boolean {
  const expectedValue = normalizedScopeValue(expected);
  if (!expectedValue) {
    return true;
  }

  return normalizedScopeValue(actual) === expectedValue;
}

function scopeAnyFieldMatches(
  actuals: readonly (string | null | undefined)[],
  expecteds: readonly (string | null | undefined)[],
): boolean {
  const expectedValues = expecteds.map(normalizedScopeValue).filter((value): value is string => Boolean(value));
  if (expectedValues.length === 0) {
    return true;
  }
  const actualValues = new Set(actuals.map(normalizedScopeValue).filter((value): value is string => Boolean(value)));

  return expectedValues.some((expected) => actualValues.has(expected));
}

function normalizedScopeValue(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

type ImportPreviewUsageSummary = Readonly<{
  requestStrategy: SourceObservationProviderUsageEstimate["requestStrategy"] | null;
  estimateState: SourceObservationProviderUsageEstimate["estimateState"] | null;
  estimatedRequestCount: number | null;
  usageCheckState: SourceObservationProviderUsageEstimate["usageCheckState"] | null;
  pageSize: number | null;
  selectedFields: readonly string[];
  perRecordFallbackReason: string | null;
  creditDiagnostic: string | null;
  degradedDiagnostic: string | null;
}>;

function previewUsageSummary(
  targets: readonly SourceObservationIntegrationImportPreviewTarget[],
): ImportPreviewUsageSummary {
  const estimates = targets.map((target) => target.usageEstimate).filter(isUsageEstimate);
  if (estimates.length === 0) {
    return {
      requestStrategy: null,
      estimateState: null,
      estimatedRequestCount: null,
      usageCheckState: null,
      pageSize: null,
      selectedFields: [],
      perRecordFallbackReason: null,
      creditDiagnostic: null,
      degradedDiagnostic: null,
    };
  }

  const estimatedRequestCount = estimates.every((estimate) => estimate.estimatedRequestCount !== null)
    ? sum(estimates, (estimate) => estimate.estimatedRequestCount ?? 0)
    : null;

  return {
    requestStrategy: commonValue(estimates.map((estimate) => estimate.requestStrategy)),
    estimateState: estimates.some((estimate) => estimate.estimateState === "estimate-unavailable")
      ? "estimate-unavailable"
      : "estimated",
    estimatedRequestCount,
    usageCheckState: commonValue(estimates.map((estimate) => estimate.usageCheckState)),
    pageSize: commonValue(estimates.map((estimate) => estimate.pageSize)),
    selectedFields: uniqueStrings(estimates.flatMap((estimate) => estimate.selectedFields)),
    perRecordFallbackReason:
      estimates.find((estimate) => estimate.perRecordFallbackReason)?.perRecordFallbackReason ?? null,
    creditDiagnostic: estimates.find((estimate) => estimate.creditDiagnostic)?.creditDiagnostic ?? null,
    degradedDiagnostic: estimates.find((estimate) => estimate.degradedDiagnostic)?.degradedDiagnostic ?? null,
  };
}

function isUsageEstimate(
  value: SourceObservationProviderUsageEstimate | null,
): value is SourceObservationProviderUsageEstimate {
  return value !== null;
}

function commonValue<T>(values: readonly T[]): T | null {
  const [first, ...rest] = values;
  if (first === undefined) {
    return null;
  }
  return rest.every((value) => value === first) ? first : null;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))];
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function formatEstimatedRequests(usage: ImportPreviewUsageSummary): string {
  if (usage.estimatedRequestCount !== null) {
    return String(usage.estimatedRequestCount);
  }
  if (usage.estimateState === "estimate-unavailable") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.import.preview.estimateUnavailable");
  }
  return t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected");
}

function formatEstimatedPayloads(targets: readonly SourceObservationIntegrationImportPreviewTarget[]): string {
  if (targets.length === 0 || targets.some((target) => target.estimatedPayloads === null)) {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected");
  }

  return String(sum(targets, (target) => target.estimatedPayloads ?? 0));
}

function usageStrategyTone(
  requestStrategy: SourceObservationProviderUsageEstimate["requestStrategy"] | null,
): "success" | "warning" | "danger" | "neutral" | "info" {
  if (requestStrategy === "bulk-first") {
    return "success";
  }
  if (requestStrategy === "single-record") {
    return "warning";
  }
  return "neutral";
}

function usageCheckTone(
  usageCheckState: SourceObservationProviderUsageEstimate["usageCheckState"] | null,
): "success" | "warning" | "danger" | "neutral" | "info" {
  if (usageCheckState === "checked") {
    return "success";
  }
  if (usageCheckState === "unavailable") {
    return "danger";
  }
  if (usageCheckState === "not-configured" || usageCheckState === "unknown") {
    return "warning";
  }
  return "neutral";
}

function importScopeDisplayLabel(importScope: string | null, providerKey: string | null): string {
  return importScope
    ? scopeDisplayLabel(scopeContextFromImportScope(importScope, providerKey))
    : t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected");
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
