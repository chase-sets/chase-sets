import { localizedTextMapFromEnglish, t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { useState } from "react";
import { useRevalidator } from "react-router";
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
import { BulkLifecycleActionBar } from "../../../support/shell-support/ui/bulk-lifecycle-actions";
import {
  type CatalogListRouteData,
  useCatalogListQueryControls,
} from "../../../support/shell-support/list-query-state";
import { confirmBulkFieldLifecycle, createField, previewBulkFieldLifecycle } from "./use-fields";
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
  { value: "json", label: t("catalog.features.fields.ui.fieldListPage.json") },
  { value: "localized_text", label: t("catalog.features.fields.ui.fieldListPage.localized.text") },
  { value: "reference", label: t("catalog.features.fields.ui.fieldListPage.reference") },
];

const statusOptions = [
  { label: t("catalog.features.fields.ui.fieldListPage.draft"), value: "draft" },
  { label: t("catalog.features.fields.ui.fieldListPage.active"), value: "active" },
  { label: t("catalog.features.fields.ui.fieldListPage.deprecated"), value: "deprecated" },
  { label: t("catalog.features.fields.ui.fieldListPage.archived"), value: "archived" },
];
const ALL_VALUE_TYPES = "__all__";
const ALL_FLAGS = "__all__";
const booleanOptions = [
  { label: t("catalog.support.shellSupport.ui.entityListPage.all"), value: ALL_FLAGS },
  { label: t("catalog.support.shellSupport.ui.entityListPage.yes"), value: "true" },
  { label: t("catalog.support.shellSupport.ui.entityListPage.no"), value: "false" },
];
const lifecycleActions = [
  { value: "activate", label: t("catalog.features.fields.ui.fieldDetailPage.activate") },
  { value: "deprecate", label: t("catalog.features.fields.ui.fieldDetailPage.deprecate") },
  { value: "archive", label: t("catalog.features.fields.ui.fieldDetailPage.archive") },
];

export function FieldListPage({ data, query }: CatalogListRouteData<Field>) {
  const listControls = useCatalogListQueryControls(query);
  const revalidator = useRevalidator();
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [valueType, setValueType] = useState("string");
  const [filterable, setFilterable] = useState(false);
  const [searchable, setSearchable] = useState(false);
  const [sortable, setSortable] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  async function handleCreate() {
    const fieldId = createId("fld");
    await createField({
      fieldId,
      key,
      name: localizedTextMapFromEnglish(name),
      description: localizedTextMapFromEnglish(description),
      valueType,
      behavior: { filterable, searchable, sortable },
    });
    addToast(t("catalog.features.fields.ui.fieldListPage.field.created"), "success");
    setShowCreate(false);
    setKey("");
    setName("");
    setDescription("");
    setValueType("string");
    setFilterable(false);
    setSearchable(false);
    setSortable(false);
    revalidator.revalidate();
  }

  return (
    <>
      <EntityListPage
        title={t("catalog.features.fields.ui.fieldListPage.fields")}
        entityName="field"
        items={data.items}
        total={data.total}
        loading={listControls.loading}
        error={null}
        columns={columns}
        getRowId={(row) => row.field_id}
        getHref={(row) => `/fields/${row.field_id}`}
        search={listControls.search}
        onSearchChange={listControls.setSearch}
        statusFilter={listControls.status}
        onStatusFilterChange={listControls.setStatus}
        statusOptions={statusOptions}
        extraFilters={
          <>
            <Select
              label={t("catalog.features.fields.ui.fieldListPage.value.type")}
              value={listControls.valueType || ALL_VALUE_TYPES}
              onValueChange={(value) => listControls.setValueType(value === ALL_VALUE_TYPES ? "" : value)}
              items={[
                { label: t("catalog.support.shellSupport.ui.entityListPage.all.value.types"), value: ALL_VALUE_TYPES },
                ...valueTypeOptions,
              ]}
            />
            <Select
              label={t("catalog.features.fields.ui.fieldListPage.filterable")}
              value={listControls.filterable || ALL_FLAGS}
              onValueChange={(value) => listControls.setFilterable(value === ALL_FLAGS ? "" : value)}
              items={booleanOptions}
            />
            <Select
              label={t("catalog.features.fields.ui.fieldListPage.searchable")}
              value={listControls.searchable || ALL_FLAGS}
              onValueChange={(value) => listControls.setSearchable(value === ALL_FLAGS ? "" : value)}
              items={booleanOptions}
            />
            <Select
              label={t("catalog.features.fields.ui.fieldListPage.sortable")}
              value={listControls.sortable || ALL_FLAGS}
              onValueChange={(value) => listControls.setSortable(value === ALL_FLAGS ? "" : value)}
              items={booleanOptions}
            />
          </>
        }
        selectedKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
        bulkActionBar={
          <BulkLifecycleActionBar
            entityName="Fields"
            selectedKeys={selectedKeys}
            filterSelection={{ mode: "filter", query }}
            filterCount={data.total}
            actions={lifecycleActions}
            clearSelection={() => setSelectedKeys(new Set())}
            preview={previewBulkFieldLifecycle}
            confirm={confirmBulkFieldLifecycle}
            onCompleted={revalidator.revalidate}
          />
        }
        page={listControls.page}
        pageSize={listControls.pageSize}
        onPageChange={listControls.setPage}
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
