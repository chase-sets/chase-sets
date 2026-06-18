import { useId, useMemo, type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
  Badge,
  BadgeCluster,
  BulkActionBar,
  BulkActionPanel,
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

      <SourceObservationReviewPager readModel={readModel} />

      {selectedObservationKeys.size > 0 ? (
        <SourceObservationReviewBulkActionBar
          readModel={readModel}
          selectedObservationKeys={selectedObservationKeys}
          onSelectedObservationKeysChange={onSelectedObservationKeysChange}
          selectedEligibleObservationCount={selectedEligibleObservationCount}
          selectedReviewableObservationCount={selectedReviewableObservationCount}
        />
      ) : null}
    </WorkflowModule>
  );
}

// The selected-record command surface is the ONE canonical BulkActionBar the dense
// admin workbench DS mandates (the shell already wraps the module in
// BulkActionSurface, which enforces a single bar). Primary = "Preview promotion"
// (eligible-gated); secondary = "Defer" / "Clear selection"; the destructive,
// reason-required "Reject" lives in a BulkActionPanel. Each command keeps the same
// CommandFormButton / CommandHiddenInputs POST semantics (and the same
// eligible/reviewable + isActionAvailable gating) it had hand-rolled — only the
// presentation moves into the DS primitive. Disabled commands carry an accessible
// denial label, mirroring the per-row action taxonomy.
function SourceObservationReviewBulkActionBar({
  readModel,
  selectedObservationKeys,
  onSelectedObservationKeysChange,
  selectedEligibleObservationCount,
  selectedReviewableObservationCount,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  selectedObservationKeys: Set<string>;
  onSelectedObservationKeysChange: Dispatch<SetStateAction<Set<string>>>;
  selectedEligibleObservationCount: number;
  selectedReviewableObservationCount: number;
}>) {
  const selectedObservationIds = [...selectedObservationKeys];
  const previewDisabled = selectedEligibleObservationCount === 0;
  const deferDisabled =
    selectedReviewableObservationCount === 0 || !isActionAvailable(readModel, "defer-source-observations");

  return (
    <BulkActionBar
      count={selectedObservationKeys.size}
      formatSelectedLabel={(count) =>
        t("catalog.features.sourceObservations.ui.primaryWorkbench.review.selected", { count })
      }
      primaryActions={
        <CommandFormButton
          readModel={readModel}
          intent="preview-promotion"
          size="sm"
          selectedObservationIds={selectedObservationIds}
          disabled={previewDisabled}
          aria-label={
            previewDisabled
              ? t("catalog.features.sourceObservations.ui.primaryWorkbench.review.bulk.preview.denied")
              : undefined
          }
        >
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.promotion")}
        </CommandFormButton>
      }
      secondaryActions={
        <>
          <CommandFormButton
            readModel={readModel}
            intent="defer-source-observations"
            size="sm"
            tone="secondary"
            selectedObservationIds={selectedObservationIds}
            reason={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.defer.reason")}
            disabled={deferDisabled}
            aria-label={
              deferDisabled
                ? t("catalog.features.sourceObservations.ui.primaryWorkbench.review.bulk.defer.denied")
                : undefined
            }
          >
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.defer")}
          </CommandFormButton>
          <SourceObservationRejectPanel
            readModel={readModel}
            selectedObservationIds={selectedObservationIds}
            selectedEligibleObservationCount={selectedEligibleObservationCount}
            selectedReviewableObservationCount={selectedReviewableObservationCount}
          />
          <Button size="sm" tone="secondary" onClick={() => onSelectedObservationKeysChange(new Set())}>
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.clear.selection")}
          </Button>
        </>
      }
    />
  );
}

// Reject is destructive and reason-required, so it belongs in a BulkActionPanel
// rather than as a bare bulk action (DS Command Safety: "advanced or risky
// selected-record choices belong in BulkActionPanel"). The panel body carries the
// selection-impact facts (reviewable / eligible / command plan) and the free-text
// reason input; the reject command keeps its CommandHiddenInputs POST semantics.
// The submit button lives in the panel footer and associates to the body form via
// the native form/id association, so a single <form> spans body + footer without
// re-adding app-owned layout markup.
function SourceObservationRejectPanel({
  readModel,
  selectedObservationIds,
  selectedEligibleObservationCount,
  selectedReviewableObservationCount,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  selectedObservationIds: readonly string[];
  selectedEligibleObservationCount: number;
  selectedReviewableObservationCount: number;
}>) {
  const rejectFormId = useId();
  const rejectDisabled =
    selectedReviewableObservationCount === 0 || !isActionAvailable(readModel, "reject-source-observations");
  const rejectDeniedLabel = rejectDisabled
    ? t("catalog.features.sourceObservations.ui.primaryWorkbench.review.bulk.reject.denied")
    : undefined;

  return (
    <BulkActionPanel
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.bulk.reject.title")}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.bulk.reject.description")}
      trigger={
        <Button size="sm" tone="secondary" leadingIcon="trash">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.bulk.reject.trigger")}
        </Button>
      }
      footer={
        <Button
          type="submit"
          form={rejectFormId}
          size="sm"
          tone="secondary"
          disabled={rejectDisabled}
          aria-label={rejectDeniedLabel}
        >
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.reject")}
        </Button>
      }
    >
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
        id={rejectFormId}
        variant="plain"
        method="post"
        action={catalogPrimaryWorkbenchHref(readModel.routeContext, "import-to-promotion")}
        data-catalog-primary-workbench-command="reject-source-observations"
      >
        <CommandHiddenInputs
          readModel={readModel}
          intent="reject-source-observations"
          selectedObservationIds={selectedObservationIds}
        />
        <TextInput
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.reject.reason")}
          name="reason"
          required
          disabled={rejectDisabled}
        />
      </WorkbenchForm>
    </BulkActionPanel>
  );
}

