import {
  BadgeCluster,
  Button,
  HiddenInput,
  LinkButton,
  Textarea,
  WorkbenchActionRow,
  WorkbenchForm,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchMergeCandidateReviewRow,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import { useCatalogIntegrationCommandHref } from "./command-action-context";

// The anchor the scope bulk toolbar's "Jump to conflicts" control targets. The
// candidate review table sets this id so the operator can jump straight to the
// candidates that still need conflict resolution without leaving the page.
export const catalogMergeCandidateReviewAnchorId = "catalog-merge-candidate-review";

type MergeCandidateRow = CatalogPrimaryWorkbenchMergeCandidateReviewRow;

// Scope-level bulk review actions. Operates on the whole scope's candidate
// set at once: promote all ready, jump to the conflicts that still need
// resolution, and defer the remainder with a reason. The candidate IDs are
// partitioned by status from the durable, scope-filtered review set, so
// blocking-conflict resolution requirements stay intact — only `ready` candidates
// are ever bulk-promoted; has-conflicts / stale / deferred are skipped and
// reported.
export function CatalogScopeBulkReviewActions({
  readModel,
}: Readonly<{ readModel: CatalogPrimaryWorkbenchReadModel }>) {
  const rows = readModel.mergeCandidateReview.rows;
  const canManage = readModel.readiness.rbacAllowed;
  const partition = partitionCandidates(rows);
  const action = useCatalogIntegrationCommandHref(readModel.routeContext);

  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.bulk.title")}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.bulk.description")}
      status={
        <BadgeCluster
          items={[
            {
              key: "ready",
              label: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.bulk.summary.ready", {
                count: partition.promotableIds.length,
              }),
              tone: partition.promotableIds.length > 0 ? "success" : "neutral",
            },
            {
              key: "conflict",
              label: t(
                "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.bulk.summary.conflict",
                {
                  count: partition.conflictIds.length,
                },
              ),
              tone: partition.conflictIds.length > 0 ? "warning" : "neutral",
            },
            {
              key: "remainder",
              label: t(
                "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.bulk.summary.remainder",
                {
                  count: partition.remainderIds.length,
                },
              ),
              tone: "neutral",
            },
          ]}
        />
      }
      headingLevel={2}
      density="compact"
    >
      {rows.length === 0 ? (
        <WorkbenchText size="sm">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.bulk.empty")}
        </WorkbenchText>
      ) : (
        <WorkbenchStack gap="md">
          <WorkbenchActionRow>
            <WorkbenchForm
              variant="button"
              method="post"
              action={action}
              data-catalog-merge-candidate-bulk-promote="true"
            >
              <HiddenInput name="_intent" value="bulk-candidate.promotes" />
              <HiddenInput name="bulkCandidateIds" value={partition.promotableIds.join(",")} />
              <Button
                type="submit"
                tone="primary"
                size="sm"
                disabled={!canManage || partition.promotableIds.length === 0}
              >
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.bulk.promoteAll")}
              </Button>
            </WorkbenchForm>
            {partition.conflictIds.length > 0 ? (
              <LinkButton
                size="sm"
                tone="secondary"
                leadingIcon="warning"
                href={`#${catalogMergeCandidateReviewAnchorId}`}
              >
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.bulk.jumpToConflicts")}
              </LinkButton>
            ) : (
              <Button size="sm" tone="secondary" disabled>
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.bulk.jumpToConflicts")}
              </Button>
            )}
          </WorkbenchActionRow>
          <WorkbenchText size="xs">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.bulk.promoteAll.skip", {
              count: partition.remainderIds.length,
            })}
          </WorkbenchText>
          <WorkbenchForm variant="surface" method="post" action={action} data-catalog-merge-candidate-bulk-defer="true">
            <HiddenInput name="_intent" value="bulk-candidate.defers" />
            <HiddenInput name="bulkCandidateIds" value={partition.remainderIds.join(",")} />
            <Textarea
              name="reason"
              label={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.bulk.deferReason")}
              required
              rows={2}
            />
            <WorkbenchActionRow align="end">
              <Button
                type="submit"
                tone="secondary"
                size="sm"
                disabled={!canManage || partition.remainderIds.length === 0}
              >
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.bulk.deferRemainder")}
              </Button>
            </WorkbenchActionRow>
          </WorkbenchForm>
        </WorkbenchStack>
      )}
    </WorkflowModule>
  );
}

type CandidatePartition = Readonly<{
  promotableIds: readonly string[];
  conflictIds: readonly string[];
  remainderIds: readonly string[];
}>;

// Partition the scope's candidates by review status. Only `ready` candidates with
// no promote blockers are promotable; has-conflicts / stale / actionable-blocked
// candidates are the deferrable remainder; terminal (promoted / rejected /
// deferred) candidates are excluded from every bulk set.
export function partitionCandidates(rows: readonly MergeCandidateRow[]): CandidatePartition {
  const promotableIds: string[] = [];
  const conflictIds: string[] = [];
  const remainderIds: string[] = [];

  for (const row of rows) {
    if (isTerminal(row)) {
      continue;
    }
    if (row.status === "has-conflicts") {
      conflictIds.push(row.candidateId);
    }
    if (isPromotable(row)) {
      promotableIds.push(row.candidateId);
    } else {
      remainderIds.push(row.candidateId);
    }
  }

  return { promotableIds, conflictIds, remainderIds };
}

function isPromotable(row: MergeCandidateRow): boolean {
  return row.status === "ready" && row.promoteReadiness.state === "ready";
}

function isTerminal(row: MergeCandidateRow): boolean {
  return row.status === "promoted" || row.status === "rejected" || row.status === "deferred";
}
