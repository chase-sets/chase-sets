import { useMemo, type ReactNode } from "react";
import {
  Badge,
  BadgeCluster,
  Button,
  DataTable,
  EmptyState,
  KeyValueList,
  LinkText,
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
import {
  catalogPrimaryWorkbenchProviderTransportSummary,
  getCatalogPrimaryWorkbenchProviderTransportCopy,
} from "../../primary-workbench-copy";
import { catalogPrimaryWorkbenchHref } from "../../primary-workbench-route-context";
import { scopeContextFromImportScope, scopeDisplayLabel } from "../../primary-workbench-scope-context";
import { CommandHiddenInputs, type CatalogPrimaryWorkbenchSubmitIntent } from "../import-to-promotion/command-controls";
import { BlockerList, profileSnapshotLabel, stateLabel } from "../import-to-promotion/workbench-formatting";

type ImportJobRow = CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"][number];

export function CatalogIntegrationImportJobsModule({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
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

  return (
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
        getRowId={(job) => job.jobId}
        density="compact"
        emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.empty.title")}
        emptyDescription={t("catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.empty.description")}
      />
    </WorkflowModule>
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
