import { createId } from "../../../../../../contracts/primitives/typed-ids";
import { useState, useMemo } from "react";
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
import { useComponentList, createComponent } from "./use-components";
import type { Component } from "../../api/types";

const columns: DataColumn<Component>[] = [
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

export function ComponentListPage() {
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

  const { data, loading, error, refresh } = useComponentList(query);
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  async function handleCreate() {
    const componentId = createId("cmp");
    await createComponent({ componentId, key, name, description: description || undefined });
    addToast("Component created", "success");
    setShowCreate(false);
    setKey("");
    setName("");
    setDescription("");
    refresh();
  }

  return (
    <>
      <EntityListPage
        title="Components"
        entityName="component"
        items={data?.items ?? null}
        total={data?.total}
        loading={loading}
        error={error}
        columns={columns}
        getRowId={(row) => row.component_id}
        getHref={(row) => `#/components/${row.component_id}`}
        search={search}
        onSearchChange={(v) => { setSearch(v); setPage(0); }}
        statusFilter={statusFilter}
        onStatusFilterChange={(v) => { setStatusFilter(v); setPage(0); }}
        statusOptions={statusOptions}
        page={page}
        pageSize={50}
        onPageChange={setPage}
        createButton={
          <Button onClick={() => setShowCreate(true)}>New Component</Button>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title="Create Component"
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
