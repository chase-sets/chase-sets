import { useState } from "react";
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
import type { Category } from "../../api/types";

const columns: DataColumn<Category>[] = [
  { key: "key", header: "Key", cell: (row) => row.key },
  { key: "name", header: "Name", cell: (row) => row.name },
  { key: "parent", header: "Parent", cell: (row) => row.parent_category_id ?? "—" },
  { key: "order", header: "Order", align: "right", cell: (row) => row.display_order },
  { key: "status", header: "Status", cell: (row) => <StatusPill>{row.status}</StatusPill> },
];

export function CategoryListPage() {
  const { data, loading, error, refresh } = useCategoryList();
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [displayOrder, setDisplayOrder] = useState("0");

  async function handleCreate() {
    const categoryId = crypto.randomUUID();
    await createCategory({
      categoryId,
      key,
      name,
      parentCategoryId: parentId || undefined,
      displayOrder: Number(displayOrder) || 0,
    });
    addToast("Category created", "success");
    setShowCreate(false);
    setKey("");
    setName("");
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
        loading={loading}
        error={error}
        columns={columns}
        getRowId={(row) => row.category_id}
        getHref={(row) => `#/categories/${row.category_id}`}
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
          <TextInput label="Parent Category ID (optional)" value={parentId} onChange={(e) => setParentId(e.target.value)} />
          <TextInput label="Display Order" value={displayOrder} onChange={(e) => setDisplayOrder(e.target.value)} />
        </Stack>
      </Dialog>
    </>
  );
}
