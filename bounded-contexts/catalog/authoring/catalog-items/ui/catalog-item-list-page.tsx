import { createId } from "../../../../../contracts/primitives/typed-ids";
import { useState, useMemo } from "react";
import {
  Button,
  Dialog,
  Stack,
  StatusPill,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../shared/ui/toasts";
import { EntityListPage } from "../../shared/ui/entity-list-page";
import { useCatalogItemList, createCatalogItem } from "./use-catalog-items";
import type { CatalogItemListItem } from "../../shared/ui/api/types";

function buildColumns(): DataColumn<CatalogItemListItem>[] {
  return [
    { key: "title", header: "Title", cell: (row) => row.title },
    { key: "subtitle", header: "Subtitle", cell: (row) => row.subtitle ?? "—" },
    { key: "blueprint", header: "Blueprint", cell: (row) => row.blueprint?.name ?? "—" },
    { key: "status", header: "Status", cell: (row) => <StatusPill>{row.status}</StatusPill> },
  ];
}

const statusOptions = [
  { label: "Draft", value: "draft" },
  { label: "Active", value: "active" },
  { label: "Retired", value: "retired" },
  { label: "Archived", value: "archived" },
];

export function CatalogItemListPage() {
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

  const { data, loading, error, refresh } = useCatalogItemList(query);
  const columns = useMemo(() => buildColumns(), []);
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [description, setDescription] = useState("");

  async function handleCreate() {
    const itemId = createId("cat");
    await createCatalogItem({ itemId, title, subtitle: subtitle || undefined, description: description || undefined });
    addToast("Catalog item created", "success");
    setShowCreate(false);
    setTitle("");
    setSubtitle("");
    setDescription("");
    refresh();
  }

  return (
    <>
      <EntityListPage
        title="Catalog Items"
        entityName="catalog item"
        items={data?.items ?? null}
        total={data?.total}
        loading={loading}
        error={error}
        columns={columns}
        getRowId={(row) => row.item_id}
        getHref={(row) => `#/catalog-items/${row.item_id}`}
        search={search}
        onSearchChange={(v) => { setSearch(v); setPage(0); }}
        statusFilter={statusFilter}
        onStatusFilterChange={(v) => { setStatusFilter(v); setPage(0); }}
        statusOptions={statusOptions}
        page={page}
        pageSize={50}
        onPageChange={setPage}
        createButton={
          <Button onClick={() => setShowCreate(true)}>New Catalog Item</Button>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title="Create Catalog Item"
        footer={<Button onClick={handleCreate}>Create</Button>}
      >
        <Stack gap={3}>
          <TextInput label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <TextInput label="Subtitle (optional)" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
          <TextInput label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Stack>
      </Dialog>
    </>
  );
}

