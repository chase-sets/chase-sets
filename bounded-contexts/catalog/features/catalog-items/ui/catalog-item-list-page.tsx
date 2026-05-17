import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { useState, useMemo } from "react";
import { useRevalidator } from "react-router";
import {
  Button,
  DataTable,
  Dialog,
  Inline,
  Select,
  Stack,
  StatusPill,
  Text,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityListPage } from "../../../support/shell-support/ui/entity-list-page";
import { BulkLifecycleActionBar } from "../../../support/shell-support/ui/bulk-lifecycle-actions";
import {
  type CatalogListRouteData,
  useCatalogListQueryControls,
} from "../../../support/shell-support/list-query-state";
import {
  confirmBulkPublishCatalogItems,
  confirmBulkCatalogItemEdit,
  confirmBulkCatalogItemLifecycle,
  createCatalogItem,
  localizedTextMapFromEnglish,
  previewBulkCatalogItemEdit,
  previewBulkCatalogItemLifecycle,
  previewBulkPublishCatalogItems,
} from "./use-catalog-items";
import type {
  BulkEditCatalogItemCandidate,
  BulkEditCatalogItemOperation,
  BulkEditCatalogItemPreview,
  BulkEditCatalogItemResult,
  BulkPublishCandidate,
  BulkPublishPreview,
  BulkPublishResult,
  CatalogItemListItem,
} from "./contracts";

function buildColumns(): DataColumn<CatalogItemListItem>[] {
  return [
    { key: "title", header: t("catalog.features.catalogItems.ui.catalogItemListPage.title"), cell: (row) => row.title },
    { key: "subtitle", header: t("catalog.features.catalogItems.ui.catalogItemListPage.subtitle"), cell: (row) => row.subtitle ?? "—" },
    { key: "language", header: t("catalog.features.catalogItems.ui.catalogItemListPage.language"), cell: (row) => formatLanguageCodeLabel(row.language_code) },
    { key: "blueprint", header: t("catalog.features.catalogItems.ui.catalogItemListPage.blueprint"), cell: (row) => row.blueprint?.name ?? "—" },
    {
      key: "source",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.source"),
      cell: (row) => row.source_providers.length > 0 ? row.source_providers.join(", ") : "—",
    },
    { key: "status", header: t("catalog.features.catalogItems.ui.catalogItemListPage.status"), cell: (row) => <StatusPill>{row.status}</StatusPill> },
  ];
}

function buildBulkPreviewColumns(): DataColumn<BulkPublishCandidate>[] {
  return [
    { key: "title", header: t("catalog.features.catalogItems.ui.catalogItemListPage.title"), cell: (row) => row.title },
    { key: "source", header: t("catalog.features.catalogItems.ui.catalogItemListPage.source"), cell: (row) => row.source_providers.join(", ") || "—" },
    { key: "status", header: t("catalog.features.catalogItems.ui.catalogItemListPage.status"), cell: (row) => row.status },
    { key: "outcome", header: t("catalog.features.catalogItems.ui.catalogItemListPage.result"), cell: (row) => <StatusPill>{row.outcome}</StatusPill> },
    { key: "reason", header: t("catalog.features.catalogItems.ui.catalogItemListPage.reason"), cell: (row) => row.reason ?? "—" },
  ];
}

function buildBulkEditColumns(): DataColumn<BulkEditCatalogItemCandidate>[] {
  return [
    { key: "title", header: t("catalog.features.catalogItems.ui.catalogItemListPage.title"), cell: (row) => row.title },
    { key: "status", header: t("catalog.features.catalogItems.ui.catalogItemListPage.status"), cell: (row) => row.status },
    { key: "blueprint", header: t("catalog.features.catalogItems.ui.catalogItemListPage.blueprint.id"), cell: (row) => row.blueprint_id ?? "—" },
    {
      key: "categories",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.category.ids"),
      cell: (row) => row.category_ids.join(", ") || "—",
    },
    {
      key: "tags",
      header: t("catalog.features.catalogItems.ui.catalogItemListPage.tags"),
      cell: (row) => row.tags.join(", ") || "—",
    },
    { key: "outcome", header: t("catalog.features.catalogItems.ui.catalogItemListPage.result"), cell: (row) => <StatusPill>{row.outcome}</StatusPill> },
    { key: "reason", header: t("catalog.features.catalogItems.ui.catalogItemListPage.reason"), cell: (row) => row.reason ?? "—" },
  ];
}

