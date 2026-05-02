import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { useState, useMemo } from "react";
import {
  Button,
  Dialog,
  Select,
  Stack,
  StatusPill,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityListPage } from "../../../support/shell-support/ui/entity-list-page";
import { useDimensionList, createDimension } from "./use-dimensions";
import type { Dimension } from "./contracts";

const columns: DataColumn<Dimension>[] = [
  { key: "key", header: t("catalog.features.dimensions.ui.dimensionListPage.key"), cell: (row) => row.key },
  { key: "name", header: t("catalog.features.dimensions.ui.dimensionListPage.name"), cell: (row) => row.name },
  { key: "value_kind", header: t("catalog.features.dimensions.ui.dimensionListPage.value.kind"), cell: (row) => row.value_kind },
  { key: "status", header: t("catalog.features.dimensions.ui.dimensionListPage.status"), cell: (row) => <StatusPill>{row.status}</StatusPill> },
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

export function DimensionListPage({ initialData }: { initialData?: Parameters<typeof useDimensionList>[1] }) {
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

  const { data, loading, error, refresh } = useDimensionList(query, initialData);
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [valueKind, setValueKind] = useState("unordered");

  async function handleCreate() {
    const dimensionId = createId("dim");
    await createDimension({ dimensionId, key, name, description: description || undefined, valueKind });
    addToast(t("catalog.features.dimensions.ui.dimensionListPage.dimension.created"), "success");
    setShowCreate(false);
    setKey("");
    setName("");
    setDescription("");
    setValueKind("unordered");
    refresh();
  }

  return (
    <>
      <EntityListPage
        title={t("catalog.features.dimensions.ui.dimensionListPage.dimensions")}
        entityName="dimension"
        items={data?.items ?? null}
        total={data?.total}
        loading={loading}
        error={error}
        columns={columns}
        getRowId={(row) => row.dimension_id}
        getHref={(row) => `/dimensions/${row.dimension_id}`}
        search={search}
        onSearchChange={(v) => { setSearch(v); setPage(0); }}
        statusFilter={statusFilter}
        onStatusFilterChange={(v) => { setStatusFilter(v); setPage(0); }}
        statusOptions={statusOptions}
        page={page}
        pageSize={50}
        onPageChange={setPage}
        createButton={
          <Button onClick={() => setShowCreate(true)}>{t("catalog.features.dimensions.ui.dimensionListPage.new.dimension")}</Button>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title={t("catalog.features.dimensions.ui.dimensionListPage.create.dimension")}
        footer={<Button onClick={handleCreate}>{t("catalog.features.dimensions.ui.dimensionListPage.create")}</Button>}
      >
        <Stack gap={3}>
          <TextInput label={t("catalog.features.dimensions.ui.dimensionListPage.key.2")} value={key} onChange={(e) => setKey(e.target.value)} />
          <TextInput label={t("catalog.features.dimensions.ui.dimensionListPage.name.2")} value={name} onChange={(e) => setName(e.target.value)} />
          <TextInput label={t("catalog.features.dimensions.ui.dimensionListPage.description")} value={description} onChange={(e) => setDescription(e.target.value)} />
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




