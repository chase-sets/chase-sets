import { localizedTextMapFromEnglish, t } from "@chase-sets/localization";
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
import { BulkLifecycleActionBar } from "../../../support/shell-support/ui/bulk-lifecycle-actions";
import {
  type CatalogListRouteData,
  useCatalogListQueryControls,
} from "../../../support/shell-support/list-query-state";
import { confirmBulkCategoryLifecycle, createCategory, previewBulkCategoryLifecycle } from "./use-categories";
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
const ALL_HIERARCHIES = "__all__";
const hierarchyOptions = [
  { label: t("catalog.support.shellSupport.ui.entityListPage.all"), value: ALL_HIERARCHIES },
  { label: t("catalog.features.categories.ui.categoryListPage.root.categories"), value: "root" },
  { label: t("catalog.features.categories.ui.categoryListPage.child.categories"), value: "child" },
];
const lifecycleActions = [
  { value: "publish", label: t("catalog.features.categories.ui.categoryDetailPage.publish") },
  { value: "deprecate", label: t("catalog.features.categories.ui.categoryDetailPage.deprecate") },
  { value: "archive", label: t("catalog.features.categories.ui.categoryDetailPage.archive") },
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
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  async function handleCreate() {
    const categoryId = createId("ctg");
    await createCategory({
      categoryId,
      key,
      name: localizedTextMapFromEnglish(name),
      description: localizedTextMapFromEnglish(description),
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
        extraFilters={
          <>
            <Select
              label={t("catalog.features.categories.ui.categoryListPage.hierarchy")}
              value={listControls.hierarchy || ALL_HIERARCHIES}
              onValueChange={(value) => listControls.setHierarchy(value === ALL_HIERARCHIES ? "" : value)}
              items={hierarchyOptions}
            />
            <TextInput
              label={t("catalog.features.categories.ui.categoryListPage.parent.category.id.optional")}
              value={listControls.parentCategoryId}
              onChange={(event) => listControls.setParentCategoryId(event.target.value)}
            />
          </>
        }
        selectedKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
        bulkActionBar={
          <BulkLifecycleActionBar
            entityName="Categories"
            selectedKeys={selectedKeys}
            filterSelection={{ mode: "filter", query }}
            filterCount={data.total}
            actions={lifecycleActions}
            clearSelection={() => setSelectedKeys(new Set())}
            preview={previewBulkCategoryLifecycle}
            confirm={confirmBulkCategoryLifecycle}
            onCompleted={revalidator.revalidate}
          />
        }
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

