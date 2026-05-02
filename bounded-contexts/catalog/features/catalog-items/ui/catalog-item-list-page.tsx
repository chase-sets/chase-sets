import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { useState, useMemo } from "react";
import {
  Button,
  Dialog,
  Stack,
  StatusPill,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityListPage } from "../../../support/shell-support/ui/entity-list-page";
import { useCatalogItemList, createCatalogItem } from "./use-catalog-items";
import type { CatalogItemListItem } from "./contracts";

function buildColumns(): DataColumn<CatalogItemListItem>[] {
  return [
    { key: "title", header: t("catalog.features.catalogItems.ui.catalogItemListPage.title"), cell: (row) => row.title },
    { key: "subtitle", header: t("catalog.features.catalogItems.ui.catalogItemListPage.subtitle"), cell: (row) => row.subtitle ?? "—" },
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

export function CatalogItemListPage({ initialData }: { initialData?: Parameters<typeof useCatalogItemList>[1] }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(0);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (statusFilter) params.set("status", statusFilter);
    params.set("limit", "50");
    params.set("offset", String(page * 50));
    return params.toString();
  }, [search, statusFilter, page]);

  const { data, loading, error, refresh } = useCatalogItemList(query, initialData);
  const columns = useMemo(() => buildColumns(), []);
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [description, setDescription] = useState("");

  async function handleCreate() {
    const itemId = createId("cat");
    await createCatalogItem({ itemId, title, subtitle: subtitle || undefined, description: description || undefined });
    addToast(t("catalog.features.catalogItems.ui.catalogItemListPage.catalog.item.created"), "success");
    setShowCreate(false);
    setTitle("");
    setSubtitle("");
    setDescription("");
    refresh();
  }

  return (
    <>
      <EntityListPage
        title={t("catalog.features.catalogItems.ui.catalogItemListPage.catalog.items")}
        entityName={t("catalog.features.catalogItems.ui.catalogItemListPage.catalog.item")}
        items={data?.items ?? null}
        total={data?.total}
        loading={loading}
        error={error}
        columns={columns}
        getRowId={(row) => row.catalog_item_id}
        getHref={(row) => `/catalog-items/${row.catalog_item_id}`}
        search={search}
        onSearchChange={(v) => { setSearch(v); setPage(0); }}
        statusFilter={statusFilter}
        onStatusFilterChange={(v) => { setStatusFilter(v); setPage(0); }}
        statusOptions={statusOptions}
        page={page}
        pageSize={50}
        onPageChange={setPage}
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
          <TextInput label={t("catalog.features.catalogItems.ui.catalogItemListPage.description")} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Stack>
      </Dialog>
    </>
  );
}




