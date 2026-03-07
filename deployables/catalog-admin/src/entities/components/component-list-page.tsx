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
import { useComponentList, createComponent } from "./use-components";
import type { Component } from "../../api/types";

const columns: DataColumn<Component>[] = [
  { key: "key", header: "Key", cell: (row) => row.key },
  { key: "name", header: "Name", cell: (row) => row.name },
  { key: "status", header: "Status", cell: (row) => <StatusPill>{row.status}</StatusPill> },
];

export function ComponentListPage() {
  const { data, loading, error, refresh } = useComponentList();
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");

  async function handleCreate() {
    const componentId = crypto.randomUUID();
    await createComponent({ componentId, key, name });
    addToast("Component created", "success");
    setShowCreate(false);
    setKey("");
    setName("");
    refresh();
  }

  return (
    <>
      <EntityListPage
        title="Components"
        entityName="component"
        items={data?.items ?? null}
        loading={loading}
        error={error}
        columns={columns}
        getRowId={(row) => row.component_id}
        getHref={(row) => `#/components/${row.component_id}`}
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
        </Stack>
      </Dialog>
    </>
  );
}
