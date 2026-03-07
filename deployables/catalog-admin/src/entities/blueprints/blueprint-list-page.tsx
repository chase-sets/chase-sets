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
import { useBlueprintList, createBlueprint } from "./use-blueprints";
import type { Blueprint } from "../../api/types";

const columns: DataColumn<Blueprint>[] = [
  { key: "key", header: "Key", cell: (row) => row.key },
  { key: "name", header: "Name", cell: (row) => row.name },
  { key: "status", header: "Status", cell: (row) => <StatusPill>{row.status}</StatusPill> },
];

export function BlueprintListPage() {
  const { data, loading, error, refresh } = useBlueprintList();
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");

  async function handleCreate() {
    const blueprintId = crypto.randomUUID();
    await createBlueprint({ blueprintId, key, name });
    addToast("Blueprint created", "success");
    setShowCreate(false);
    setKey("");
    setName("");
    refresh();
  }

  return (
    <>
      <EntityListPage
        title="Blueprints"
        entityName="blueprint"
        items={data?.items ?? null}
        loading={loading}
        error={error}
        columns={columns}
        getRowId={(row) => row.blueprint_id}
        getHref={(row) => `#/blueprints/${row.blueprint_id}`}
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
        </Stack>
      </Dialog>
    </>
  );
}
