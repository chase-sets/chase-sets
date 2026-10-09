import {
  Badge,
  Banner,
  DataTable,
  LinkButton,
  WorkbenchActionRow,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
  type BadgeTone,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogMergeCandidateBulkJob, CatalogMergeCandidateBulkJobPage } from "../../../api/runtime";

// The scope's Catalog Merge Candidate review jobs: active jobs with their
// progress, then the newest page of completed jobs with their terminal counts
// and the Catalog Items their promoted candidates target. Completed jobs page 50
// at a time; the next-page control follows the list route's opaque cursor.
// The scope page query parameter carrying the completed-jobs page cursor.
export const candidateReviewJobsCursorParam = "candidateJobsCursor";

export function candidateReviewJobsPageHref(scopeHref: string, cursor: string): string {
  return `${scopeHref}?${new URLSearchParams({ [candidateReviewJobsCursorParam]: cursor }).toString()}`;
}

export type CatalogScopeCandidateReviewJobs = Readonly<{
  active: readonly CatalogMergeCandidateBulkJob[];
  completed: CatalogMergeCandidateBulkJobPage;
  failed: boolean;
}>;

export type CatalogScopeCandidateReviewJobsPanelProps = Readonly<{
  jobs: CatalogScopeCandidateReviewJobs;
  /** Href that shows the completed page after `cursor`; null on the last page. */
  nextPageHref: string | null;
  /** Href back to the newest completed page; null when already on it. */
  firstPageHref: string | null;
}>;

const statusTone: Record<CatalogMergeCandidateBulkJob["status"], BadgeTone> = {
  queued: "neutral",
  running: "info",
  completed: "success",
  failed: "danger",
};

export function CatalogScopeCandidateReviewJobsPanel({
  jobs,
  nextPageHref,
  firstPageHref,
}: CatalogScopeCandidateReviewJobsPanelProps) {
  const rows = [...jobs.active, ...jobs.completed.items];

  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.title")}
      description={t("catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.description")}
      headingLevel={2}
      density="compact"
      data-catalog-candidate-review-jobs="true"
    >
      <WorkbenchStack gap="md">
        {jobs.failed ? (
          <Banner
            tone="warning"
            title={t("catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.unavailable.title")}
            description={t(
              "catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.unavailable.description",
            )}
          />
        ) : null}
        <DataTable
          rows={rows}
          columns={candidateReviewJobColumns}
          caption={t("catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.title")}
          getRowId={(job) => job.jobId}
          getRowProps={(job) => ({ "data-candidate-review-job-id": job.jobId })}
          density="compact"
          emptyTitle={t("catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.empty.title")}
          emptyDescription={t(
            "catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.empty.description",
          )}
        />
        {nextPageHref || firstPageHref ? (
          <WorkbenchActionRow>
            {firstPageHref ? (
              <LinkButton size="sm" tone="secondary" href={firstPageHref}>
                {t("catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.firstPage")}
              </LinkButton>
            ) : null}
            {nextPageHref ? (
              <LinkButton size="sm" tone="secondary" href={nextPageHref} data-candidate-review-jobs-next-page="true">
                {t("catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.nextPage")}
              </LinkButton>
            ) : null}
          </WorkbenchActionRow>
        ) : null}
      </WorkbenchStack>
    </WorkflowModule>
  );
}

const candidateReviewJobColumns: DataColumn<CatalogMergeCandidateBulkJob>[] = [
  {
    key: "job",
    header: t("catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.column.job"),
    cell: (job) => (
      <WorkbenchStack gap="sm">
        <WorkbenchText size="sm">{kindLabel(job.kind)}</WorkbenchText>
        <WorkbenchText size="xs" tone="secondary">
          {job.jobId}
        </WorkbenchText>
      </WorkbenchStack>
    ),
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.column.status"),
    cell: (job) => (
      <WorkbenchStack gap="sm">
        <Badge tone={statusTone[job.status]}>{job.status}</Badge>
        <WorkbenchText size="xs" tone="secondary">
          {t("catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.progress", {
            completed: job.progress.completed,
            total: job.progress.total,
          })}
        </WorkbenchText>
      </WorkbenchStack>
    ),
  },
  {
    key: "counts",
    header: t("catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.column.counts"),
    cell: (job) =>
      job.result ? (
        <WorkbenchText size="sm">
          {t("catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.counts", {
            promoted: job.result.promoted,
            deferred: job.result.deferred,
            skipped: job.result.skippedNotEligible,
            failed: job.result.failed,
          })}
        </WorkbenchText>
      ) : (
        <WorkbenchText size="sm" tone="secondary">
          {t("catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.counts.pending")}
        </WorkbenchText>
      ),
  },
  {
    key: "catalogItems",
    header: t("catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.column.catalogItems"),
    cell: (job) => {
      const catalogItemIds = promotedCatalogItemIds(job);
      return catalogItemIds.length > 0 ? (
        <WorkbenchStack gap="sm">
          {catalogItemIds.map((catalogItemId) => (
            <WorkbenchText key={catalogItemId} size="xs" data-promoted-catalog-item-id={catalogItemId}>
              {catalogItemId}
            </WorkbenchText>
          ))}
        </WorkbenchStack>
      ) : (
        <WorkbenchText size="sm" tone="secondary">
          {t("catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.catalogItems.none")}
        </WorkbenchText>
      );
    },
  },
];

export function promotedCatalogItemIds(job: CatalogMergeCandidateBulkJob): readonly string[] {
  return [
    ...new Set(
      (job.result?.outcomes ?? []).flatMap((outcome) =>
        outcome.status === "promoted" && outcome.catalogItemId ? [outcome.catalogItemId] : [],
      ),
    ),
  ];
}

function kindLabel(kind: CatalogMergeCandidateBulkJob["kind"]): string {
  return kind === "merge-candidate-promote"
    ? t("catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.kind.promote")
    : t("catalog.features.sourceObservations.ui.scopeDetail.candidateReviewJobs.kind.defer");
}
