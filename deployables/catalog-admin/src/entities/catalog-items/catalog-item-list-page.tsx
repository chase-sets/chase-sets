import { useState } from "react";
import {
  Button,
  Dialog,
  Stack,
  StatusPill,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../toasts";
import { EntityListPage } from "../../shared/entity-list-page";
import { useCatalogItemList, createCatalogItem } from "./use-catalog-items";
import type { CatalogItem } from "../../api/types";

const columns: DataColumn<CatalogItem>[] = [
  { key: "title", header: "Title", cell: (row) => row.title },
  { key: "subtitle", header: "Subtitle", cell: (row) => row.subtitle ?? "—" },
  { key: "blueprint", header: "Blueprint", cell: (row) => row.blueprint_id ?? "—" },
  { key: "status", header: "Status", cell: (row) => <StatusPill>{row.status}</StatusPill> },
];

export function CatalogItemListPage() {
  const { data, loading, error, refresh } = useCatalogItemList();
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");

  async function handleCreate() {
    const itemId = crypto.randomUUID();
    await createCatalogItem({ itemId, title, subtitle: subtitle || undefined });
    addToast("Catalog item created", "success");
    setShowCreate(false);
    setTitle("");
    setSubtitle("");
    refresh();
  }

  return (
    <>
      <EntityListPage
        title="Catalog Items"
        entityName="catalog item"
        items={data?.items ?? null}
        loading={loading}
        error={error}
        columns={columns}
        getRowId={(row) => row.item_id}
        getHref={(row) => `#/catalog-items/${row.item_id}`}
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
        </Stack>
      </Dialog>
    </>
  );
}
