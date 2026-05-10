import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { useState, useMemo } from "react";
import { useRevalidator } from "react-router";
import {
  Button,
  Dialog,
  Select,
  Stack,
  StatusPill,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityListPage } from "../../../support/shell-support/ui/entity-list-page";
import {
  type CatalogListRouteData,
  useCatalogListQueryControls,
} from "../../../support/shell-support/list-query-state";
import { createCatalogItem, localizedTextMapFromEnglish } from "./use-catalog-items";
import type { CatalogItemListItem } from "./contracts";

function buildColumns(): DataColumn<CatalogItemListItem>[] {
  return [
    { key: "title", header: t("catalog.features.catalogItems.ui.catalogItemListPage.title"), cell: (row) => row.title },
    { key: "subtitle", header: t("catalog.features.catalogItems.ui.catalogItemListPage.subtitle"), cell: (row) => row.subtitle ?? "—" },
    { key: "language", header: t("catalog.features.catalogItems.ui.catalogItemListPage.language"), cell: (row) => row.language_code },
    { key: "blueprint", header: t("catalog.features.catalogItems.ui.catalogItemListPage.blueprint"), cell: (row) => row.blueprint?.name ?? "—" },
    { key: "status", header: t("catalog.features.catalogItems.ui.catalogItemListPage.status"), cell: (row) => <StatusPill>{row.status}</StatusPill> },
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
          <Select
            label={t("catalog.features.catalogItems.ui.catalogItemListPage.language")}
            value={listControls.language || ALL_LANGUAGES}
            onValueChange={(value) => listControls.setLanguage(value === ALL_LANGUAGES ? "" : value)}
            items={[
              { label: t("catalog.features.catalogItems.ui.catalogItemListPage.all.languages"), value: ALL_LANGUAGES },
              ...languageOptions,
            ]}
          />
        }
        page={listControls.page}
        pageSize={listControls.pageSize}
        onPageChange={listControls.setPage}
        createButton={
          <Button onClick={() => setShowCreate(true)}>{t("catalog.features.catalogItems.ui.catalogItemListPage.new.catalog.item")}</Button>
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
    </>
  );
}
