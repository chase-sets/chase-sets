import { createId } from "../../../../../contracts/primitives/typed-ids";
import { useState, useMemo } from "react";
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
import { useToasts } from "../../shared/ui/toasts";
import { EntityListPage } from "../../shared/ui/entity-list-page";
import { useFieldList, createField } from "./use-fields";
import type { Field } from "../../shared/ui/api/types";

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

const statusOptions = [
  { label: "Draft", value: "draft" },
  { label: "Active", value: "active" },
  { label: "Deprecated", value: "deprecated" },
  { label: "Archived", value: "archived" },
];

export function FieldListPage() {
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

  const { data, loading, error, refresh } = useFieldList(query);
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [valueType, setValueType] = useState("string");
  const [filterable, setFilterable] = useState(false);
  const [searchable, setSearchable] = useState(false);
  const [sortable, setSortable] = useState(false);

  async function handleCreate() {
    const fieldId = createId("fld");
    await createField({ fieldId, key, name, description: description || undefined, valueType, behavior: { filterable, searchable, sortable } });
    addToast("Field created", "success");
    setShowCreate(false);
    setKey("");
    setName("");
    setDescription("");
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
        total={data?.total}
        loading={loading}
        error={error}
        columns={columns}
        getRowId={(row) => row.field_id}
        getHref={(row) => `#/fields/${row.field_id}`}
        search={search}
        onSearchChange={(v) => { setSearch(v); setPage(0); }}
        statusFilter={statusFilter}
        onStatusFilterChange={(v) => { setStatusFilter(v); setPage(0); }}
        statusOptions={statusOptions}
        page={page}
        pageSize={50}
        onPageChange={setPage}
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
          <TextInput label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
          <Select label="Value Type" items={valueTypeOptions} value={valueType} onValueChange={setValueType} />
          <Checkbox label="Filterable" checked={filterable} onCheckedChange={(v) => setFilterable(v === true)} />
          <Checkbox label="Searchable" checked={searchable} onCheckedChange={(v) => setSearchable(v === true)} />
          <Checkbox label="Sortable" checked={sortable} onCheckedChange={(v) => setSortable(v === true)} />
        </Stack>
      </Dialog>
    </>
  );
}

