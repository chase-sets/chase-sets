import { createId } from "../../../../../../contracts/primitives/typed-ids";
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
import { useToasts } from "../../toasts";
import { EntityListPage } from "../../shared/entity-list-page";
import { useCategoryList, createCategory } from "./use-categories";
import type { CategoryListItem } from "../../api/types";

function buildColumns(): DataColumn<CategoryListItem>[] {
  return [
    { key: "key", header: "Key", cell: (row) => row.key },
    { key: "name", header: "Name", cell: (row) => row.name },
    { key: "parent", header: "Parent", cell: (row) => row.parent_category?.name ?? "—" },
    { key: "order", header: "Order", align: "right", cell: (row) => row.display_order },
    { key: "status", header: "Status", cell: (row) => <StatusPill>{row.status}</StatusPill> },
  ];
}

const statusOptions = [
  { label: "Draft", value: "draft" },
  { label: "Active", value: "active" },
  { label: "Deprecated", value: "deprecated" },
  { label: "Archived", value: "archived" },
];

export function CategoryListPage() {
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

  const { data, loading, error, refresh } = useCategoryList(query);
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
    addToast("Category created", "success");
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
        title="Categories"
        entityName="category"
        items={data?.items ?? null}
        total={data?.total}
        loading={loading}
        error={error}
        columns={columns}
        getRowId={(row) => row.category_id}
        getHref={(row) => `#/categories/${row.category_id}`}
        search={search}
        onSearchChange={(v) => { setSearch(v); setPage(0); }}
        statusFilter={statusFilter}
        onStatusFilterChange={(v) => { setStatusFilter(v); setPage(0); }}
        statusOptions={statusOptions}
        page={page}
        pageSize={50}
        onPageChange={setPage}
        createButton={
          <Button onClick={() => setShowCreate(true)}>New Category</Button>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title="Create Category"
        footer={<Button onClick={handleCreate}>Create</Button>}
      >
        <Stack gap={3}>
          <TextInput label="Key" value={key} onChange={(e) => setKey(e.target.value)} />
          <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <TextInput label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
          <TextInput label="Parent Category ID (optional)" value={parentId} onChange={(e) => setParentId(e.target.value)} />
          <TextInput label="Display Order" value={displayOrder} onChange={(e) => setDisplayOrder(e.target.value)} />
        </Stack>
      </Dialog>
    </>
  );
}
