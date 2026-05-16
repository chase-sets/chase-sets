import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { useState, useMemo } from "react";
import { useRevalidator } from "react-router";
import {
  BulkActionBar,
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
import {
  type CatalogListRouteData,
  useCatalogListQueryControls,
} from "../../../support/shell-support/list-query-state";
import {
  confirmBulkPublishCatalogItems,
  createCatalogItem,
  localizedTextMapFromEnglish,
  previewBulkPublishCatalogItems,
} from "./use-catalog-items";
import type { BulkPublishCandidate, BulkPublishPreview, BulkPublishResult, CatalogItemListItem } from "./contracts";

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

const statusOptions = [
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.draft"), value: "draft" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.active"), value: "active" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.retired"), value: "retired" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.archived"), value: "archived" },
];

const ALL_LANGUAGES = "__all__";

const languageOptions = [
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.english"), value: "en" },
  { label: t("catalog.features.catalogItems.ui.catalogItemListPage.japanese"), value: "ja" },
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
          </>
        }
        selectedKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
        bulkActionBar={
          selectedKeys.size > 0 ? (
            <BulkActionBar
              count={selectedKeys.size}
              formatSelectedLabel={(count) => t("catalog.features.catalogItems.ui.catalogItemListPage.items.selected", { count })}
              actions={
                <Inline gap={2}>
                  <Button size="sm" onClick={handlePreviewSelected} disabled={bulkBusy}>
                    {t("catalog.features.catalogItems.ui.catalogItemListPage.preview.publish")}</Button>
                  <Button size="sm" tone="secondary" onClick={() => setSelectedKeys(new Set())}>
                    {t("catalog.features.catalogItems.ui.catalogItemListPage.clear.selection")}</Button>
                </Inline>
              }
            />
          ) : null
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
    </>
  );
}