// GET-navigation pager for the Source Observation review queue. The daily surface
// is loader-driven, so each page is a full navigation: building the prev/next
// hrefs from the current routeContext (only overriding reviewOffset) preserves
// provider/unit/scope/filters AND the current selection (selectedObservationIds)
// across pages, and the loader re-reads the offset to fetch that page. Prev/next
// render only when a page exists in that direction, so the boundaries are dead
// ends by absence rather than disabled controls.
function SourceObservationReviewPager({ readModel }: { readModel: CatalogPrimaryWorkbenchReadModel }) {
  const { limit, offset, total, nextCursor, previousCursor } = readModel.sourceObservationReview.pagination;
  if (total <= limit) {
    return null;
  }

  const pageCount = Math.max(Math.ceil(total / limit), 1);
  const currentPage = Math.floor(offset / limit) + 1;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + limit, total);

  return (
    <WorkbenchActionRow
      align="between"
      aria-label={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.pager.label")}
    >
      <WorkbenchText size="xs" tone="secondary">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.pager.summary", {
          rangeStart,
          rangeEnd,
          total,
          currentPage,
          pageCount,
        })}
      </WorkbenchText>
      <WorkbenchActionRow>
        {previousCursor ? (
          <LinkButton
            size="sm"
            tone="secondary"
            leadingIcon="chevronLeft"
            href={reviewPageHref(readModel, Math.max(offset - limit, 0))}
            rel="prev"
          >
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.pager.previous")}
          </LinkButton>
        ) : null}
        {nextCursor ? (
          <LinkButton
            size="sm"
            tone="secondary"
            trailingIcon="chevronRight"
            href={reviewPageHref(readModel, offset + limit)}
            rel="next"
          >
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.pager.next")}
          </LinkButton>
        ) : null}
      </WorkbenchActionRow>
    </WorkbenchActionRow>
  );
}

// Build a review-page GET href that preserves the full working set and only moves
// the durable reviewOffset cursor. The first page drops the offset entirely so the
// canonical URL stays clean (serialization omits offset 0).
function reviewPageHref(readModel: CatalogPrimaryWorkbenchReadModel, targetOffset: number): string {
  return catalogPrimaryWorkbenchHref(
    {
      ...readModel.routeContext,
      reviewOffset: targetOffset > 0 ? targetOffset : null,
    },
    "source-observation-review",
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
