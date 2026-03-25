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
import { useBlueprintList, createBlueprint } from "./use-blueprints";
import type { Blueprint } from "./contracts";

const columns: DataColumn<Blueprint>[] = [
  { key: "key", header: "Key", cell: (row) => row.key },
  { key: "name", header: "Name", cell: (row) => row.name },
  { key: "status", header: "Status", cell: (row) => <StatusPill>{row.status}</StatusPill> },
];

const statusOptions = [
  { label: "Draft", value: "draft" },
  { label: "Active", value: "active" },
  { label: "Deprecated", value: "deprecated" },
  { label: "Archived", value: "archived" },
];

export function BlueprintListPage() {
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

  const { data, loading, error, refresh } = useBlueprintList(query);
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  async function handleCreate() {
    const blueprintId = createId("bpr");
    await createBlueprint({ blueprintId, key, name, description: description || undefined });
    addToast("Blueprint created", "success");
    setShowCreate(false);
    setKey("");
    setName("");
    setDescription("");
    refresh();
  }

  return (
    <>
      <EntityListPage
        title="Blueprints"
        entityName="blueprint"
        items={data?.items ?? null}
        total={data?.total}
        loading={loading}
        error={error}
        columns={columns}
        getRowId={(row) => row.blueprint_id}
        getHref={(row) => `#/blueprints/${row.blueprint_id}`}
        search={search}
        onSearchChange={(v) => { setSearch(v); setPage(0); }}
        statusFilter={statusFilter}
        onStatusFilterChange={(v) => { setStatusFilter(v); setPage(0); }}
        statusOptions={statusOptions}
        page={page}
        pageSize={50}
        onPageChange={setPage}
        createButton={
          <Button onClick={() => setShowCreate(true)}>New Blueprint</Button>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title="Create Blueprint"
        footer={<Button onClick={handleCreate}>Create</Button>}
      >
        <Stack gap={3}>
          <TextInput label="Key" value={key} onChange={(e) => setKey(e.target.value)} />
          <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <TextInput label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Stack>
      </Dialog>
    </>
  );
}


