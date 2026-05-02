import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
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
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityListPage } from "../../../support/shell-support/ui/entity-list-page";
import { useFieldList, createField } from "./use-fields";
import type { Field } from "./contracts";

const columns: DataColumn<Field>[] = [
  { key: "key", header: t("catalog.features.fields.ui.fieldListPage.key"), cell: (row) => row.key },
  { key: "name", header: t("catalog.features.fields.ui.fieldListPage.name"), cell: (row) => row.name },
  { key: "value_type", header: t("catalog.features.fields.ui.fieldListPage.type"), cell: (row) => row.value_type },
  { key: "status", header: t("catalog.features.fields.ui.fieldListPage.status"), cell: (row) => <StatusPill>{row.status}</StatusPill> },
];

const valueTypeOptions = [
  { value: "string", label: t("catalog.features.fields.ui.fieldListPage.string") },
  { value: "number", label: t("catalog.features.fields.ui.fieldListPage.number") },
  { value: "boolean", label: t("catalog.features.fields.ui.fieldListPage.boolean") },
  { value: "date", label: t("catalog.features.fields.ui.fieldListPage.date") },
];

const statusOptions = [
  { label: t("catalog.features.fields.ui.fieldListPage.draft"), value: "draft" },
  { label: t("catalog.features.fields.ui.fieldListPage.active"), value: "active" },
  { label: t("catalog.features.fields.ui.fieldListPage.deprecated"), value: "deprecated" },
  { label: t("catalog.features.fields.ui.fieldListPage.archived"), value: "archived" },
];

export function FieldListPage({ initialData }: { initialData?: Parameters<typeof useFieldList>[1] }) {
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

  const { data, loading, error, refresh } = useFieldList(query, initialData);
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
    addToast(t("catalog.features.fields.ui.fieldListPage.field.created"), "success");
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
        title={t("catalog.features.fields.ui.fieldListPage.fields")}
        entityName="field"
        items={data?.items ?? null}
        total={data?.total}
        loading={loading}
        error={error}
        columns={columns}
        getRowId={(row) => row.field_id}
        getHref={(row) => `/fields/${row.field_id}`}
        search={search}
        onSearchChange={(v) => { setSearch(v); setPage(0); }}
        statusFilter={statusFilter}
        onStatusFilterChange={(v) => { setStatusFilter(v); setPage(0); }}
        statusOptions={statusOptions}
        page={page}
        pageSize={50}
        onPageChange={setPage}
        createButton={
          <Button onClick={() => setShowCreate(true)}>{t("catalog.features.fields.ui.fieldListPage.new.field")}</Button>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title={t("catalog.features.fields.ui.fieldListPage.create.field")}
        footer={<Button onClick={handleCreate}>{t("catalog.features.fields.ui.fieldListPage.create")}</Button>}
      >
        <Stack gap={3}>
          <TextInput label={t("catalog.features.fields.ui.fieldListPage.key.2")} value={key} onChange={(e) => setKey(e.target.value)} />
          <TextInput label={t("catalog.features.fields.ui.fieldListPage.name.2")} value={name} onChange={(e) => setName(e.target.value)} />
          <TextInput label={t("catalog.features.fields.ui.fieldListPage.description")} value={description} onChange={(e) => setDescription(e.target.value)} />
          <Select label={t("catalog.features.fields.ui.fieldListPage.value.type")} items={valueTypeOptions} value={valueType} onValueChange={setValueType} />
          <Checkbox label={t("catalog.features.fields.ui.fieldListPage.filterable")} checked={filterable} onCheckedChange={(v) => setFilterable(v === true)} />
          <Checkbox label={t("catalog.features.fields.ui.fieldListPage.searchable")} checked={searchable} onCheckedChange={(v) => setSearchable(v === true)} />
          <Checkbox label={t("catalog.features.fields.ui.fieldListPage.sortable")} checked={sortable} onCheckedChange={(v) => setSortable(v === true)} />
        </Stack>
      </Dialog>
    </>
  );
}





