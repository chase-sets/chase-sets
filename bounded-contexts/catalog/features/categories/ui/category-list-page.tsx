import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { useState, useMemo } from "react";
import { useRevalidator } from "react-router";
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
import {
  type CatalogListRouteData,
  useCatalogListQueryControls,
} from "../../../support/shell-support/list-query-state";
import { createCategory } from "./use-categories";
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

export function CategoryListPage({ data, query }: CatalogListRouteData<CategoryListItem>) {
  const listControls = useCatalogListQueryControls(query);
  const revalidator = useRevalidator();
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
    revalidator.revalidate();
  }

  return (
    <>
      <EntityListPage
        title={t("catalog.features.categories.ui.categoryListPage.categories")}
        entityName="category"
        items={data.items}
        total={data.total}
        loading={listControls.loading}
        error={null}
        columns={columns}
        getRowId={(row) => row.category_id}
        getHref={(row) => `/categories/${row.category_id}`}
        search={listControls.search}
        onSearchChange={listControls.setSearch}
        statusFilter={listControls.status}
        onStatusFilterChange={listControls.setStatus}
        statusOptions={statusOptions}
        page={listControls.page}
        pageSize={listControls.pageSize}
        onPageChange={listControls.setPage}
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




