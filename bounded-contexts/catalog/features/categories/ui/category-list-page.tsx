import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { useState, useMemo } from "react";
import {
  Button,
  Dialog,
  NumberInput,
  Stack,
  StatusPill,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityListPage } from "../../../support/shell-support/ui/entity-list-page";
import { useCategoryList, createCategory } from "./use-categories";
import type { CategoryListItem } from "./contracts";

function buildColumns(): DataColumn<CategoryListItem>[] {
  return [
    { key: "key", header: t("catalog.features.categories.ui.categoryListPage.key"), cell: (row) => row.key },
    { key: "name", header: t("catalog.features.categories.ui.categoryListPage.name"), cell: (row) => row.name },
    { key: "parent", header: t("catalog.features.categories.ui.categoryListPage.parent"), cell: (row) => row.parent_category?.name ?? "—" },
    { key: "order", header: t("catalog.features.categories.ui.categoryListPage.order"), align: "right", cell: (row) => row.display_order },
    { key: "status", header: t("catalog.features.categories.ui.categoryListPage.status"), cell: (row) => <StatusPill>{row.status}</StatusPill> },
  ];
}

const statusOptions = [
  { label: t("catalog.features.categories.ui.categoryListPage.draft"), value: "draft" },
  { label: t("catalog.features.categories.ui.categoryListPage.active"), value: "active" },
  { label: t("catalog.features.categories.ui.categoryListPage.deprecated"), value: "deprecated" },
  { label: t("catalog.features.categories.ui.categoryListPage.archived"), value: "archived" },
];

export function CategoryListPage({ initialData }: { initialData?: Parameters<typeof useCategoryList>[1] }) {
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

  const { data, loading, error, refresh } = useCategoryList(query, initialData);
  const columns = useMemo(() => buildColumns(), []);
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState("");
  const [displayOrder, setDisplayOrder] = useState("0");

  async function handleCreate() {
    const categoryId = createId("ctg");
    await createCategory({
      categoryId,
      key,
      name,
      description: description || undefined,
      parentCategoryId: parentId || undefined,
      displayOrder: Number(displayOrder) || 0,
    });
    addToast(t("catalog.features.categories.ui.categoryListPage.category.created"), "success");
    setShowCreate(false);
    setKey("");
    setName("");
    setDescription("");
    setParentId("");
    setDisplayOrder("0");
    refresh();
  }

  return (
    <>
      <EntityListPage
        title={t("catalog.features.categories.ui.categoryListPage.categories")}
        entityName="category"
        items={data?.items ?? null}
        total={data?.total}
        loading={loading}
        error={error}
        columns={columns}
        getRowId={(row) => row.category_id}
        getHref={(row) => `/categories/${row.category_id}`}
        search={search}
        onSearchChange={(v) => { setSearch(v); setPage(0); }}
        statusFilter={statusFilter}
        onStatusFilterChange={(v) => { setStatusFilter(v); setPage(0); }}
        statusOptions={statusOptions}
        page={page}
        pageSize={50}
        onPageChange={setPage}
        createButton={
          <Button onClick={() => setShowCreate(true)}>{t("catalog.features.categories.ui.categoryListPage.new.category")}</Button>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title={t("catalog.features.categories.ui.categoryListPage.create.category")}
        footer={<Button onClick={handleCreate}>{t("catalog.features.categories.ui.categoryListPage.create")}</Button>}
      >
        <Stack gap={3}>
          <TextInput label={t("catalog.features.categories.ui.categoryListPage.key.2")} value={key} onChange={(e) => setKey(e.target.value)} />
          <TextInput label={t("catalog.features.categories.ui.categoryListPage.name.2")} value={name} onChange={(e) => setName(e.target.value)} />
          <TextInput label={t("catalog.features.categories.ui.categoryListPage.description")} value={description} onChange={(e) => setDescription(e.target.value)} />
          <TextInput label={t("catalog.features.categories.ui.categoryListPage.parent.category.id.optional")} value={parentId} onChange={(e) => setParentId(e.target.value)} />
          <TextInput label={t("catalog.features.categories.ui.categoryListPage.display.order")} value={displayOrder} onChange={(e) => setDisplayOrder(e.target.value)} />
        </Stack>
      </Dialog>
    </>
  );
}





