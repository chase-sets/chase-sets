import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { useState, useMemo } from "react";
import {
  Button,
  Dialog,
  Stack,
  StatusPill,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityListPage } from "../../../support/shell-support/ui/entity-list-page";
import { useBlueprintList, createBlueprint } from "./use-blueprints";
import type { Blueprint } from "./contracts";

const columns: DataColumn<Blueprint>[] = [
  { key: "key", header: t("catalog.features.blueprints.ui.blueprintListPage.key"), cell: (row) => row.key },
  { key: "name", header: t("catalog.features.blueprints.ui.blueprintListPage.name"), cell: (row) => row.name },
  { key: "status", header: t("catalog.features.blueprints.ui.blueprintListPage.status"), cell: (row) => <StatusPill>{row.status}</StatusPill> },
];

const statusOptions = [
  { label: t("catalog.features.blueprints.ui.blueprintListPage.draft"), value: "draft" },
  { label: t("catalog.features.blueprints.ui.blueprintListPage.active"), value: "active" },
  { label: t("catalog.features.blueprints.ui.blueprintListPage.deprecated"), value: "deprecated" },
  { label: t("catalog.features.blueprints.ui.blueprintListPage.archived"), value: "archived" },
];

export function BlueprintListPage({ initialData }: { initialData?: Parameters<typeof useBlueprintList>[1] }) {
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

  const { data, loading, error, refresh } = useBlueprintList(query, initialData);
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  async function handleCreate() {
    const blueprintId = createId("bpr");
    await createBlueprint({ blueprintId, key, name, description: description || undefined });
    addToast(t("catalog.features.blueprints.ui.blueprintListPage.blueprint.created"), "success");
    setShowCreate(false);
    setKey("");
    setName("");
    setDescription("");
    refresh();
  }

  return (
    <>
      <EntityListPage
        title={t("catalog.features.blueprints.ui.blueprintListPage.blueprints")}
        entityName="blueprint"
        items={data?.items ?? null}
        total={data?.total}
        loading={loading}
        error={error}
        columns={columns}
        getRowId={(row) => row.blueprint_id}
        getHref={(row) => `/blueprints/${row.blueprint_id}`}
        search={search}
        onSearchChange={(v) => { setSearch(v); setPage(0); }}
        statusFilter={statusFilter}
        onStatusFilterChange={(v) => { setStatusFilter(v); setPage(0); }}
        statusOptions={statusOptions}
        page={page}
        pageSize={50}
        onPageChange={setPage}
        createButton={
          <Button onClick={() => setShowCreate(true)}>{t("catalog.features.blueprints.ui.blueprintListPage.new.blueprint")}</Button>
        }
      />
      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title={t("catalog.features.blueprints.ui.blueprintListPage.create.blueprint")}
        footer={<Button onClick={handleCreate}>{t("catalog.features.blueprints.ui.blueprintListPage.create")}</Button>}
      >
        <Stack gap={3}>
          <TextInput label={t("catalog.features.blueprints.ui.blueprintListPage.key.2")} value={key} onChange={(e) => setKey(e.target.value)} />
          <TextInput label={t("catalog.features.blueprints.ui.blueprintListPage.name.2")} value={name} onChange={(e) => setName(e.target.value)} />
          <TextInput label={t("catalog.features.blueprints.ui.blueprintListPage.description")} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Stack>
      </Dialog>
    </>
  );
}