const statusOptions = [
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.draft"), value: "draft" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.active"), value: "active" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.retired"), value: "retired" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.archived"), value: "archived" },
];

const ALL_LANGUAGES = "__all__";
const ALL_FILTER_VALUES = "__all__";

const languageOptions = [
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.english"), value: "en" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.japanese"), value: "ja" },
];
const booleanOptions = [
  { label: t("catalog.support.shellSupport.ui.entityListPage.all"), value: ALL_FILTER_VALUES },
  { label: t("catalog.support.shellSupport.ui.entityListPage.yes"), value: "true" },
  { label: t("catalog.support.shellSupport.ui.entityListPage.no"), value: "false" },
];
const blueprintStateOptions = [
  { label: t("catalog.support.shellSupport.ui.entityListPage.all"), value: ALL_FILTER_VALUES },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.blueprint.assigned"), value: "assigned" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.blueprint.missing"), value: "missing" },
];
const lifecycleActions = [
  { value: "retire", label: t("catalog.features.catalogItems.ui.catalogItemDetailPage.retire") },
  { value: "archive", label: t("catalog.features.catalogItems.ui.catalogItemDetailPage.archive") },
];
const bulkEditActions = [
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.assign.blueprint"), value: "assignBlueprint" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.assign.category"), value: "assignCategory" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.remove.category"), value: "removeCategory" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.set.tags"), value: "setTags" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.merge.tags"), value: "mergeTags" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.clear.tags"), value: "clearTags" },
];

