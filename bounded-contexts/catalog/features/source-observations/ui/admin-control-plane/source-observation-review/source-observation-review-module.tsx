import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useFetcher } from "react-router";
import {
  Badge,
  BadgeCluster,
  Banner,
  BulkActionBar,
  BulkActionPanel,
  Button,
  DataTable,
  EvidenceStringList,
  FilterArea,
  KeyValueList,
  LinkButton,
  SideSheet,
  Skeleton,
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
import type {
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchSourceObservationEvidenceDetail,
  CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData,
} from "../../../api/primary-workbench-admin-contracts";
import {
  useCatalogIntegrationCommandHref,
  useCatalogIntegrationSurfaceHref,
} from "../import-to-promotion/command-action-context";
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
  // Selection is URL-backed (single source of truth): the `Set` is the ephemeral
  // mirror the checkboxes and commands read, and the change handler persists each
  // edit to the URL. The handler takes the next `Set` directly (DataTable hands it
  // a concrete next selection), not a state-updater function.
  selectedObservationKeys: Set<string>;
  onSelectedObservationKeysChange: (keys: Set<string>) => void;
  selectedEligibleObservationCount: number;
  selectedReviewableObservationCount: number;
  // Optional alias-review visibility: alias coverage/candidates surfaced
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
                items={row.factSummaryPreview.map((fact) => ({
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
              row.duplicateCount > 0 ? (
                <Badge tone="warning">
                  {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.duplicate.count", {
                    count: row.duplicateCount,
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
      // No module-header action: "Preview promotion" belongs to the selection/bulk
      // surface below (and the Create / update stage), and the old "Save context"
      // GET round-trip is gone — selection is now continuously URL-backed (every
      // checkbox edit persists to the URL), so there is nothing left to manually
      // save.
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
        caption={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.title")}
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
  onSelectedObservationKeysChange: (keys: Set<string>) => void;
  selectedEligibleObservationCount: number;
  selectedReviewableObservationCount: number;
}>) {
  const selectedObservationIds = [...selectedObservationKeys];
  const previewDisabled = selectedEligibleObservationCount === 0;
  const deferDisabled = selectedReviewableObservationCount === 0 || !isActionAvailable(readModel, "observation.defer");

  return (
    <BulkActionBar
      count={selectedObservationKeys.size}
      formatSelectedLabel={(count) =>
        t("catalog.features.sourceObservations.ui.primaryWorkbench.review.selected", { count })
      }
      primaryActions={
        <CommandFormButton
          readModel={readModel}
          intent="observation.promote"
          promotionPhase="preview"
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
            intent="observation.defer"
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
  const actionHref = useCatalogIntegrationCommandHref(readModel.routeContext);
  const rejectDisabled =
    selectedReviewableObservationCount === 0 || !isActionAvailable(readModel, "observation.reject");
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
        action={actionHref}
        data-catalog-primary-workbench-command="observation.reject"
      >
        <CommandHiddenInputs
          readModel={readModel}
          intent="observation.reject"
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
  const previousHref = useCatalogIntegrationSurfaceHref(
    {
      ...readModel.routeContext,
      reviewOffset: Math.max(offset - limit, 0) || null,
    },
    "source-observation-review",
  );
  const nextHref = useCatalogIntegrationSurfaceHref(
    {
      ...readModel.routeContext,
      reviewOffset: offset + limit,
    },
    "source-observation-review",
  );
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
          <LinkButton size="sm" tone="secondary" leadingIcon="chevronLeft" href={previousHref} rel="prev">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.pager.previous")}
          </LinkButton>
        ) : null}
        {nextCursor ? (
          <LinkButton size="sm" tone="secondary" trailingIcon="chevronRight" href={nextHref} rel="next">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.pager.next")}
          </LinkButton>
        ) : null}
      </WorkbenchActionRow>
    </WorkbenchActionRow>
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
    actionEntry.key === "observation.promote" ||
    actionEntry.key === "observation.defer" ||
    actionEntry.key === "observation.reapply" ||
    actionEntry.key === "observation.replay"
  ) {
    return (
      <CommandFormButton
        readModel={readModel}
        intent={actionEntry.key}
        selectedObservationIds={[row.observationId]}
        size="sm"
        tone={actionEntry.key === "observation.promote" ? "primary" : "secondary"}
        reason={
          actionEntry.key === "observation.defer"
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

// Lazy evidence endpoint URL for one observation. The review list ships slim rows;
// the deep evidence is fetched from this resource route only when the
// sheet opens, keyed by observationId. Built as an absolute path so the fetcher
// hits the catalog-mounted route regardless of the current import surface URL.
function observationEvidenceHref(observationId: string): string {
  return `/catalog/integrations/observation-evidence/${encodeURIComponent(observationId)}`;
}

// Evidence SideSheet for one review row. The slim row carries everything the cell,
// the row actions, and this sheet's footer/blockers need inline; the deep facts /
// duplicates / conflicts / audit trail and the full provenance KeyValueList are
// lazy-loaded via a react-router fetcher to the evidence endpoint when the sheet
// opens. A DS skeleton shows while loading and a DS Banner shows if the
// fetch fails or the observation is gone, so the operator still sees the same
// evidence — only WHEN it is fetched changed. The fetch fires once per open and is
// not re-issued while the sheet stays open.
function SourceObservationEvidenceSheet({ row }: { row: SourceObservationReviewRow }) {
  const fetcher = useFetcher<CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData>();
  const [open, setOpen] = useState(false);

  // Load the evidence the first time the sheet opens for this row. `fetcher.load`
  // is idempotent for an already-loaded URL, but gating on `idle` + no data keeps
  // it to a single request and lets the operator reopen without a redundant fetch.
  useEffect(() => {
    if (open && fetcher.state === "idle" && !fetcher.data) {
      fetcher.load(observationEvidenceHref(row.observationId));
    }
  }, [open, fetcher, row.observationId]);

  const detail = fetcher.data?.detail ?? null;
  const loading = fetcher.state === "loading" || (open && !fetcher.data);
  const failed = fetcher.state === "idle" && Boolean(fetcher.data) && detail === null;

  return (
    <SideSheet
      open={open}
      onOpenChange={setOpen}
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
      <SourceObservationEvidenceSheetBody row={row} detail={detail} loading={loading} failed={failed} />
    </SideSheet>
  );
}

function SourceObservationEvidenceSheetBody({
  row,
  detail,
  loading,
  failed,
}: Readonly<{
  row: SourceObservationReviewRow;
  detail: CatalogPrimaryWorkbenchSourceObservationEvidenceDetail | null;
  loading: boolean;
  failed: boolean;
}>) {
  if (loading) {
    return (
      <WorkbenchStack gap="sm" data-catalog-observation-evidence="loading">
        <WorkbenchText size="xs" tone="secondary" role="status">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.loading")}
        </WorkbenchText>
        <Skeleton height="sm" />
        <Skeleton height="md" />
        <Skeleton height="md" />
      </WorkbenchStack>
    );
  }

  if (failed || !detail) {
    return (
      <Banner
        tone="danger"
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.error.title")}
        description={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.error.description")}
        data-catalog-observation-evidence="error"
      />
    );
  }

  return (
    <WorkbenchStack data-catalog-observation-evidence="loaded">
      <KeyValueList
        items={[
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.provider"),
            value: detail.providerKey,
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.external"),
            value: detail.externalKey,
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.source.url"),
            value: detail.sourceUrl,
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.hash"),
            value: detail.sourceRecordHash,
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.observed"),
            value: detail.observedAt,
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.changed"),
            value: detail.sourceUpdatedAt ?? detail.changedAt,
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.key.profile"),
            value: detail.sourceProfileVersion,
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.promotion.profile"),
            value:
              detail.promotionProfileVersion ??
              t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.payload"),
            value: detail.payloadSummary,
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.redaction"),
            value: detail.redactionSummary,
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.key.command.preview"),
            value:
              detail.commandPreview.promotionPlanHash ??
              t("catalog.features.sourceObservations.ui.primaryWorkbench.review.preview.required"),
          },
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.productContents"),
            value: detail.productContentsEvidence.summary,
          },
        ]}
      />

      <EvidenceStringList
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.normalized")}
        items={detail.normalizedFactSummaries}
        emptyLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}
      />
      <EvidenceStringList
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.productContents")}
        items={productContentsEvidenceItems(detail)}
        emptyLabel={detail.productContentsEvidence.summary}
      />
      <EvidenceStringList
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.duplicates")}
        items={detail.duplicateEvidence}
        emptyLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.no.duplicates")}
      />
      <EvidenceStringList
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.conflicts")}
        items={detail.conflictEvidence}
        emptyLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.no.conflicts")}
      />
      <EvidenceStringList
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.audit")}
        items={detail.auditTrail}
        emptyLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}
      />
      <BlockerList blockers={row.promotionReadiness.blockers} />
    </WorkbenchStack>
  );
}

function productContentsEvidenceItems(
  detail: CatalogPrimaryWorkbenchSourceObservationEvidenceDetail,
): readonly string[] {
  return detail.productContentsEvidence.rows.map((row) =>
    t("catalog.features.sourceObservations.ui.primaryWorkbench.review.productContents.line", {
      lineNumber: row.lineNumber,
      state: stateLabel(row.state),
      contentType: row.contentTypeLabel,
      policy:
        row.inclusionPolicyLabel ??
        t("catalog.features.sourceObservations.ui.primaryWorkbench.review.productContents.policy.none"),
      quantity:
        row.quantity ??
        t("catalog.features.sourceObservations.ui.primaryWorkbench.review.productContents.quantity.variable"),
      target: row.targetSummary,
      options:
        row.containedSelectedOptionLabels.length > 0
          ? row.containedSelectedOptionLabels.join(", ")
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.review.productContents.selectedOptions.none"),
      provenance:
        row.provenanceSummary.length > 0
          ? row.provenanceSummary.join(", ")
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.review.productContents.provenance.none"),
    }),
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
    case "observation.promote":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.promotion");
    case "observation.reject":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.reject");
    case "observation.defer":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.defer");
    case "observation.reapply":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.reapply");
    case "observation.replay":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.replay");
  }
}
