import { useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  Select,
  Stack,
  StatusPill,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../toasts";
import { EntityListPage } from "../../shared/entity-list-page";
import { useFieldList, createField } from "./use-fields";
import type { Field } from "../../api/types";

const columns: DataColumn<Field>[] = [
  { key: "key", header: "Key", cell: (row) => row.key },
  { key: "name", header: "Name", cell: (row) => row.name },
  { key: "value_type", header: "Type", cell: (row) => row.value_type },
  { key: "status", header: "Status", cell: (row) => <StatusPill>{row.status}</StatusPill> },
];

const valueTypeOptions = [
  { value: "string", label: "String" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Boolean" },
  { value: "date", label: "Date" },
];

export function FieldListPage() {
  const { data, loading, error, refresh } = useFieldList();
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [valueType, setValueType] = useState("string");
  const [filterable, setFilterable] = useState(false);
  const [searchable, setSearchable] = useState(false);
  const [sortable, setSortable] = useState(false);

  async function handleCreate() {
    const fieldId = crypto.randomUUID();
    await createField({ fieldId, key, name, valueType, behavior: { filterable, searchable, sortable } });
    addToast("Field created", "success");
    setShowCreate(false);
    setKey("");
    setName("");
    setValueType("string");
    setFilterable(false);
    setSearchable(false);
    setSortable(false);
    refresh();
  }

  return (
    <>
      <EntityListPage
        title="Fields"
        entityName="field"
        items={data?.items ?? null}
        loading={loading}
        error={error}
        columns={columns}
        getRowId={(row) => row.field_id}
        getHref={(row) => `#/fields/${row.field_id}`}
        createButton={
          <Button onClick={() => setShowCreate(true)}>New Field</Button>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title="Create Field"
        footer={<Button onClick={handleCreate}>Create</Button>}
      >
        <Stack gap={3}>
          <TextInput label="Key" value={key} onChange={(e) => setKey(e.target.value)} />
          <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Select label="Value Type" items={valueTypeOptions} value={valueType} onValueChange={setValueType} />
          <Checkbox label="Filterable" checked={filterable} onCheckedChange={(v) => setFilterable(v === true)} />
          <Checkbox label="Searchable" checked={searchable} onCheckedChange={(v) => setSearchable(v === true)} />
          <Checkbox label="Sortable" checked={sortable} onCheckedChange={(v) => setSortable(v === true)} />
        </Stack>
      </Dialog>
    </>
  );
}
