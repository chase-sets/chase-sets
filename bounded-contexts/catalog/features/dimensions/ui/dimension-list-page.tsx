import { localizedTextMapFromEnglish, t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { useState } from "react";
import { useRevalidator } from "react-router";
import { Button, Dialog, Select, Stack, StatusPill, TextInput, type DataColumn } from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityListPage } from "../../../support/shell-support/ui/entity-list-page";
import { BulkLifecycleActionBar } from "../../../support/shell-support/ui/bulk-lifecycle-actions";
import {
  type CatalogListRouteData,
  useCatalogListQueryControls,
} from "../../../support/shell-support/list-query-state";
import { confirmBulkDimensionLifecycle, createDimension, previewBulkDimensionLifecycle } from "./use-dimensions";
import type { Dimension } from "./contracts";

const columns: DataColumn<Dimension>[] = [
  { key: "key", header: t("catalog.features.dimensions.ui.dimensionListPage.key"), cell: (row) => row.key },
  { key: "name", header: t("catalog.features.dimensions.ui.dimensionListPage.name"), cell: (row) => row.name },
  {
    key: "value_kind",
    header: t("catalog.features.dimensions.ui.dimensionListPage.value.kind"),
    cell: (row) => row.value_kind,
  },
  {
    key: "status",
    header: t("catalog.features.dimensions.ui.dimensionListPage.status"),
    cell: (row) => <StatusPill>{row.status}</StatusPill>,
  },
];

const statusOptions = [
  { label: t("catalog.features.dimensions.ui.dimensionListPage.draft"), value: "draft" },
  { label: t("catalog.features.dimensions.ui.dimensionListPage.active"), value: "active" },
  { label: t("catalog.features.dimensions.ui.dimensionListPage.deprecated"), value: "deprecated" },
  { label: t("catalog.features.dimensions.ui.dimensionListPage.archived"), value: "archived" },
];

const valueKindOptions = [
  { label: t("catalog.features.dimensions.ui.dimensionListPage.unordered"), value: "unordered" },
  { label: t("catalog.features.dimensions.ui.dimensionListPage.ordered"), value: "ordered" },
  { label: t("catalog.features.dimensions.ui.dimensionListPage.numeric"), value: "numeric" },
];
const ALL_VALUE_KINDS = "__all__";
const lifecycleActions = [
  { value: "activate", label: t("catalog.features.dimensions.ui.dimensionDetailPage.activate") },
  { value: "deprecate", label: t("catalog.features.dimensions.ui.dimensionDetailPage.deprecate") },
  { value: "archive", label: t("catalog.features.dimensions.ui.dimensionDetailPage.archive") },
];

export function DimensionListPage({ data, query }: CatalogListRouteData<Dimension>) {
  const listControls = useCatalogListQueryControls(query);
  const revalidator = useRevalidator();
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [valueKind, setValueKind] = useState("unordered");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  async function handleCreate() {
    const dimensionId = createId("dim");
    await createDimension({
      dimensionId,
      key,
      name: localizedTextMapFromEnglish(name),
      description: localizedTextMapFromEnglish(description),
      valueKind,
    });
    addToast(t("catalog.features.dimensions.ui.dimensionListPage.dimension.created"), "success");
    setShowCreate(false);
    setKey("");
    setName("");
    setDescription("");
    setValueKind("unordered");
    revalidator.revalidate();
  }

  return (
    <>
      <EntityListPage
        title={t("catalog.features.dimensions.ui.dimensionListPage.dimensions")}
        entityName="dimension"
        items={data.items}
        total={data.total}
        loading={listControls.loading}
        error={null}
        columns={columns}
        getRowId={(row) => row.dimension_id}
        getHref={(row) => `/dimensions/${row.dimension_id}`}
        search={listControls.search}
        onSearchChange={listControls.setSearch}
        statusFilter={listControls.status}
        onStatusFilterChange={listControls.setStatus}
        statusOptions={statusOptions}
        extraFilters={
          <Select
            label={t("catalog.features.dimensions.ui.dimensionListPage.value.kind.2")}
            value={listControls.valueKind || ALL_VALUE_KINDS}
            onValueChange={(value) => listControls.setValueKind(value === ALL_VALUE_KINDS ? "" : value)}
            items={[
              { label: t("catalog.support.shellSupport.ui.entityListPage.all.value.kinds"), value: ALL_VALUE_KINDS },
              ...valueKindOptions,
            ]}
          />
        }
        selectedKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
        bulkActionBar={
          <BulkLifecycleActionBar
            entityName="Dimensions"
            selectedKeys={selectedKeys}
            filterSelection={{ mode: "filter", query }}
            filterCount={data.total}
            actions={lifecycleActions}
            clearSelection={() => setSelectedKeys(new Set())}
            preview={previewBulkDimensionLifecycle}
            confirm={confirmBulkDimensionLifecycle}
            onCompleted={revalidator.revalidate}
          />
        }
        page={listControls.page}
        pageSize={listControls.pageSize}
        onPageChange={listControls.setPage}
        createButton={
          <Button onClick={() => setShowCreate(true)}>
            {t("catalog.features.dimensions.ui.dimensionListPage.new.dimension")}
          </Button>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title={t("catalog.features.dimensions.ui.dimensionListPage.create.dimension")}
        footer={<Button onClick={handleCreate}>{t("catalog.features.dimensions.ui.dimensionListPage.create")}</Button>}
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.dimensions.ui.dimensionListPage.key.2")}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <TextInput
            label={t("catalog.features.dimensions.ui.dimensionListPage.name.2")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <TextInput
            label={t("catalog.features.dimensions.ui.dimensionListPage.description")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <Select
            label={t("catalog.features.dimensions.ui.dimensionListPage.value.kind.2")}
            items={valueKindOptions}
            value={valueKind}
            onValueChange={setValueKind}
          />
        </Stack>
      </Dialog>
    </>
  );
}
