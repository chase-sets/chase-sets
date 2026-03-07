import { useState } from "react";
import {
  Button,
  Dialog,
  Stack,
  StatusPill,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { navigate } from "../../router";
import { useToasts } from "../../toasts";
import { EntityListPage } from "../../shared/entity-list-page";
import { useDimensionList, createDimension } from "./use-dimensions";
import type { Dimension } from "../../api/types";

const columns: DataColumn<Dimension>[] = [
  { key: "key", header: "Key", cell: (row) => row.key },
  { key: "name", header: "Name", cell: (row) => row.name },
  { key: "status", header: "Status", cell: (row) => <StatusPill>{row.status}</StatusPill> },
];

export function DimensionListPage() {
  const { data, loading, error, refresh } = useDimensionList();
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");

  async function handleCreate() {
    const dimensionId = crypto.randomUUID();
    await createDimension({ dimensionId, key, name });
    addToast("Dimension created", "success");
    setShowCreate(false);
    setKey("");
    setName("");
    refresh();
  }

  return (
    <>
      <EntityListPage
        title="Dimensions"
        entityName="dimension"
        items={data?.items ?? null}
        loading={loading}
        error={error}
        columns={columns}
        getRowId={(row) => row.dimension_id}
        getHref={(row) => `#/dimensions/${row.dimension_id}`}
        createButton={
          <Button onClick={() => setShowCreate(true)}>New Dimension</Button>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title="Create Dimension"
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