export function CatalogItemListPage({ data, query }: CatalogListRouteData<CatalogItemListItem>) {
  const listControls = useCatalogListQueryControls(query);
  const revalidator = useRevalidator();
  const columns = useMemo(() => buildColumns(), []);
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [description, setDescription] = useState("");
  const [languageCode, setLanguageCode] = useState("en");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bulkPreview, setBulkPreview] = useState<BulkPublishPreview | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkPublishResult | null>(null);
  const [bulkScopeLabel, setBulkScopeLabel] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkColumns = useMemo(() => buildBulkPreviewColumns(), []);
  const bulkRows = (bulkResult?.candidates ?? bulkPreview?.candidates ?? []).slice(0, 20);
  const [bulkEditAction, setBulkEditAction] = useState<BulkEditCatalogItemOperation["action"]>("assignBlueprint");
  const [bulkEditBlueprintId, setBulkEditBlueprintId] = useState("");
  const [bulkEditCategoryId, setBulkEditCategoryId] = useState("");
  const [bulkEditTags, setBulkEditTags] = useState("");
  const [bulkEditSelection, setBulkEditSelection] = useState<unknown | null>(null);
  const [bulkEditOperation, setBulkEditOperation] = useState<BulkEditCatalogItemOperation | null>(null);
  const [bulkEditPreview, setBulkEditPreview] = useState<BulkEditCatalogItemPreview | null>(null);
  const [bulkEditResult, setBulkEditResult] = useState<BulkEditCatalogItemResult | null>(null);
  const [bulkEditBusy, setBulkEditBusy] = useState(false);
  const bulkEditColumns = useMemo(() => buildBulkEditColumns(), []);
  const bulkEditRows = (bulkEditResult?.candidates ?? bulkEditPreview?.candidates ?? []).slice(0, 20);
  const bulkEditActionLabel = bulkEditActions.find((action) => action.value === bulkEditAction)?.label ?? bulkEditAction;
  const canPreviewBulkEdit = bulkEditAction === "clearTags"
    || (bulkEditAction === "assignBlueprint" && bulkEditBlueprintId.trim().length > 0)
    || ((bulkEditAction === "assignCategory" || bulkEditAction === "removeCategory") && bulkEditCategoryId.trim().length > 0)
    || ((bulkEditAction === "setTags" || bulkEditAction === "mergeTags") && tagsFromInput(bulkEditTags).length > 0);

  async function handleCreate() {
    const itemId = createId("cat");
    await createCatalogItem({
      itemId,
      languageCode,
      title: localizedTextMapFromEnglish(title),
      subtitle: subtitle ? localizedTextMapFromEnglish(subtitle) : null,
      description: localizedTextMapFromEnglish(description),
    });
    addToast(t("catalog.features.catalogItems.ui.catalogItemListPage.catalog.item.created"), "success");
    setShowCreate(false);
    setTitle("");
    setSubtitle("");
    setDescription("");
    setLanguageCode("en");
    revalidator.revalidate();
  }

  async function handlePreviewSelected() {
    await handlePreviewBulkPublish(
      { mode: "ids", ids: [...selectedKeys] },
      t("catalog.features.catalogItems.ui.catalogItemListPage.selected.items"),
    );
  }

  async function handlePreviewFilteredDrafts() {
    await handlePreviewBulkPublish(
      {
        mode: "filter",
        query: {
          search: listControls.search,
          status: "draft",
          language: listControls.language,
          source: listControls.source,
        },
      },
      t("catalog.features.catalogItems.ui.catalogItemListPage.filtered.drafts"),
    );
  }

  async function handlePreviewBulkPublish(selection: unknown, scopeLabel: string) {
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const preview = await previewBulkPublishCatalogItems(selection);
      setBulkPreview(preview);
      setBulkScopeLabel(scopeLabel);
    } catch (error) {
      addToast(error instanceof Error ? error.message : String(error), "danger");
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleConfirmBulkPublish() {
    if (!bulkPreview) {
      return;
    }

    setBulkBusy(true);
    try {
      const result = await confirmBulkPublishCatalogItems(bulkPreview.item_ids);
      setBulkResult(result);
      addToast(t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.publish.completed"), "success");
      setSelectedKeys(new Set());
      revalidator.revalidate();
    } catch (error) {
      addToast(error instanceof Error ? error.message : String(error), "danger");
    } finally {
      setBulkBusy(false);
    }
  }

  function buildBulkEditOperation(): BulkEditCatalogItemOperation {
    if (bulkEditAction === "assignBlueprint") {
      return { action: bulkEditAction, blueprintId: bulkEditBlueprintId.trim() };
    }

    if (bulkEditAction === "assignCategory" || bulkEditAction === "removeCategory") {
      return { action: bulkEditAction, categoryId: bulkEditCategoryId.trim() };
    }

    if (bulkEditAction === "setTags" || bulkEditAction === "mergeTags") {
      return { action: bulkEditAction, tags: tagsFromInput(bulkEditTags) };
    }

    return { action: "clearTags" };
  }

  async function handlePreviewBulkEdit(selection: unknown) {
    const operation = buildBulkEditOperation();
    setBulkEditBusy(true);
    setBulkEditResult(null);

    try {
      const preview = await previewBulkCatalogItemEdit(operation, selection);
      setBulkEditSelection(selection);
      setBulkEditOperation(operation);
      setBulkEditPreview(preview);
    } catch (error) {
      addToast(error instanceof Error ? error.message : String(error), "danger");
    } finally {
      setBulkEditBusy(false);
    }
  }

  async function handleConfirmBulkEdit() {
    if (!bulkEditSelection || !bulkEditOperation) {
      return;
    }

    setBulkEditBusy(true);
    try {
      const result = await confirmBulkCatalogItemEdit(bulkEditOperation, bulkEditSelection);
      setBulkEditResult(result);
      addToast(t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.completed"), "success");
      setSelectedKeys(new Set());
      revalidator.revalidate();
    } catch (error) {
      addToast(error instanceof Error ? error.message : String(error), "danger");
    } finally {
      setBulkEditBusy(false);
    }
  }

  function resetBulkEditDialog() {
    setBulkEditSelection(null);
    setBulkEditOperation(null);
    setBulkEditPreview(null);
    setBulkEditResult(null);
  }

  return (
    <>
      <EntityListPage
        title={t("catalog.features.catalogItems.ui.catalogItemListPage.catalog.items")}
        entityName={t("catalog.features.catalogItems.ui.catalogItemListPage.catalog.item")}
        items={data.items}
        total={data.total}
        loading={listControls.loading}
        error={null}
        columns={columns}
        getRowId={(row) => row.catalog_item_id}
        getHref={(row) => `/catalog-items/${row.catalog_item_id}`}
        search={listControls.search}
        onSearchChange={listControls.setSearch}
        statusFilter={listControls.status}
        onStatusFilterChange={listControls.setStatus}
        statusOptions={statusOptions}
        extraFilters={
          <>
            <Select
              label={t("catalog.features.catalogItems.ui.catalogItemListPage.language")}
              value={listControls.language || ALL_LANGUAGES}
              onValueChange={(value) => listControls.setLanguage(value === ALL_LANGUAGES ? "" : value)}
              items={[
                { label: t("catalog.features.catalogItems.ui.catalogItemListPage.all.languages"), value: ALL_LANGUAGES },
                ...languageOptions,
              ]}
            />
            <TextInput
              label={t("catalog.features.catalogItems.ui.catalogItemListPage.source")}
              value={listControls.source}
              onChange={(event) => listControls.setSource(event.target.value)}
              placeholder={t("catalog.features.catalogItems.ui.catalogItemListPage.source.placeholder")}
            />
            <TextInput
              label={t("catalog.features.catalogItems.ui.catalogItemListPage.blueprint.id")}
              value={listControls.blueprintId}
              onChange={(event) => listControls.setBlueprintId(event.target.value)}
            />
            <TextInput
              label={t("catalog.features.catalogItems.ui.catalogItemListPage.tag")}
              value={listControls.tag}
              onChange={(event) => listControls.setTag(event.target.value)}
            />
            <Select
              label={t("catalog.features.catalogItems.ui.catalogItemListPage.blueprint")}
              value={listControls.blueprintState || ALL_FILTER_VALUES}
              onValueChange={(value) => listControls.setBlueprintState(value === ALL_FILTER_VALUES ? "" : value)}
              items={blueprintStateOptions}
            />
            <Select
              label={t("catalog.features.catalogItems.ui.catalogItemListPage.has.images")}
              value={listControls.hasImages || ALL_FILTER_VALUES}
              onValueChange={(value) => listControls.setHasImages(value === ALL_FILTER_VALUES ? "" : value)}
              items={booleanOptions}
            />
            <Select
              label={t("catalog.features.catalogItems.ui.catalogItemListPage.has.source.references")}
              value={listControls.hasSourceReferences || ALL_FILTER_VALUES}
              onValueChange={(value) => listControls.setHasSourceReferences(value === ALL_FILTER_VALUES ? "" : value)}
              items={booleanOptions}
            />
            <Select
              label={t("catalog.features.catalogItems.ui.catalogItemListPage.missing.required.fields")}
              value={listControls.missingRequiredFields || ALL_FILTER_VALUES}
              onValueChange={(value) => listControls.setMissingRequiredFields(value === ALL_FILTER_VALUES ? "" : value)}
              items={booleanOptions}
            />
          </>
        }
        selectedKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
        bulkActionBar={
          <BulkLifecycleActionBar
            entityName="Catalog Items"
            selectedKeys={selectedKeys}
            filterSelection={data.total > 0 ? { mode: "filter", query } : undefined}
            filterCount={data.total}
            actions={lifecycleActions}
            clearSelection={() => setSelectedKeys(new Set())}
            preview={previewBulkCatalogItemLifecycle}
            confirm={confirmBulkCatalogItemLifecycle}
            onCompleted={revalidator.revalidate}
            extraActions={
              selectedKeys.size > 0 || data.total > 0 ? (
                <>
                  {selectedKeys.size > 0 && (
                    <Button size="sm" onClick={handlePreviewSelected} loading={bulkBusy} disabled={bulkBusy}>
                      {t("catalog.features.catalogItems.ui.catalogItemListPage.preview.publish")}
                    </Button>
                  )}
                  <Select
                    label={t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.action")}
                    value={bulkEditAction}
                    onValueChange={(value) => setBulkEditAction(value as BulkEditCatalogItemOperation["action"])}
                    items={bulkEditActions}
                  />
                  {bulkEditAction === "assignBlueprint" && (
                    <TextInput
                      label={t("catalog.features.catalogItems.ui.catalogItemListPage.blueprint.id")}
                      value={bulkEditBlueprintId}
                      onChange={(event) => setBulkEditBlueprintId(event.target.value)}
                    />
                  )}
                  {(bulkEditAction === "assignCategory" || bulkEditAction === "removeCategory") && (
                    <TextInput
                      label={t("catalog.features.catalogItems.ui.catalogItemListPage.category.id")}
                      value={bulkEditCategoryId}
                      onChange={(event) => setBulkEditCategoryId(event.target.value)}
                    />
                  )}
                  {(bulkEditAction === "setTags" || bulkEditAction === "mergeTags") && (
                    <TextInput
                      label={t("catalog.features.catalogItems.ui.catalogItemListPage.tags")}
                      value={bulkEditTags}
                      onChange={(event) => setBulkEditTags(event.target.value)}
                      placeholder={t("catalog.features.catalogItems.ui.catalogItemListPage.tags.placeholder")}
                    />
                  )}
                  <Button
                    size="sm"
                    onClick={() => handlePreviewBulkEdit({ mode: "ids", ids: [...selectedKeys] })}
                    loading={bulkEditBusy}
                    disabled={selectedKeys.size === 0 || !canPreviewBulkEdit}
                  >
                    {t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.preview")}
                  </Button>
                  <Button
                    size="sm"
                    tone="secondary"
                    onClick={() => handlePreviewBulkEdit({ mode: "filter", query })}
                    loading={bulkEditBusy}
                    disabled={data.total === 0 || !canPreviewBulkEdit}
                  >
                    {t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.preview.matching")}
                  </Button>
                </>
              ) : null
            }
          />
        }
        page={listControls.page}
        pageSize={listControls.pageSize}
        onPageChange={listControls.setPage}
        createButton={
          <Inline gap={2}>
            {listControls.status === "draft" && (
              <Button tone="secondary" onClick={handlePreviewFilteredDrafts} disabled={bulkBusy}>
                {t("catalog.features.catalogItems.ui.catalogItemListPage.preview.filtered.drafts")}</Button>
            )}
            <Button onClick={() => setShowCreate(true)}>{t("catalog.features.catalogItems.ui.catalogItemListPage.new.catalog.item")}</Button>
          </Inline>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title={t("catalog.features.catalogItems.ui.catalogItemListPage.create.catalog.item")}
        footer={<Button onClick={handleCreate}>{t("catalog.features.catalogItems.ui.catalogItemListPage.create")}</Button>}
      >
        <Stack gap={3}>
          <TextInput label={t("catalog.features.catalogItems.ui.catalogItemListPage.title.2")} value={title} onChange={(e) => setTitle(e.target.value)} />
          <TextInput label={t("catalog.features.catalogItems.ui.catalogItemListPage.subtitle.optional")} value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
          <TextInput label={t("catalog.features.catalogItems.ui.catalogItemListPage.language.code")} value={languageCode} onChange={(e) => setLanguageCode(e.target.value)} />
          <TextInput label={t("catalog.features.catalogItems.ui.catalogItemListPage.description")} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Stack>
      </Dialog>
      <Dialog
        open={bulkPreview !== null}
        onOpenChange={(open) => {
          if (!open) {
            setBulkPreview(null);
            setBulkResult(null);
            setBulkScopeLabel("");
          }
        }}
        title={bulkResult ? t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.publish.result") : t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.publish.preview")}
        description={
          bulkResult
            ? t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.result.description", {
                published: bulkResult.published_count,
                failed: bulkResult.failed_count,
                skipped: bulkResult.skipped_count,
              })
            : bulkPreview
              ? t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.preview.description", {
                  scope: bulkScopeLabel,
                  ready: bulkPreview.ready_count,
                  blocked: bulkPreview.blocked_count,
                })
              : undefined
        }
        footer={
          bulkResult ? (
            <Button onClick={() => {
              setBulkPreview(null);
              setBulkResult(null);
              setBulkScopeLabel("");
            }}>{t("catalog.features.catalogItems.ui.catalogItemListPage.close")}</Button>
          ) : (
            <Inline gap={2}>
              <Button
                onClick={handleConfirmBulkPublish}
                disabled={bulkBusy || !bulkPreview || bulkPreview.ready_count === 0}
              >
                {t("catalog.features.catalogItems.ui.catalogItemListPage.publish.ready.items")}</Button>
              <Button
                tone="secondary"
                onClick={() => {
                  setBulkPreview(null);
                  setBulkScopeLabel("");
                }}
              >
                {t("catalog.features.catalogItems.ui.catalogItemListPage.cancel")}</Button>
            </Inline>
          )
        }
      >
        <Stack gap={3}>
          {bulkPreview && (
            <Text tone="secondary">
              {t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.partial.success.note")}
            </Text>
          )}
          <DataTable
            rows={bulkRows}
            columns={bulkColumns}
            getRowId={(row) => row.catalog_item_id}
            emptyTitle={t("catalog.features.catalogItems.ui.catalogItemListPage.no.items.to.publish")}
            density="compact"
          />
          {(bulkResult?.candidates.length ?? bulkPreview?.candidates.length ?? 0) > bulkRows.length && (
            <Text tone="secondary">
              {t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.preview.truncated", {
                shown: bulkRows.length,
                total: bulkResult?.candidates.length ?? bulkPreview?.candidates.length ?? 0,
              })}
            </Text>
          )}
        </Stack>
      </Dialog>
      <Dialog
        open={bulkEditPreview !== null}
        onOpenChange={(open) => {
          if (!open) {
            resetBulkEditDialog();
          }
        }}
        title={
          bulkEditResult
            ? t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.result.title", { action: bulkEditActionLabel })
            : t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.preview.title", { action: bulkEditActionLabel })
        }
        description={
          bulkEditResult
            ? t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.result.description", {
                succeeded: bulkEditResult.succeeded_count,
                skipped: bulkEditResult.skipped_count,
                failed: bulkEditResult.failed_count,
              })
            : bulkEditPreview
              ? t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.preview.description", {
                  ready: bulkEditPreview.ready_count,
                  blocked: bulkEditPreview.blocked_count,
                })
              : undefined
        }
        footer={
          bulkEditResult ? (
            <Button onClick={resetBulkEditDialog}>
              {t("catalog.features.catalogItems.ui.catalogItemListPage.close")}
            </Button>
          ) : (
            <Inline gap={2}>
              <Button
                onClick={handleConfirmBulkEdit}
                loading={bulkEditBusy}
                disabled={!bulkEditPreview || bulkEditPreview.ready_count === 0}
              >
                {t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.confirm")}
              </Button>
              <Button tone="secondary" onClick={resetBulkEditDialog} disabled={bulkEditBusy}>
                {t("catalog.features.catalogItems.ui.catalogItemListPage.cancel")}
              </Button>
            </Inline>
          )
        }
      >
        <Stack gap={3}>
          <Text tone="secondary">
            {t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.partial.success.note")}
          </Text>
          <DataTable
            rows={bulkEditRows}
            columns={bulkEditColumns}
            getRowId={(row) => row.catalog_item_id}
            emptyTitle={t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.edit.no.items")}
            density="compact"
          />
          {(bulkEditResult?.candidates.length ?? bulkEditPreview?.candidates.length ?? 0) > bulkEditRows.length && (
            <Text tone="secondary">
              {t("catalog.features.catalogItems.ui.catalogItemListPage.bulk.preview.truncated", {
                shown: bulkEditRows.length,
                total: bulkEditResult?.candidates.length ?? bulkEditPreview?.candidates.length ?? 0,
              })}
            </Text>
          )}
        </Stack>
      </Dialog>
    </>
  );
}

function tagsFromInput(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}
