import { useMemo, type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
  Badge,
  BadgeCluster,
  Button,
  DataTable,
  EvidenceStringList,
  FilterArea,
  KeyValueList,
  LinkButton,
  SideSheet,
  TextInput,
  WorkbenchActionRow,
  WorkbenchDataCell,
  WorkbenchDetailPanel,
  WorkbenchForm,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { catalogPrimaryWorkbenchHref } from "../../primary-workbench-route-context";
import { CommandFormButton, CommandHiddenInputs, isActionAvailable } from "../import-to-promotion/command-controls";
import { BlockerList, stateLabel, uniqueBlockers } from "../import-to-promotion/workbench-formatting";

type SourceObservationReviewRow = CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number];

export function isReviewableObservationRow(row: SourceObservationReviewRow): boolean {
  return row.status === "observed" || row.status === "changed";
}

export function CatalogIntegrationSourceObservationReviewModule({
  readModel,
  selectedObservationKeys,
  onSelectedObservationKeysChange,
  selectedEligibleObservationCount,
  selectedReviewableObservationCount,
  aliasVisibility = null,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  selectedObservationKeys: Set<string>;
  onSelectedObservationKeysChange: Dispatch<SetStateAction<Set<string>>>;
  selectedEligibleObservationCount: number;
  selectedReviewableObservationCount: number;
  // Optional alias-review visibility (#1908): alias coverage/candidates surfaced
  // before promotion so operators see proposed equivalents while reviewing
  // Source Observations. Decoupled as a slot so this module stays agnostic of the
  // alias read model.
  aliasVisibility?: ReactNode;
}>) {
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
        // "Preview promotion" is NOT duplicated on the module action row: it
        // belongs to the selection/bulk surface below (and the Create / update
        // stage). The module header keeps only the save-context affordance.
        <LinkButton
          size="sm"
          tone="secondary"
          leadingIcon="filter"
          href={catalogPrimaryWorkbenchHref(readModel.routeContext, "source-observation-review")}
        >
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.save.context")}
        </LinkButton>
      }
      headingLevel={2}
      density="compact"
    >
      <FilterArea
        sticky={false}
        activeFilterCount={readModel.sourceObservationReview.filters.filter((filterEntry) => filterEntry.value).length}
        panelTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filters.title")}
        panelDescription={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filters.description")}
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

      {aliasVisibility}

      <DataTable
        rows={[...readModel.sourceObservationReview.rows]}
        columns={reviewColumns}
        getRowId={(row) => row.observationId}
        selectedKeys={selectedObservationKeys}
        onSelectionChange={onSelectedObservationKeysChange}
        isRowSelectable={isReviewableObservationRow}
        density="compact"
        emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.empty.title")}
        emptyDescription={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.empty.description")}
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
                  selectedReviewableObservationCount === 0 || !isActionAvailable(readModel, "defer-source-observations")
                }
              >
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.defer")}
              </CommandFormButton>
              <Button size="sm" tone="secondary" onClick={() => onSelectedObservationKeysChange(new Set())}>
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
                selectedReviewableObservationCount === 0 || !isActionAvailable(readModel, "reject-source-observations")
              }
            />
            <Button
              type="submit"
              size="sm"
              tone="secondary"
              disabled={
                selectedReviewableObservationCount === 0 || !isActionAvailable(readModel, "reject-source-observations")
              }
            >
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.reject")}
            </Button>
          </WorkbenchForm>
        </WorkbenchDetailPanel>
      ) : null}
    </WorkflowModule>
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
